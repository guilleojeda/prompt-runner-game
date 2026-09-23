import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import {
  aws_bedrockagentcore as bedrockagentcore,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_assets as s3assets,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { MODEL_CATALOG, type ModelProfile } from '../../shared/models.js';
import { STARTER_LAMBDA_NAME } from './robot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ATTEMPT_BODIES_BUCKET_PREFIX = 'prompt-runner-game-attempt-bodies';
// AgentCore CodeZip runtime names use the CreateAgentRuntime identifier
// grammar (letters/numbers/underscores only after the initial letter).
export const AGENT_RUNTIME_NAME = 'prompt_runner_game_agent_runtime';
export const AGENT_RUNTIME_ROLE_NAME = 'prompt-runner-game-agent-runtime-us-east-1';
export const STARTER_LAMBDA_ROLE_NAME = 'prompt-runner-game-attempt-starter-execution-us-east-1';
export const STARTER_LOG_GROUP_NAME = `/aws/lambda/${STARTER_LAMBDA_NAME}`;
export const AGENT_RUNTIME_MAX_LIFETIME_SECONDS = 30 * 60;
export const STARTER_MAX_EVENT_AGE_SECONDS = 5 * 60;
export const attemptBodiesBucketNameFor = (account: string, region: string): string =>
  `${ATTEMPT_BODIES_BUCKET_PREFIX}-${account}-${region}`;

export interface ExecutionResourcesProps {
  readonly draftTable: dynamodb.Table;
  readonly apiFunction: lambda.Function;
  readonly apiExecutionRole: iam.Role;
  readonly buildRevision: string;
  readonly account: string;
  readonly region: string;
}

export interface ExecutionResources {
  readonly attemptBodiesBucket: s3.Bucket;
  readonly starterFunction: lambda.Function;
  readonly starterExecutionRole: iam.Role;
  readonly runnerRuntime: bedrockagentcore.CfnRuntime;
  readonly runnerExecutionRole: iam.Role;
  readonly runnerCodeAsset: s3assets.Asset;
}

const runtimeArnFor = (scope: Construct, runtimeName: string): string =>
  cdk.Stack.of(scope).formatArn({
    service: 'bedrock-agentcore',
    resource: 'runtime',
    // AgentCore appends a hyphen and ten-character ID to the configured name.
    // Keep the separator in the pattern so another runtime with only a
    // prefix match cannot use these role permissions.
    resourceName: `${runtimeName}-*`,
  });

const runtimeEndpointArnFor = (scope: Construct, runtimeName: string): string =>
  `${runtimeArnFor(scope, runtimeName)}/runtime-endpoint/*`;

/**
 * Global inference profiles authorize both the profile ARN and their exact
 * foundation-model destinations. The current catalog uses the profile's
 * model identifier as the foundation-model identifier; keep this derivation
 * finite and explicit so adding a catalog row cannot widen IAM to a family.
 */
export const foundationModelIdFor = (profile: ModelProfile): string =>
  profile.modelId.replace(/^global\./u, '');

export const approvedBedrockResourceArnsFor = (
  scope: Construct,
  profile: ModelProfile,
): readonly string[] => {
  const region = cdk.Stack.of(scope).region;
  const profileArn = cdk.Stack.of(scope).formatArn({
    service: 'bedrock',
    resource: 'inference-profile',
    resourceName: profile.modelId,
  });
  const foundationModelId = foundationModelIdFor(profile);
  return [
    profileArn,
    `arn:${cdk.Aws.PARTITION}:bedrock:::foundation-model/${foundationModelId}`,
    `arn:${cdk.Aws.PARTITION}:bedrock:${region}::foundation-model/${foundationModelId}`,
  ];
};

const addLambdaLogPermissions = (role: iam.Role, logGroup: logs.ILogGroup, sid: string): void => {
  role.addToPolicy(
    new iam.PolicyStatement({
      sid,
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`${logGroup.logGroupArn}:*`],
    }),
  );
};

/**
 * Resources owned by the attempt executor and its short asynchronous
 * dispatcher. The API role is deliberately passed in so its permissions can
 * be kept separate from the starter and Runtime roles.
 */
