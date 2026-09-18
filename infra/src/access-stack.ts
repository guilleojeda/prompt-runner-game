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

export const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';
export const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com';
export const GITHUB_MAIN_SUBJECT =
  'repo:guilleojeda@18320860/prompt-runner-game@1373331195:ref:refs/heads/main';

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
      description: 'Phase 0 CloudFormation execution permissions for hosting only.',
      statements: [
        new iam.PolicyStatement({
          sid: 'HostingBucket',
          actions: [
            's3:CreateBucket',
            's3:DeleteBucket',
            's3:GetBucketLocation',
            's3:GetBucketPolicy',
            's3:GetBucketOwnershipControls',
            's3:GetBucketPublicAccessBlock',
            's3:GetBucketTagging',
            's3:GetEncryptionConfiguration',
            's3:GetBucketVersioning',
            's3:ListBucket',
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
          sid: 'CloudFrontCreateDistribution',
          actions: ['cloudfront:CreateDistribution'],
          resources: ['*'],
          conditions: { StringEquals: { 'aws:RequestTag/Application': 'prompt-runner-game' } },
        }),
        new iam.PolicyStatement({
          sid: 'CloudFrontDistribution',
          actions: [
            'cloudfront:CreateInvalidation',
            'cloudfront:DeleteDistribution',
            'cloudfront:GetDistribution',
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
            'lambda:GetFunction',
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
            `arn:${cdk.Aws.PARTITION}:lambda:${region}:${account}:layer:PromptRunnerHosting-*`,
          ],
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
