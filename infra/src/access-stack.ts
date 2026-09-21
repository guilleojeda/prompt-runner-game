import * as cdk from 'aws-cdk-lib';
import { aws_iam as iam } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  APPLICATION_ACCOUNT,
  APPLICATION_REGION,
  ASSET_DEPLOYMENT_ROLE_NAME,
  GITHUB_DEPLOY_ROLE_NAME,
  websiteBucketNameFor,
} from './stack.js';
import {
  DRAFT_LAMBDA_NAME,
  DRAFT_LAMBDA_ROLE_NAME,
  DRAFT_LOG_GROUP_NAME,
  DRAFT_TABLE_NAME,
} from './robot.js';

export const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';
export const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com';
export const GITHUB_MAIN_SUBJECT =
  'repo:guilleojeda@18320860/prompt-runner-game@1373331195:ref:refs/heads/main';
export const BOOTSTRAP_CFN_EXECUTION_ROLE_NAME = 'cdk-hnb659fds-cfn-exec-role';

export interface PromptRunnerAccessStackProps extends cdk.StackProps {
  /** ARN of the provider already registered in the account, when one exists. */
  readonly githubOidcProviderArn?: string;
}

/** One-time access setup; deploy this stack with operator credentials before main can deploy hosting. */
export class PromptRunnerAccessStack extends cdk.Stack {
  public readonly githubActionsRole: iam.Role;