export function createExecutionResources(
  scope: Construct,
  props: ExecutionResourcesProps,
): ExecutionResources {
  const attemptBodiesBucket = new s3.Bucket(scope, 'AttemptBodiesBucket', {
    bucketName: attemptBodiesBucketNameFor(props.account, props.region),
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    autoDeleteObjects: false,
  });

  const starterLogGroup = new logs.LogGroup(scope, 'AttemptStarterLogGroup', {
    logGroupName: STARTER_LOG_GROUP_NAME,
  });
  const starterExecutionRole = new iam.Role(scope, 'AttemptStarterExecutionRole', {
    roleName: STARTER_LAMBDA_ROLE_NAME,
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description: 'Runtime role for the prompt-runner-game attempt starter.',
  });
  starterExecutionRole.addToPolicy(
    new iam.PolicyStatement({
      sid: 'ReadAndClaimAttempt',
      actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
      resources: [props.draftTable.tableArn],
    }),
  );
  starterExecutionRole.addToPolicy(
    new iam.PolicyStatement({
      sid: 'InvokeOwnAgentRuntime',
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      // The starter currently uses the default endpoint (runtime ARN). Keep
      // the endpoint resource in the same owned-runtime scope if a qualifier
      // is supplied by the SDK or a future recovery path.
      resources: [
        runtimeArnFor(scope, AGENT_RUNTIME_NAME),
        runtimeEndpointArnFor(scope, AGENT_RUNTIME_NAME),
      ],
    }),
  );
  addLambdaLogPermissions(starterExecutionRole, starterLogGroup, 'WriteAttemptStarterLogs');

  const starterFunction = new lambda.Function(scope, 'AttemptStarterFunction', {
    functionName: STARTER_LAMBDA_NAME,
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromAsset(path.resolve(__dirname, '../../apps/api/dist-start')),
    role: starterExecutionRole,
    environment: {
      AGENT_RUNTIME_ARN: cdk.Lazy.string({ produce: () => runnerRuntime.attrAgentRuntimeArn }),
      DRAFT_TABLE_NAME: props.draftTable.tableName,
    },
    timeout: cdk.Duration.seconds(120),
    logGroup: starterLogGroup,
  });
  new lambda.EventInvokeConfig(scope, 'AttemptStarterEventInvokeConfig', {
    function: starterFunction,
    maxEventAge: cdk.Duration.seconds(STARTER_MAX_EVENT_AGE_SECONDS),
  });

  const runnerExecutionRole = new iam.Role(scope, 'AgentRuntimeExecutionRole', {
    roleName: AGENT_RUNTIME_ROLE_NAME,
    assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
      conditions: {
        StringEquals: { 'aws:SourceAccount': props.account },
        ArnLike: { 'aws:SourceArn': runtimeArnFor(scope, AGENT_RUNTIME_NAME) },
      },
    }),
    description: 'Runtime role for the prompt-runner-game agent executor.',
  });

  // Runtime and application logs contain operational identifiers only. No
  // tracing or delivery configuration is enabled here, so prompts and model
  // bodies are never copied into a telemetry destination by infrastructure.
  const runtimeLogGroupArn = `arn:${cdk.Aws.PARTITION}:logs:${props.region}:${props.account}:log-group:/aws/bedrock-agentcore/runtimes/${AGENT_RUNTIME_NAME}-*`;
  runnerExecutionRole.addToPolicy(
    new iam.PolicyStatement({
      sid: 'RuntimeOperationalLogs',
      actions: ['logs:CreateLogGroup', 'logs:DescribeLogStreams'],
      resources: [runtimeLogGroupArn],
    }),
  );
  runnerExecutionRole.addToPolicy(
    new iam.PolicyStatement({
      sid: 'RuntimeLogResourcePolicy',
      actions: ['logs:PutResourcePolicy'],
      // PutResourcePolicy is account-scoped by the CloudWatch Logs IAM
      // model, so the region condition is the narrowest supported boundary.
      resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestedRegion': props.region } },
    }),
  );
  runnerExecutionRole.addToPolicy(
    new iam.PolicyStatement({
      sid: 'RuntimeLogGroupDiscovery',
      actions: ['logs:DescribeLogGroups'],
      // DescribeLogGroups does not support resource-level authorization.
      resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestedRegion': props.region } },
    }),
  );
  runnerExecutionRole.addToPolicy(
    new iam.PolicyStatement({
      sid: 'RuntimeLogStreams',
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`${runtimeLogGroupArn}:log-stream:*`],
    }),
  );
  runnerExecutionRole.addToPolicy(
    new iam.PolicyStatement({
      sid: 'ReadWriteAttemptRecords',
      actions: [
        'dynamodb:GetItem',
        'dynamodb:ConditionCheckItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:Query',
      ],
      resources: [props.draftTable.tableArn],
    }),
  );
  runnerExecutionRole.addToPolicy(
    new iam.PolicyStatement({
      sid: 'ReadWriteInferenceBodies',
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: [attemptBodiesBucket.arnForObjects('*')],
    }),
  );

  const approvedBedrockResources = MODEL_CATALOG.flatMap((profile) =>
    approvedBedrockResourceArnsFor(scope, profile),
  );
  runnerExecutionRole.addToPolicy(
    new iam.PolicyStatement({
      sid: 'InvokeApprovedBedrockModels',
      actions: ['bedrock:InvokeModel'],
      resources: approvedBedrockResources,
    }),
  );

  const runnerCodeAsset = new s3assets.Asset(scope, 'AgentRuntimeCodeAsset', {
    path: path.resolve(__dirname, '../../apps/runner/dist'),
  });
  runnerCodeAsset.grantRead(runnerExecutionRole);

  // CfnRuntime is used directly because CodeZip's NODE_22 value and its
  // entrypoint are L1 properties. The asset is a normal CDK S3 asset, which
  // places the compiled runner and its dependencies in the assembly.
  const runnerRuntime = new bedrockagentcore.CfnRuntime(scope, 'AgentRuntime', {
    agentRuntimeName: AGENT_RUNTIME_NAME,
    agentRuntimeArtifact: {
      codeConfiguration: {
        code: {
          s3: {
            bucket: runnerCodeAsset.s3BucketName,
            prefix: runnerCodeAsset.s3ObjectKey,
          },
        },
        entryPoint: ['index.js'],
        runtime: 'NODE_22',
      },
    },
    environmentVariables: {
      DRAFT_TABLE_NAME: props.draftTable.tableName,
      ATTEMPT_BODIES_BUCKET: attemptBodiesBucket.bucketName,
      BUILD_REVISION: props.buildRevision,
    },
    lifecycleConfiguration: {
      idleRuntimeSessionTimeout: AGENT_RUNTIME_MAX_LIFETIME_SECONDS,
      maxLifetime: AGENT_RUNTIME_MAX_LIFETIME_SECONDS,
    },
    // Public networking is deliberate for this runtime: the application
    // reaches Bedrock directly and has no VPC resources in this phase.
    networkConfiguration: { networkMode: 'PUBLIC' },
    protocolConfiguration: 'HTTP',
    roleArn: runnerExecutionRole.roleArn,
    tags: { Application: 'prompt-runner-game' },
  });
  runnerRuntime.node.addDependency(runnerExecutionRole);
  runnerRuntime.node.addDependency(runnerCodeAsset);

  // The starter waits only for Runtime acknowledgement and never receives a
  // browser token or model permission. The API can read body metadata during
  // recovery but cannot write or invoke the Runtime itself.
  props.apiExecutionRole.addToPolicy(
    new iam.PolicyStatement({
      sid: 'InvokeAttemptStarter',
      actions: ['lambda:InvokeFunction'],
      resources: [starterFunction.functionArn],
    }),
  );
  props.apiExecutionRole.addToPolicy(
    new iam.PolicyStatement({
      sid: 'RecoverInferenceBodies',
      actions: ['s3:GetObject'],
      resources: [attemptBodiesBucket.arnForObjects('*')],
    }),
  );
  props.apiExecutionRole.addToPolicy(
    new iam.PolicyStatement({
      sid: 'LocateInferenceBodies',
      actions: ['s3:ListBucket'],
      resources: [attemptBodiesBucket.bucketArn],
    }),
  );
  props.apiFunction.addEnvironment('ATTEMPT_BODIES_BUCKET', attemptBodiesBucket.bucketName);
  props.apiFunction.addEnvironment('STARTER_FUNCTION_NAME', starterFunction.functionName);

  return {
    attemptBodiesBucket,
    starterFunction,
    starterExecutionRole,
    runnerRuntime,
    runnerExecutionRole,
    runnerCodeAsset,
  };
}
