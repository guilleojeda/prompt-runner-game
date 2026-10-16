import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { instrumentAwsClient } from '../../../shared/aws-client-telemetry.js';
import { logLambdaRecord, withLambdaTelemetry } from '../../../shared/lambda-telemetry.js';
import { handleRequest } from './handler.js';

const cognito = instrumentAwsClient(
  new CognitoIdentityProviderClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
  }),
);
const dynamo = instrumentAwsClient(
  new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
  }),
);

export const handler = (event: APIGatewayProxyEventV2, lambdaContext: Context) =>
  withLambdaTelemetry('monitoring-api', lambdaContext.awsRequestId, async () => {
    const result = await handleRequest(event, {
      cognito,
      dynamo,
      userPoolId: process.env.COGNITO_USER_POOL_ID ?? '',
      tableName: process.env.DRAFT_TABLE_NAME ?? '',
    });
    logLambdaRecord('log', {
      component: 'monitoring-api',
      requestId: event.requestContext?.requestId ?? 'unknown',
      status: result.statusCode ?? 200,
    });
    return result;
  });
