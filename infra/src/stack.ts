import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import {
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_iam as iam,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const APPLICATION_ACCOUNT = '387483252302';
export const APPLICATION_REGION = 'us-east-1';
export const ASSET_DEPLOYMENT_ROLE_NAME = 'prompt-runner-game-frontend-asset-deployment-us-east-1';
export const GITHUB_DEPLOY_ROLE_NAME = 'prompt-runner-game-github-actions-deploy-us-east-1';
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

    const immutableAssetsPolicy = new cloudfront.CachePolicy(this, 'ImmutableAssetsCachePolicy', {
      cachePolicyName: 'prompt-runner-game-immutable-assets',
      comment: 'Content-hashed Vite assets can be retained across revisions.',
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.days(365),
      maxTtl: cdk.Duration.days(365),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
    });

    this.distribution = new cloudfront.Distribution(this, 'WebsiteDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      },
      additionalBehaviors: {
        'assets/*': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: immutableAssetsPolicy,
        },
      },
    });
    cdk.Tags.of(this.distribution).add('Application', 'prompt-runner-game');

    const assetDeploymentRole = iam.Role.fromRoleArn(
      this,
      'AssetDeploymentRole',
      deploymentRoleArn,
      {
        mutable: false,
      },
    );

    const assetsDeployment = new s3deploy.BucketDeployment(this, 'WebsiteAssetsDeployment', {
      sources: [s3deploy.Source.asset(path.join(webDistPath, 'assets'))],
      destinationBucket: this.websiteBucket,
      destinationKeyPrefix: 'assets',
      prune: false,
      retainOnDelete: true,
      role: assetDeploymentRole,
      cacheControl: [
        s3deploy.CacheControl.maxAge(cdk.Duration.days(365)),
        s3deploy.CacheControl.immutable(),
      ],
      metadata: { 'build-revision': buildRevision },
    });

    const entryDeployment = new s3deploy.BucketDeployment(this, 'WebsiteEntryDeployment', {
      sources: [s3deploy.Source.asset(webDistPath, { exclude: ['assets/**'] })],
      destinationBucket: this.websiteBucket,
      prune: false,
      retainOnDelete: true,
      role: assetDeploymentRole,
      cacheControl: [s3deploy.CacheControl.noCache()],
      metadata: { 'build-revision': buildRevision },
      distribution: this.distribution,
      distributionPaths: ['/', '/index.html', '/favicon.svg', '/manifest.webmanifest'],
    });
    entryDeployment.node.addDependency(assetsDeployment);

    new cdk.CfnOutput(this, 'WebsiteUrl', {
      description: 'HTTPS URL served by CloudFront.',
      value: `https://${this.distribution.domainName}`,
    });
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
  }
}