  public constructor(scope: Construct, id: string, props: PromptRunnerAccessStackProps = {}) {
    super(scope, id, {
      ...props,
      synthesizer: new cdk.BootstraplessSynthesizer(),
    });

    const account = props.env?.account ?? APPLICATION_ACCOUNT;
    const region = props.env?.region ?? APPLICATION_REGION;
    let githubProviderArn: string;
    if (props.githubOidcProviderArn) {
      githubProviderArn = props.githubOidcProviderArn;
    } else {
      const githubProvider = new iam.CfnOIDCProvider(this, 'GitHubOidcProvider', {
        url: GITHUB_OIDC_URL,
        clientIdList: [GITHUB_OIDC_AUDIENCE],
        thumbprintList: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
      });
      githubProviderArn = githubProvider.ref;
    }

    const assetDeploymentRole = new iam.Role(this, 'AssetDeploymentRole', {
      roleName: ASSET_DEPLOYMENT_ROLE_NAME,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Fixed phase 0 role for the CDK frontend asset deployment helper.',
    });
    const websiteBucketArn = `arn:${cdk.Aws.PARTITION}:s3:::${websiteBucketNameFor(account)}`;
    const bootstrapAssetsBucketArn = `arn:${cdk.Aws.PARTITION}:s3:::cdk-hnb659fds-assets-${account}-${region}`;
    const cognitoUserPoolArn = `arn:${cdk.Aws.PARTITION}:cognito-idp:${region}:${account}:userpool/*`;

    assetDeploymentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadCdkAssets',
        actions: ['s3:GetObject'],
        resources: [`${bootstrapAssetsBucketArn}/*`],
      }),
    );
    assetDeploymentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PublishWebsiteAssets',
        actions: ['s3:GetBucketLocation', 's3:ListBucket'],
        resources: [websiteBucketArn],
      }),
    );
    assetDeploymentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PublishWebsiteObjects',
        actions: ['s3:DeleteObject', 's3:GetObject', 's3:PutObject'],
        resources: [`${websiteBucketArn}/*`],
      }),
    );
    assetDeploymentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvalidateWebsite',
        actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
        resources: [`arn:${cdk.Aws.PARTITION}:cloudfront::${account}:distribution/*`],
        conditions: { StringEquals: { 'aws:ResourceTag/Application': 'prompt-runner-game' } },
      }),
    );
    assetDeploymentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CreateDeploymentLogGroup',
        actions: ['logs:CreateLogGroup'],
        resources: [
          `arn:${cdk.Aws.PARTITION}:logs:${region}:${account}:log-group:/aws/lambda/PromptRunnerHosting-*`,
        ],
      }),
    );
    assetDeploymentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteDeploymentLogEvents',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [
          `arn:${cdk.Aws.PARTITION}:logs:${region}:${account}:log-group:/aws/lambda/PromptRunnerHosting-*:*`,
        ],
      }),
    );

    const phase0CfnExecutionPolicy = new iam.ManagedPolicy(this, 'Phase0CfnExecutionPolicy', {
      managedPolicyName: 'prompt-runner-game-phase0-cfn-execution',
      // IAM ManagedPolicy.Description is Replacement; preserve the deployed value while
      // extending this same physical policy for the next CloudFormation cycle.
      description: 'Phase 0 CloudFormation execution permissions for hosting only.',
      statements: [
        new iam.PolicyStatement({
          sid: 'ReadBootstrapVersion',
          actions: ['ssm:GetParameters'],
          resources: [
            `arn:${cdk.Aws.PARTITION}:ssm:${region}:${account}:parameter/cdk-bootstrap/hnb659fds/version`,
          ],
        }),
        new iam.PolicyStatement({
          sid: 'HostingBucket',
          actions: [
            's3:CreateBucket',
            's3:DeleteBucket',
            // CloudFormation reads the full bucket model, including unset optional settings.
            's3:Get*',
            's3:ListBucket',
            's3:ListTagsForResource',
            's3:TagResource',
            's3:UntagResource',
            's3:PutBucketPolicy',
            's3:PutBucketPublicAccessBlock',
            's3:PutBucketTagging',
            's3:PutBucketVersioning',
            's3:PutBucketOwnershipControls',
            's3:PutEncryptionConfiguration',
            's3:DeleteBucketPolicy',
          ],
          resources: [websiteBucketArn],
        }),
        new iam.PolicyStatement({
          sid: 'ReadBootstrapAssets',
          actions: ['s3:GetBucketLocation', 's3:GetObject', 's3:GetObjectVersion', 's3:ListBucket'],
          resources: [bootstrapAssetsBucketArn, `${bootstrapAssetsBucketArn}/*`],
        }),
        new iam.PolicyStatement({
          // CloudFormation cannot know the user-pool ARN until Cognito creates it.
          // The request tag narrows this account-level create permission to this app.
          sid: 'CognitoCreateUserPool',
          actions: ['cognito-idp:CreateUserPool'],
          resources: ['*'],
          conditions: {
            StringEquals: {
              'aws:RequestTag/Application': 'prompt-runner-game',
              'aws:RequestedRegion': region,
            },
          },
        }),
        new iam.PolicyStatement({
          // ListUserPools is an account-level CloudFormation handler operation.
          sid: 'CognitoListUserPools',
          actions: ['cognito-idp:ListUserPools'],
          resources: ['*'],
          conditions: { StringEquals: { 'aws:RequestedRegion': region } },
        }),
        new iam.PolicyStatement({
          // UserPool is the only taggable Cognito resource in this phase.
          sid: 'CognitoUserPoolTagsOnCreate',
          actions: ['cognito-idp:TagResource'],
          resources: [cognitoUserPoolArn],
          conditions: {
            StringEquals: { 'aws:RequestTag/Application': 'prompt-runner-game' },
          },
        }),
        new iam.PolicyStatement({
          // These resources share the same user-pool ARN and application-tag boundary.
          sid: 'CognitoManagedResources',
          actions: [
            'cognito-idp:DescribeUserPool',
            'cognito-idp:DeleteUserPool',
            'cognito-idp:GetUserPoolMfaConfig',
            'cognito-idp:UpdateUserPool',
            'cognito-idp:ListTagsForResource',
            'cognito-idp:TagResource',
            'cognito-idp:UntagResource',
            'cognito-idp:CreateUserPoolClient',
            'cognito-idp:DescribeUserPoolClient',
            'cognito-idp:DeleteUserPoolClient',
            'cognito-idp:UpdateUserPoolClient',
            'cognito-idp:ListUserPoolClients',
            'cognito-idp:CreateUserPoolDomain',
            'cognito-idp:DeleteUserPoolDomain',
            'cognito-idp:UpdateUserPoolDomain',
            'cognito-idp:CreateManagedLoginBranding',
            'cognito-idp:DescribeManagedLoginBranding',
            'cognito-idp:DescribeManagedLoginBrandingByClient',
            'cognito-idp:DeleteManagedLoginBranding',
            'cognito-idp:UpdateManagedLoginBranding',
          ],
          resources: [cognitoUserPoolArn],
          conditions: { StringEquals: { 'aws:ResourceTag/Application': 'prompt-runner-game' } },
        }),
        new iam.PolicyStatement({
          // DescribeUserPoolDomain has no IAM resource type in the service authorization table.
          // Limit its required account-level read to the hosting region.
          sid: 'CognitoDescribeUserPoolDomain',
          actions: ['cognito-idp:DescribeUserPoolDomain'],
          resources: ['*'],
          conditions: { StringEquals: { 'aws:RequestedRegion': region } },
        }),
        new iam.PolicyStatement({
          sid: 'CloudFrontCreateDistribution',
          actions: ['cloudfront:CreateDistribution'],
          resources: ['*'],
          conditions: { StringEquals: { 'aws:RequestTag/Application': 'prompt-runner-game' } },
        }),
        new iam.PolicyStatement({
          // This project owns the account. Initial tagging cannot require an existing resource tag.
          sid: 'TagHostingDistribution',
          actions: ['cloudfront:TagResource'],
          resources: [`arn:${cdk.Aws.PARTITION}:cloudfront::${account}:distribution/*`],
          conditions: { StringEquals: { 'aws:RequestTag/Application': 'prompt-runner-game' } },
        }),
        new iam.PolicyStatement({
          sid: 'CloudFrontDistribution',
          actions: [
            'cloudfront:CreateInvalidation',
            'cloudfront:DeleteDistribution',
            'cloudfront:GetDistribution',
            'cloudfront:GetDistributionConfig',
            'cloudfront:GetInvalidation',
            'cloudfront:ListTagsForResource',
            'cloudfront:TagResource',
            'cloudfront:UntagResource',
            'cloudfront:UpdateDistribution',
          ],
          resources: [`arn:${cdk.Aws.PARTITION}:cloudfront::${account}:distribution/*`],
          conditions: { StringEquals: { 'aws:ResourceTag/Application': 'prompt-runner-game' } },
        }),
        new iam.PolicyStatement({
          sid: 'CloudFrontCreateCachePolicy',
          actions: ['cloudfront:CreateCachePolicy'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'CloudFrontCachePolicies',
          actions: [
            'cloudfront:DeleteCachePolicy',
            'cloudfront:GetCachePolicy',
            'cloudfront:UpdateCachePolicy',
          ],
          resources: [`arn:${cdk.Aws.PARTITION}:cloudfront::${account}:cache-policy/*`],
        }),
        new iam.PolicyStatement({
          sid: 'CloudFrontCreateOriginAccessControl',
          actions: ['cloudfront:CreateOriginAccessControl'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'CloudFrontOriginAccessControls',
          actions: [
            'cloudfront:DeleteOriginAccessControl',
            'cloudfront:GetOriginAccessControl',
            'cloudfront:UpdateOriginAccessControl',
          ],
          resources: [`arn:${cdk.Aws.PARTITION}:cloudfront::${account}:origin-access-control/*`],
        }),
        new iam.PolicyStatement({
          sid: 'DeploymentHelperFunction',
          actions: [
            'lambda:CreateFunction',
            'lambda:DeleteFunction',
            // Provider read callbacks also inspect runtime, recursion and signing settings.
            'lambda:Get*',
            'lambda:InvokeFunction',
            'lambda:ListTags',
            'lambda:PublishVersion',
            'lambda:TagResource',
            'lambda:UntagResource',
            'lambda:UpdateFunctionCode',
            'lambda:UpdateFunctionConfiguration',
          ],
          resources: [
            `arn:${cdk.Aws.PARTITION}:lambda:${region}:${account}:function:PromptRunnerHosting-*`,
          ],
        }),
        new iam.PolicyStatement({
          sid: 'ReadFixedDeploymentRole',
          actions: ['iam:GetRole'],
          resources: [assetDeploymentRole.roleArn],
        }),
        new iam.PolicyStatement({
          sid: 'PassFixedDeploymentRole',
          actions: ['iam:PassRole'],
          resources: [assetDeploymentRole.roleArn],
          conditions: { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } },
        }),
        new iam.PolicyStatement({
          sid: 'DeploymentLogs',
          actions: ['logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:PutRetentionPolicy'],
          resources: [
            `arn:${cdk.Aws.PARTITION}:logs:${region}:${account}:log-group:/aws/lambda/PromptRunnerHosting-*`,
          ],
        }),
        new iam.PolicyStatement({
          sid: 'DeploymentLayers',
          actions: [
            'lambda:DeleteLayerVersion',
            'lambda:GetLayerVersion',
            'lambda:PublishLayerVersion',
          ],
          resources: [
            // CloudFormation uses these logical-ID prefixes as layer names, without the stack name.
            `arn:${cdk.Aws.PARTITION}:lambda:${region}:${account}:layer:WebsiteAssetsDeploymentAwsCliLayer*`,
            `arn:${cdk.Aws.PARTITION}:lambda:${region}:${account}:layer:WebsiteEntryDeploymentAwsCliLayer*`,
          ],
        }),
      ],
    });

    // The deployed phase 0 policy is already close to IAM's 6,144-character
    // document limit. Keep its physical ARN and historical description intact;
    // phase 2 CloudFormation permissions live in a separately attached policy
    // on the same bootstrap execution role.
    const bootstrapExecutionRole = iam.Role.fromRoleName(
      this,
      'BootstrapCfnExecutionRole',
      `${BOOTSTRAP_CFN_EXECUTION_ROLE_NAME}-${account}-${region}`,
      { mutable: false },
    );
    const apiGatewayArn = `arn:${cdk.Aws.PARTITION}:apigateway:${region}::/apis`;
    const apiGatewayApiArn = `${apiGatewayArn}/*`;
    const apiGatewayStagesCollectionArn = `${apiGatewayArn}/*/stages`;
    const apiGatewayStageArn = `${apiGatewayArn}/*/stages/*`;
    const apiGatewayRoutesCollectionArn = `${apiGatewayArn}/*/routes`;
    const apiGatewayRouteArn = `${apiGatewayArn}/*/routes/*`;
    const apiGatewayIntegrationsCollectionArn = `${apiGatewayArn}/*/integrations`;
    const apiGatewayIntegrationArn = `${apiGatewayArn}/*/integrations/*`;
    const apiGatewayAuthorizersCollectionArn = `${apiGatewayArn}/*/authorizers`;
    const apiGatewayAuthorizerArn = `${apiGatewayArn}/*/authorizers/*`;
    const draftTableArn = `arn:${cdk.Aws.PARTITION}:dynamodb:${region}:${account}:table/${DRAFT_TABLE_NAME}`;
    const draftFunctionArn = `arn:${cdk.Aws.PARTITION}:lambda:${region}:${account}:function:${DRAFT_LAMBDA_NAME}`;
    const draftFunctionVersionArn = `${draftFunctionArn}:*`;
    const draftRoleArn = `arn:${cdk.Aws.PARTITION}:iam::${account}:role/${DRAFT_LAMBDA_ROLE_NAME}`;
    const draftLogGroupArn = `arn:${cdk.Aws.PARTITION}:logs:${region}:${account}:log-group:${DRAFT_LOG_GROUP_NAME}`;
    const draftLogGroupWithStreamsArn = `${draftLogGroupArn}:*`;

    new iam.ManagedPolicy(this, 'RobotCfnExecutionPolicy', {
      managedPolicyName: 'prompt-runner-game-robot-cfn-execution',
      description: 'CloudFormation permissions for the prompt-runner-game robot API.',
      roles: [bootstrapExecutionRole],
      statements: [
        new iam.PolicyStatement({
          sid: 'DraftTableLifecycle',
          actions: [
            'dynamodb:CreateTable',
            'dynamodb:DeleteTable',
            'dynamodb:DescribeContinuousBackups',
            'dynamodb:DescribeContributorInsights',
            'dynamodb:DescribeKinesisStreamingDestination',
            'dynamodb:DescribeTable',
            'dynamodb:DescribeTimeToLive',
            'dynamodb:GetResourcePolicy',
            'dynamodb:ListTagsOfResource',
            'dynamodb:TagResource',
            'dynamodb:UntagResource',
            'dynamodb:UpdateTable',
          ],
          resources: [draftTableArn],
        }),
        new iam.PolicyStatement({
          sid: 'DraftFunctionLifecycle',
          actions: [
            'lambda:AddPermission',
            'lambda:CreateFunction',
            'lambda:DeleteFunction',
            // The CloudFormation Lambda read handler inspects optional runtime,
            // recursion, code-signing, and concurrency settings as well.
            'lambda:Get*',
            'lambda:ListTags',
            'lambda:RemovePermission',
            'lambda:TagResource',
            'lambda:UntagResource',
            'lambda:UpdateFunctionCode',
            'lambda:UpdateFunctionConfiguration',
          ],
          resources: [draftFunctionArn, draftFunctionVersionArn],
        }),
        new iam.PolicyStatement({
          sid: 'DraftLambdaRoleLifecycle',
          actions: [
            'iam:CreateRole',
            'iam:DeleteRole',
            'iam:GetRole',
            'iam:GetRolePolicy',
            'iam:ListRolePolicies',
            'iam:PutRolePolicy',
            'iam:DeleteRolePolicy',
            'iam:TagRole',
            'iam:UntagRole',
            'iam:UpdateAssumeRolePolicy',
          ],
          resources: [draftRoleArn],
        }),
        new iam.PolicyStatement({
          sid: 'PassDraftLambdaRole',
          actions: ['iam:PassRole'],
          resources: [draftRoleArn],
          conditions: { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } },
        }),
        new iam.PolicyStatement({
          sid: 'DraftApiLogs',
          actions: [
            'logs:CreateLogGroup',
            'logs:DeleteLogGroup',
            'logs:DeleteRetentionPolicy',
            'logs:PutRetentionPolicy',
          ],
          resources: [draftLogGroupWithStreamsArn],
        }),
        new iam.PolicyStatement({
          sid: 'TagDraftApiLogGroup',
          actions: ['logs:TagResource', 'logs:UntagResource'],
          resources: [draftLogGroupArn],
        }),
        new iam.PolicyStatement({
          // These CloudWatch Logs reads do not support a resource ARN.
          // Keep them account-level but limited to the deployment region.
          sid: 'ReadDraftApiLogGroups',
          actions: [
            'logs:DescribeLogGroups',
            'logs:DescribeIndexPolicies',
            'logs:DescribeResourcePolicies',
          ],
          resources: ['*'],
          conditions: { StringEquals: { 'aws:RequestedRegion': region } },
        }),
        new iam.PolicyStatement({
          sid: 'ReadDraftApiLogGroupDetails',
          actions: ['logs:GetDataProtectionPolicy'],
          resources: [draftLogGroupWithStreamsArn],
        }),
        new iam.PolicyStatement({
          sid: 'ListDraftApiLogGroupTags',
          actions: ['logs:ListTagsForResource'],
          resources: [draftLogGroupArn],
        }),
        new iam.PolicyStatement({
          sid: 'DraftHttpApi',
          actions: [
            'apigateway:DELETE',
            'apigateway:GET',
            'apigateway:PATCH',
            'apigateway:POST',
            'apigateway:PUT',
          ],
          resources: [
            apiGatewayArn,
            apiGatewayApiArn,
            apiGatewayStagesCollectionArn,
            apiGatewayStageArn,
            apiGatewayRoutesCollectionArn,
            apiGatewayRouteArn,
            apiGatewayIntegrationsCollectionArn,
            apiGatewayIntegrationArn,
            apiGatewayAuthorizersCollectionArn,
            apiGatewayAuthorizerArn,
          ],
        }),
        new iam.PolicyStatement({
          // The CloudFormation Stage handler uses the API Gateway v2 tagging
          // operations directly on create/update. Keep those permissions on
          // this API's stage collection and stage resources only.
          sid: 'TagDraftApiStages',
          actions: ['apigateway:TagResource', 'apigateway:UntagResource'],
          resources: [apiGatewayStagesCollectionArn, apiGatewayStageArn],
        }),
        new iam.PolicyStatement({
          sid: 'CognitoRobotResourceServer',
          actions: [
            'cognito-idp:CreateResourceServer',
            'cognito-idp:DeleteResourceServer',
            'cognito-idp:DescribeResourceServer',
            'cognito-idp:ListResourceServers',
            'cognito-idp:UpdateResourceServer',
          ],
          resources: [cognitoUserPoolArn],
          conditions: { StringEquals: { 'aws:ResourceTag/Application': 'prompt-runner-game' } },
        }),
      ],
    });

    this.githubActionsRole = new iam.Role(this, 'GitHubActionsDeployRole', {
      roleName: GITHUB_DEPLOY_ROLE_NAME,
      assumedBy: new iam.FederatedPrincipal(
        githubProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': GITHUB_OIDC_AUDIENCE,
            'token.actions.githubusercontent.com:sub': GITHUB_MAIN_SUBJECT,
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      description: 'Phase 0 GitHub Actions role for the prompt-runner-game main branch.',
      maxSessionDuration: cdk.Duration.hours(1),
    });

    const bootstrapRoleArn = (roleName: string) =>
      `arn:${cdk.Aws.PARTITION}:iam::${account}:role/${roleName}`;
    this.githubActionsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumePhase0CdkBootstrapRoles',
        effect: iam.Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: [
          bootstrapRoleArn(`cdk-hnb659fds-deploy-role-${account}-${region}`),
          bootstrapRoleArn(`cdk-hnb659fds-file-publishing-role-${account}-${region}`),
        ],
      }),
    );

    new cdk.CfnOutput(this, 'GitHubActionsRoleArn', {
      description: 'OIDC role assumed by the main deployment workflow.',
      value: this.githubActionsRole.roleArn,
    });
    new cdk.CfnOutput(this, 'GitHubOidcProviderArn', {
      description: 'OIDC provider used by GitHub Actions.',
      value: githubProviderArn,
    });
    new cdk.CfnOutput(this, 'AssetDeploymentRoleArn', {
      description: 'Fixed role used by the CDK website asset deployment helper.',
      value: assetDeploymentRole.roleArn,
    });
    new cdk.CfnOutput(this, 'Phase0CfnExecutionPolicyArn', {
      description: 'Customer-managed policy to pass to CDK bootstrap for phase 0.',
      value: phase0CfnExecutionPolicy.managedPolicyArn,
    });
  }
}
