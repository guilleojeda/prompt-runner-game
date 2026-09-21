import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import {
  aws_apigatewayv2 as apigatewayv2,
  aws_apigatewayv2_authorizers as authorizers,
  aws_apigatewayv2_integrations as integrations,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AuthenticationResources, LOCAL_CALLBACK_ORIGIN, ROBOT_SCOPE } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DRAFT_TABLE_NAME = 'prompt-runner-game-drafts';
export const DRAFT_LAMBDA_NAME = 'prompt-runner-game-draft-api';
export const DRAFT_LAMBDA_ROLE_NAME = 'prompt-runner-game-draft-api-execution-us-east-1';
export const DRAFT_LOG_GROUP_NAME = `/aws/lambda/${DRAFT_LAMBDA_NAME}`;
export const STARTER_LAMBDA_NAME = 'prompt-runner-game-attempt-starter';
export const LOCAL_API_ORIGIN = LOCAL_CALLBACK_ORIGIN.slice(0, -1);

export interface RobotResourcesProps {
  readonly authentication: AuthenticationResources;
  /** Origin without a trailing slash, used for the API CORS allow list. */
  readonly productionWebOrigin: string;
}

export interface RobotResources {
  readonly draftTable: dynamodb.Table;
  readonly draftFunction: lambda.Function;
  readonly draftExecutionRole: iam.Role;
  readonly api: apigatewayv2.HttpApi;
  readonly apiBaseUrl: string;
}

/**
 * Resources for the phase 2 draft API. The API is intentionally kept in one
 * construct so its Lambda, data access, authorizer, routes, and CORS policy
 * stay reviewable together.
 */
export function createRobotResources(scope: Construct, props: RobotResourcesProps): RobotResources {
  const draftTable = new dynamodb.Table(scope, 'DraftTable', {
    tableName: DRAFT_TABLE_NAME,
    partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  const executionRole = new iam.Role(scope, 'DraftApiExecutionRole', {
    roleName: DRAFT_LAMBDA_ROLE_NAME,
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description: 'Runtime role for the prompt-runner-game draft API.',
  });
  executionRole.addToPolicy(
    new iam.PolicyStatement({
      sid: 'DraftTableReadWrite',
      actions: [
        'dynamodb:GetItem',
        'dynamodb:ConditionCheckItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:Query',
      ],
      resources: [draftTable.tableArn],
    }),
  );

  const logGroup = new logs.LogGroup(scope, 'DraftApiLogGroup', {
    logGroupName: DRAFT_LOG_GROUP_NAME,
  });
  executionRole.addToPolicy(
    new iam.PolicyStatement({
      sid: 'WriteDraftApiLogs',
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`${logGroup.logGroupArn}:*`],
    }),
  );

  const draftFunction = new lambda.Function(scope, 'DraftApiFunction', {
    functionName: DRAFT_LAMBDA_NAME,
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromAsset(path.resolve(__dirname, '../../apps/api/dist')),
    role: executionRole,
    environment: {
      DRAFT_TABLE_NAME: draftTable.tableName,
      COGNITO_CLIENT_ID: props.authentication.userPoolClient.ref,
      COGNITO_USERINFO_URL: `${props.authentication.config.domain}/oauth2/userInfo`,
      STARTER_FUNCTION_NAME: STARTER_LAMBDA_NAME,
    },
    timeout: cdk.Duration.seconds(15),
    logGroup,
  });

  const api = new apigatewayv2.HttpApi(scope, 'DraftApi', {
    apiName: DRAFT_LAMBDA_NAME,
    createDefaultStage: true,
    corsPreflight: {
      allowOrigins: [props.productionWebOrigin, LOCAL_API_ORIGIN],
      allowMethods: [
        apigatewayv2.CorsHttpMethod.GET,
        apigatewayv2.CorsHttpMethod.PUT,
        apigatewayv2.CorsHttpMethod.POST,
        apigatewayv2.CorsHttpMethod.OPTIONS,
      ],
      allowHeaders: ['Authorization', 'Content-Type'],
      allowCredentials: false,
    },
  });
  const authorizer = new authorizers.HttpJwtAuthorizer(
    'DraftJwtAuthorizer',
    props.authentication.config.issuer,
    {
      authorizerName: 'prompt-runner-game-draft-jwt',
      jwtAudience: [props.authentication.userPoolClient.ref],
    },
  );
  const integration = new integrations.HttpLambdaIntegration('DraftApiIntegration', draftFunction);
  api.addRoutes({
    path: '/draft',
    methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.PUT],
    integration,
    authorizer,
    authorizationScopes: [ROBOT_SCOPE],
  });

  // Attempt admission, status/history, cancellation, and quota are all
  // handled by this same identity-checked Lambda. Keeping every route behind
  // the same JWT authorizer prevents an accidental unauthenticated recovery
  // or cancellation endpoint as the API grows.
  const authenticatedRoutes: Array<{
    readonly path: string;
    readonly methods: apigatewayv2.HttpMethod[];
  }> = [
    { path: '/attempts', methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST] },
    { path: '/attempts/{attemptId}', methods: [apigatewayv2.HttpMethod.GET] },
    { path: '/attempts/{attemptId}/start', methods: [apigatewayv2.HttpMethod.POST] },
    { path: '/attempts/{attemptId}/cancel', methods: [apigatewayv2.HttpMethod.POST] },
    { path: '/attempt-requests/{requestKey}', methods: [apigatewayv2.HttpMethod.GET] },
    { path: '/quota', methods: [apigatewayv2.HttpMethod.GET] },
  ];
  for (const route of authenticatedRoutes) {
    api.addRoutes({
      path: route.path,
      methods: route.methods,
      integration,
      authorizer,
      authorizationScopes: [ROBOT_SCOPE],
    });
  }

  return {
    draftTable,
    draftFunction,
    draftExecutionRole: executionRole,
    api,
    apiBaseUrl: api.apiEndpoint,
  };
}
