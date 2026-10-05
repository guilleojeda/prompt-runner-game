import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import {
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_certificatemanager as acm,
  aws_iam as iam,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_route53 as route53,
  aws_route53_targets as targets,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { createAuthenticationResources, ROBOT_SCOPE } from './auth.js';
import { createExecutionResources } from './execution.js';
import { createRobotResources } from './robot.js';
import { createPrivateLimits } from './private-limits.js';
import { createBillingBudgets } from './budgets.js';
import {
  PUBLIC_DOMAIN,
  PUBLIC_ORIGIN,
  PUBLIC_ROUTING_FUNCTION_NAME,
  publicHostedZoneId,
  publicRoutingCode,
} from './domain.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const APPLICATION_ACCOUNT = '387483252302';
export const APPLICATION_REGION = 'us-east-1';
export const ASSET_DEPLOYMENT_ROLE_NAME = 'prompt-runner-game-frontend-asset-deployment-us-east-1';
export const GITHUB_DEPLOY_ROLE_NAME = 'prompt-runner-game-github-actions-deploy-us-east-1';
export const WEBSITE_DEPLOYMENT_LOG_GROUP_NAME =
  '/aws/lambda/PromptRunnerHosting-website-deployment';
export const websiteBucketNameFor = (account: string) =>
  `prompt-runner-game-website-${account}-${APPLICATION_REGION}`;

export interface PromptRunnerHostingStackProps extends cdk.StackProps {
  /** Fixed role prepared outside this stack for the CDK asset deployment custom resource. */
  readonly assetDeploymentRoleArn?: string;
  /** Revision recorded in CloudFormation outputs and object metadata. */
  readonly buildRevision?: string;
}

export class PromptRunnerHostingStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly websiteBucket: s3.Bucket;

  public constructor(scope: Construct, id: string, props: PromptRunnerHostingStackProps = {}) {
    super(scope, id, props);

    const account = props.env?.account ?? APPLICATION_ACCOUNT;
    const buildRevision = props.buildRevision ?? 'local';
    const limits = createPrivateLimits(this);
    createBillingBudgets(this, limits);
    const webDistPath = path.resolve(__dirname, '../../apps/web/dist');
    const deploymentRoleArn =
      props.assetDeploymentRoleArn ??
      `arn:${cdk.Aws.PARTITION}:iam::${account}:role/${ASSET_DEPLOYMENT_ROLE_NAME}`;

    this.websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      bucketName: websiteBucketNameFor(account),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const originAccessControl = new cloudfront.S3OriginAccessControl(this, 'WebsiteOac', {
      originAccessControlName: 'prompt-runner-game-website',
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });

    const origin = origins.S3BucketOrigin.withOriginAccessControl(this.websiteBucket, {
      originAccessControl,
    });

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'PublicHostedZone', {
      hostedZoneId: publicHostedZoneId(this),
      zoneName: PUBLIC_DOMAIN,
    });
    const certificate = new acm.Certificate(this, 'PublicWebsiteCertificate', {
      domainName: PUBLIC_DOMAIN,
      validation: acm.CertificateValidation.fromDns(zone),
    });
    cdk.Tags.of(certificate).add('Application', 'prompt-runner-game');
    const publicRouting = new cloudfront.Function(this, 'PublicWebsiteRouting', {
      functionName: PUBLIC_ROUTING_FUNCTION_NAME,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(publicRoutingCode),
    });
    const routePages = [
      { function: publicRouting, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
    ];

    const immutableAssetsPolicy = new cloudfront.CachePolicy(this, 'ImmutableAssetsCachePolicy', {
      cachePolicyName: 'prompt-runner-game-immutable-assets',
      comment: 'Content-hashed Vite assets served with immutable caching.',
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.days(365),
      maxTtl: cdk.Duration.days(365),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
    });

    this.distribution = new cloudfront.Distribution(this, 'WebsiteDistribution', {
      defaultRootObject: 'index.html',
      domainNames: [PUBLIC_DOMAIN],
      certificate,
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        functionAssociations: routePages,
      },
      additionalBehaviors: {
        'assets/*': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: immutableAssetsPolicy,
          functionAssociations: routePages,
        },
      },
    });
    cdk.Tags.of(this.distribution).add('Application', 'prompt-runner-game');
    const websiteAlias = route53.RecordTarget.fromAlias(
      new targets.CloudFrontTarget(this.distribution),
    );
    new route53.ARecord(this, 'PublicWebsiteIpv4', { zone, target: websiteAlias });
    new route53.AaaaRecord(this, 'PublicWebsiteIpv6', { zone, target: websiteAlias });

    const authentication = createAuthenticationResources(this, {
      identityRateLimit: limits.identityRateLimit,
      region: props.env?.region ?? APPLICATION_REGION,
      productionWebOrigin: PUBLIC_ORIGIN,
    });
    const robot = createRobotResources(this, {
      limits,
      authentication,
      productionWebOrigin: PUBLIC_ORIGIN,
    });
    const execution = createExecutionResources(this, {
      limits,
      account,
      region: props.env?.region ?? APPLICATION_REGION,
      buildRevision,
      draftTable: robot.draftTable,
      apiFunction: robot.draftFunction,
      apiExecutionRole: robot.draftExecutionRole,
    });
    // Keep model admission behind the Runtime role/policy and Runtime update.
    // CloudFormation applies this ordering to updates as well as creation.
    robot.draftFunction.node.addDependency(execution.runnerRuntime);
    const publicAuthConfig = {
      ...authentication.config,
      apiBaseUrl: robot.apiBaseUrl,
      apiScope: ROBOT_SCOPE,
    };

    const assetDeploymentRole = iam.Role.fromRoleArn(
      this,
      'AssetDeploymentRole',
      deploymentRoleArn,
      {
        mutable: false,
      },
    );

    const deploymentLogs = new logs.LogGroup(this, 'WebsiteDeploymentLogs', {
      logGroupName: WEBSITE_DEPLOYMENT_LOG_GROUP_NAME,
      retention: logs.RetentionDays.ONE_MONTH,
    });

    const assetsDeployment = new s3deploy.BucketDeployment(this, 'WebsiteAssetsDeployment', {
      sources: [s3deploy.Source.asset(path.join(webDistPath, 'assets'))],
      destinationBucket: this.websiteBucket,
      destinationKeyPrefix: 'assets',
      prune: true,
      retainOnDelete: true,
      role: assetDeploymentRole,
      logGroup: deploymentLogs,
      cacheControl: [
        s3deploy.CacheControl.maxAge(cdk.Duration.days(365)),
        s3deploy.CacheControl.immutable(),
      ],
      metadata: { 'build-revision': buildRevision },
    });

    const entryDeployment = new s3deploy.BucketDeployment(this, 'WebsiteEntryDeployment', {
      sources: [
        s3deploy.Source.asset(webDistPath, { exclude: ['assets/**'] }),
        s3deploy.Source.jsonData('auth-config.json', publicAuthConfig),
      ],
      destinationBucket: this.websiteBucket,
      prune: false,
      retainOnDelete: true,
      role: assetDeploymentRole,
      logGroup: deploymentLogs,
      cacheControl: [s3deploy.CacheControl.noCache()],
      metadata: { 'build-revision': buildRevision },
      distribution: this.distribution,
      distributionPaths: [
        '/',
        '/index.html',
        '/jugar',
        '/jugar/*',
        '/privacidad',
        '/bienvenida.html',
        '/privacidad/index.html',
        '/screenshots/*',
        '/favicon.svg',
        '/manifest.webmanifest',
        '/auth-config.json',
        '/assets/*',
      ],
    });
    entryDeployment.node.addDependency(assetsDeployment);
    entryDeployment.node.addDependency(authentication.managedLoginBranding);
    // Publish the entry point only after the API Lambda that accepts the
    // catalog has been updated. Hashed assets may still upload first.
    entryDeployment.node.addDependency(robot.draftFunction);

    new cdk.CfnOutput(this, 'WebsiteUrl', {
      description: 'HTTPS URL served by CloudFront.',
      value: PUBLIC_ORIGIN,
    });
    new cdk.CfnOutput(this, 'PublicHostedZoneIdOutput', { value: zone.hostedZoneId });
    new cdk.CfnOutput(this, 'PublicWebsiteCertificateArn', { value: certificate.certificateArn });
    new cdk.CfnOutput(this, 'WebsiteBucketName', {
      description: 'Private S3 bucket used by CloudFront.',
      value: this.websiteBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      description: 'CloudFront distribution serving the website.',
      value: this.distribution.distributionId,
    });
    new cdk.CfnOutput(this, 'BuildRevision', {
      description: 'Revision of the verified frontend build.',
      value: buildRevision,
    });
    new cdk.CfnOutput(this, 'AssetDeploymentRoleArn', {
      description: 'Fixed role required by the CDK website asset deployment custom resource.',
      value: deploymentRoleArn,
    });
    new cdk.CfnOutput(this, 'ApiBaseUrl', {
      description: 'HTTPS endpoint for the authenticated robot draft API.',
      value: robot.apiBaseUrl,
    });
    new cdk.CfnOutput(this, 'DraftTableName', {
      description: 'Retained DynamoDB table storing one draft per user.',
      value: robot.draftTable.tableName,
    });
    new cdk.CfnOutput(this, 'DraftFunctionName', {
      description: 'Lambda function serving the robot draft API.',
      value: robot.draftFunction.functionName,
    });
    new cdk.CfnOutput(this, 'AgentRuntimeArn', {
      description: 'IAM-authenticated AgentCore Runtime used for attempts.',
      value: execution.runnerRuntime.attrAgentRuntimeArn,
    });
    new cdk.CfnOutput(this, 'AttemptBodiesBucketName', {
      description: 'Private retained S3 bucket containing inference bodies.',
      value: execution.attemptBodiesBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'StarterRevision', {
      description: 'Build revision of the asynchronous attempt starter bundle.',
      value: buildRevision,
    });
  }
}
