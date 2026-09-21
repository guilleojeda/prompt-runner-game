import * as cdk from 'aws-cdk-lib';
import { aws_cognito as cognito } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export const COGNITO_DOMAIN_PREFIX = 'prompt-runner-game';
export const LOCAL_CALLBACK_ORIGIN = 'http://localhost:5173/';
export const ROBOT_SCOPE_IDENTIFIER = 'prompt-runner';
export const ROBOT_SCOPE_NAME = 'robot';
export const ROBOT_SCOPE = `${ROBOT_SCOPE_IDENTIFIER}/${ROBOT_SCOPE_NAME}`;

export interface AuthenticationResources {
  readonly userPool: cognito.CfnUserPool;
  readonly userPoolClient: cognito.CfnUserPoolClient;
  readonly resourceServer: cognito.CfnUserPoolResourceServer;
  readonly userPoolDomain: cognito.CfnUserPoolDomain;
  readonly managedLoginBranding: cognito.CfnManagedLoginBranding;
  readonly config: {
    readonly issuer: string;
    readonly clientId: string;
    readonly domain: string;
    readonly redirectUri: string;
    readonly logoutUri: string;
  };
}

export interface AuthenticationResourcesProps {
  readonly region: string;
  readonly productionWebOrigin: string;
  readonly localWebOrigin?: string;
}

/**
 * Cognito resources shared by the hosted web entry point and the later API.
 * The user pool is declared explicitly so the retention and protected-deletion
 * settings remain visible in the synthesized template.
 */
export function createAuthenticationResources(
  scope: Construct,
  props: AuthenticationResourcesProps,
): AuthenticationResources {
  const localWebOrigin = props.localWebOrigin ?? LOCAL_CALLBACK_ORIGIN;
  const callbackUrls = [props.productionWebOrigin, localWebOrigin];

  const userPool = new cognito.CfnUserPool(scope, 'UserPool', {
    userPoolName: 'prompt-runner-game-users',
    userPoolTier: 'ESSENTIALS',
    adminCreateUserConfig: { allowAdminCreateUserOnly: false },
    accountRecoverySetting: {
      recoveryMechanisms: [{ name: 'verified_email', priority: 1 }],
    },
    autoVerifiedAttributes: ['email'],
    deletionProtection: 'ACTIVE',
    emailConfiguration: { emailSendingAccount: 'COGNITO_DEFAULT' },
    policies: {
      signInPolicy: { allowedFirstAuthFactors: ['PASSWORD'] },
    },
    usernameAttributes: ['email'],
    usernameConfiguration: { caseSensitive: false },
    verificationMessageTemplate: { defaultEmailOption: 'CONFIRM_WITH_CODE' },
    userPoolTags: { Application: 'prompt-runner-game' },
  });
  userPool.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN, {
    applyToUpdateReplacePolicy: true,
  });

  const userPoolClient = new cognito.CfnUserPoolClient(scope, 'UserPoolClient', {
    userPoolId: userPool.ref,
    clientName: 'prompt-runner-game-web',
    generateSecret: false,
    allowedOAuthFlowsUserPoolClient: true,
    allowedOAuthFlows: ['code'],
    allowedOAuthScopes: ['openid', 'email', ROBOT_SCOPE],
    callbackUrLs: callbackUrls,
    logoutUrLs: callbackUrls,
    supportedIdentityProviders: ['COGNITO'],
    readAttributes: ['email', 'email_verified'],
    writeAttributes: ['email'],
    enableTokenRevocation: true,
  });

  const resourceServer = new cognito.CfnUserPoolResourceServer(scope, 'RobotResourceServer', {
    identifier: ROBOT_SCOPE_IDENTIFIER,
    name: 'prompt-runner-game API',
    userPoolId: userPool.ref,
    scopes: [
      {
        scopeName: ROBOT_SCOPE_NAME,
        scopeDescription: 'Read and save the signed-in user robot draft.',
      },
    ],
  });
  userPoolClient.addDependency(resourceServer);

  const userPoolDomain = new cognito.CfnUserPoolDomain(scope, 'UserPoolDomain', {
    userPoolId: userPool.ref,
    domain: COGNITO_DOMAIN_PREFIX,
    managedLoginVersion: 2,
  });

  const managedLoginBranding = new cognito.CfnManagedLoginBranding(scope, 'ManagedLoginBranding', {
    userPoolId: userPool.ref,
    clientId: userPoolClient.ref,
    useCognitoProvidedValues: true,
  });

  const issuer = `https://cognito-idp.${props.region}.amazonaws.com/${userPool.ref}`;
  const domain = `https://${userPoolDomain.ref}.auth.${props.region}.amazoncognito.com`;
  const config = {
    issuer,
    clientId: userPoolClient.ref,
    domain,
    redirectUri: props.productionWebOrigin,
    logoutUri: props.productionWebOrigin,
  };

  return { userPool, userPoolClient, resourceServer, userPoolDomain, managedLoginBranding, config };
}
