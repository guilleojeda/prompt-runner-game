import * as cdk from 'aws-cdk-lib';
import { aws_cognito as cognito, aws_wafv2 as wafv2 } from 'aws-cdk-lib';
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
  /** Private WAF request threshold per source IP over a five-minute window. */
  readonly identityRateLimit: number;
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
  const productionWebOrigin = props.productionWebOrigin.replace(/\/$/, '');
  const localOrigin = localWebOrigin.replace(/\/$/, '');
  const callbackUrls = [`${productionWebOrigin}/jugar`, `${localOrigin}/jugar`];
  const logoutUrls = [`${productionWebOrigin}/`, `${localOrigin}/`];

  const userPool = new cognito.CfnUserPool(scope, 'UserPool', {
    userPoolName: 'prompt-runner-game-users',
    userPoolTier: 'ESSENTIALS',
    adminCreateUserConfig: { allowAdminCreateUserOnly: false },
    accountRecoverySetting: {
      recoveryMechanisms: [{ name: 'verified_email', priority: 1 }],
    },
    autoVerifiedAttributes: ['email'],
    deletionProtection: 'ACTIVE',
    emailConfiguration: {
      emailSendingAccount: 'DEVELOPER',
      sourceArn: 'arn:aws:ses:us-east-1:387483252302:identity/dondeaprendoaws.com',
      from: 'hello@dondeaprendoaws.com',
    },
    policies: {
      signInPolicy: { allowedFirstAuthFactors: ['PASSWORD'] },
    },
    usernameAttributes: ['email'],
    usernameConfiguration: { caseSensitive: false },
    verificationMessageTemplate: {
      defaultEmailOption: 'CONFIRM_WITH_CODE',
      emailSubject: 'Tu código de verificación para el juego',
      emailMessage:
        '<html><body><p>Tu código de verificación es: <strong>{####}</strong>.</p><p>Ingresalo en la pantalla donde lo solicitaste para confirmar tu email o restablecer tu contraseña. Si no pediste este código, podés ignorar este mensaje.</p></body></html>',
    },
    userPoolTags: { Application: 'prompt-runner-game' },
  });
  userPool.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN, {
    applyToUpdateReplacePolicy: true,
  });

  const identityOperations = [
    'SignUp',
    'ConfirmSignUp',
    'ResendConfirmationCode',
    'ForgotPassword',
    'ConfirmForgotPassword',
  ];
  const managedLoginPaths = [
    '/signup',
    '/confirm',
    '/confirmUser',
    '/resendcode',
    '/forgotPassword',
    '/confirmforgotPassword',
  ];
  const byteMatch = (
    fieldToMatch: wafv2.CfnWebACL.FieldToMatchProperty,
    searchString: string,
  ): wafv2.CfnWebACL.StatementProperty => ({
    byteMatchStatement: {
      fieldToMatch,
      positionalConstraint: 'EXACTLY',
      searchString,
      textTransformations: [{ priority: 0, type: 'NONE' }],
    },
  });
  const identityWebAcl = new wafv2.CfnWebACL(scope, 'IdentityOriginRateLimitWebAcl', {
    name: 'prompt-runner-game-identity-origin-rate-limit',
    scope: 'REGIONAL',
    defaultAction: { allow: {} },
    rules: [
      {
        name: 'LimitRegistrationAndRecoveryByIp',
        priority: 0,
        action: { block: {} },
        statement: {
          rateBasedStatement: {
            aggregateKeyType: 'IP',
            evaluationWindowSec: 300,
            limit: props.identityRateLimit,
            scopeDownStatement: {
              orStatement: {
                statements: [
                  ...identityOperations.map((operation) =>
                    byteMatch(
                      { singleHeader: { Name: 'x-amzn-cognito-operation-name' } },
                      operation,
                    ),
                  ),
                  ...managedLoginPaths.map((path) => byteMatch({ uriPath: {} }, path)),
                ],
              },
            },
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: false,
          metricName: 'identity-origin-rate-limit',
          sampledRequestsEnabled: false,
        },
      },
    ],
    visibilityConfig: {
      cloudWatchMetricsEnabled: false,
      metricName: 'identity-origin-rate-limit',
      sampledRequestsEnabled: false,
    },
  });
  new wafv2.CfnWebACLAssociation(scope, 'IdentityOriginRateLimitAssociation', {
    resourceArn: userPool.attrArn,
    webAclArn: identityWebAcl.attrArn,
  });

  const userPoolClient = new cognito.CfnUserPoolClient(scope, 'UserPoolClient', {
    userPoolId: userPool.ref,
    clientName: 'prompt-runner-game-web',
    generateSecret: false,
    allowedOAuthFlowsUserPoolClient: true,
    allowedOAuthFlows: ['code'],
    allowedOAuthScopes: ['openid', 'email', ROBOT_SCOPE],
    callbackUrLs: callbackUrls,
    logoutUrLs: logoutUrls,
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
    redirectUri: `${productionWebOrigin}/jugar`,
    logoutUri: `${productionWebOrigin}/`,
  };

  return { userPool, userPoolClient, resourceServer, userPoolDomain, managedLoginBranding, config };
}
