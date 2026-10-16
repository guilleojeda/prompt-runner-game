import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import {
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { cloudFrontBasicAuthCode, validateMonitoringAuthVerifier } from './monitoring-auth.js';
import {
  MONITORING_ASSET_DEPLOYMENT_FUNCTION_NAME,
  MONITORING_ASSET_DEPLOYMENT_LOG_GROUP_NAME,
  MONITORING_ASSET_DEPLOYMENT_ROLE_NAME,
  MONITORING_AUTH_FUNCTION_NAME,
  MONITORING_METRICS_FUNCTION_NAME,
  MONITORING_METRICS_LOG_GROUP_NAME,
  MONITORING_METRICS_ROLE_NAME,
  monitoringBucketNameFor,
} from './monitoring-constants.js';
import { APPLICATION_ACCOUNT, APPLICATION_REGION } from './stack.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface PromptRunnerMonitoringStackProps extends cdk.StackProps {
  /** Existing Cognito pool used by the game; the monitor never creates its own pool. */
  readonly userPool: cognito.IUserPool;
  /** Existing attempt table queried by the monitor; the stack never creates a table. */
  readonly draftTable: dynamodb.ITable;
  /** SHA-256 of the UTF-8 bytes for `monitor:<password>`. */
  readonly authVerifier: string;
  /** Revision recorded with the published entry and in the stack outputs. */
  readonly buildRevision: string;
  /** Fixed publisher role prepared by PromptRunnerAccess. */
  readonly assetDeploymentRoleArn?: string;
}

export class PromptRunnerMonitoringStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly websiteBucket: s3.Bucket;
  public readonly metricsFunction: lambda.Function;

  public constructor(scope: Construct, id: string, props: PromptRunnerMonitoringStackProps) {
    super(scope, id, props);

    const account = props.env?.account ?? APPLICATION_ACCOUNT;
    const region = props.env?.region ?? APPLICATION_REGION;
    const buildRevision = props.buildRevision;
    const authVerifier = validateMonitoringAuthVerifier(props.authVerifier);
    const bucketName = monitoringBucketNameFor(account, region);
    const webDistPath = path.resolve(__dirname, '../../apps/monitoring-web/dist');
    const deploymentRoleArn =
      props.assetDeploymentRoleArn ??
      `arn:${cdk.Aws.PARTITION}:iam::${account}:role/${MONITORING_ASSET_DEPLOYMENT_ROLE_NAME}`;

    cdk.Tags.of(this).add('Application', 'prompt-runner-game');

    this.websiteBucket = new s3.Bucket(this, 'MonitoringWebsiteBucket', {
      bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const websiteOac = new cloudfront.S3OriginAccessControl(this, 'MonitoringWebsiteOac', {
      originAccessControlName: 'prompt-runner-game-monitoring-website',
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });
    const websiteOrigin = origins.S3BucketOrigin.withOriginAccessControl(this.websiteBucket, {
      originAccessControl: websiteOac,
    });

    const metricsRole = new iam.Role(this, 'MetricsExecutionRole', {
      roleName: MONITORING_METRICS_ROLE_NAME,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Read-only runtime role for the prompt-runner-game monitoring API.',
    });
    metricsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ListConfirmedGameUsers',
        actions: ['cognito-idp:ListUsers'],
        resources: [
          `arn:aws:cognito-idp:${region}:${account}:userpool/${props.userPool.userPoolId}`,
        ],
      }),
    );
    metricsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'QueryAttemptHeaders',
        actions: ['dynamodb:Query'],
        resources: [props.draftTable.tableArn],
      }),
    );

    const metricsLogGroup = new logs.LogGroup(this, 'MetricsLogGroup', {
      logGroupName: MONITORING_METRICS_LOG_GROUP_NAME,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    metricsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteMonitoringMetricsLogs',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`${metricsLogGroup.logGroupArn}:*`],
      }),
    );

    this.metricsFunction = new lambda.Function(this, 'MetricsFunction', {
      functionName: MONITORING_METRICS_FUNCTION_NAME,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.resolve(__dirname, '../../apps/monitoring-api/dist')),
      role: metricsRole,
      environment: {
        COGNITO_USER_POOL_ID: props.userPool.userPoolId,
        DRAFT_TABLE_NAME: props.draftTable.tableName,
      },
      timeout: cdk.Duration.seconds(15),
      logGroup: metricsLogGroup,
    });
    const metricsUrl = this.metricsFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });
    const metricsOac = new cloudfront.FunctionUrlOriginAccessControl(this, 'MetricsOac', {
      originAccessControlName: 'prompt-runner-game-monitoring-metrics',
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });
    const metricsOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(metricsUrl, {
      originAccessControl: metricsOac,
    });

    const authFunction = new cloudfront.Function(this, 'MonitoringAuthentication', {
      functionName: MONITORING_AUTH_FUNCTION_NAME,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(cloudFrontBasicAuthCode(authVerifier)),
      comment: 'Protects every monitoring request with HTTP Basic authentication.',
    });
    const authAssociation = [
      { function: authFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
    ];

    this.distribution = new cloudfront.Distribution(this, 'MonitoringDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: websiteOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        functionAssociations: authAssociation,
      },
      additionalBehaviors: {
        'assets/*': {
          origin: websiteOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          functionAssociations: authAssociation,
        },
        'api/*': {
          origin: metricsOrigin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          functionAssociations: authAssociation,
        },
      },
    });
    cdk.Tags.of(this.distribution).add('Application', 'prompt-runner-game');

    // Function URL OAC grants InvokeFunctionUrl. IAM-authenticated URLs also
    // require InvokeFunction, restricted to calls made through this URL.
    this.metricsFunction.addPermission('InvokeMetricsUrlFromMonitoringDistribution', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: this.distribution.distributionArn,
      invokedViaFunctionUrl: true,
    });

    const assetDeploymentRole = iam.Role.fromRoleArn(
      this,
      'MonitoringAssetDeploymentRole',
      deploymentRoleArn,
      { mutable: false },
    );
    const deploymentLogs = new logs.LogGroup(this, 'AssetDeploymentLogs', {
      logGroupName: MONITORING_ASSET_DEPLOYMENT_LOG_GROUP_NAME,
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
      sources: [s3deploy.Source.asset(webDistPath, { exclude: ['assets/**'] })],
      destinationBucket: this.websiteBucket,
      prune: false,
      retainOnDelete: true,
      role: assetDeploymentRole,
      logGroup: deploymentLogs,
      cacheControl: [s3deploy.CacheControl.noCache()],
      metadata: { 'build-revision': buildRevision },
      distribution: this.distribution,
      distributionPaths: ['/', '/index.html', '/assets/*'],
    });
    entryDeployment.node.addDependency(assetsDeployment);
    entryDeployment.node.addDependency(this.metricsFunction);

    // BucketDeployment creates a singleton helper with an auto-generated name.
    // A fixed name keeps its CloudFormation permission exact and reviewable.
    const deploymentHandler = this.node
      .findAll()
      .find(
        (construct): construct is lambda.CfnFunction =>
          construct instanceof lambda.CfnFunction &&
          construct.node.path.includes('Custom::CDKBucketDeployment'),
      );
    if (!deploymentHandler) {
      throw new Error('Could not locate the CloudFormation S3 deployment helper Lambda.');
    }
    deploymentHandler.addPropertyOverride(
      'FunctionName',
      MONITORING_ASSET_DEPLOYMENT_FUNCTION_NAME,
    );

    new cdk.CfnOutput(this, 'MonitoringUrl', {
      description: 'Protected HTTPS URL for the monitoring dashboard.',
      value: `https://${this.distribution.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, 'MonitoringBucketName', {
      description: 'Private S3 bucket used by CloudFront for the dashboard.',
      value: this.websiteBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'MonitoringDistributionId', {
      description: 'CloudFront distribution serving the dashboard.',
      value: this.distribution.distributionId,
    });
    new cdk.CfnOutput(this, 'MetricsFunctionName', {
      description: 'Read-only Cognito metrics Lambda.',
      value: this.metricsFunction.functionName,
    });
    new cdk.CfnOutput(this, 'BuildRevision', {
      description: 'Revision of the verified monitoring API and frontend build.',
      value: buildRevision,
    });
  }
}
