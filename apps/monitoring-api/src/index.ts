import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { handleRequest } from './handler.js';

const cognito = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
});

export const handler: APIGatewayProxyHandlerV2 = (event) =>
  handleRequest(event, {
    cognito,
    userPoolId: process.env.COGNITO_USER_POOL_ID ?? '',
  });
