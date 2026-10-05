import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { APPLICATION_ACCOUNT, APPLICATION_REGION, PromptRunnerHostingStack } from './stack.js';
import { PUBLIC_DOMAIN, PUBLIC_ORIGIN, PUBLIC_HOSTED_ZONE_ID_PARAMETER } from './domain.js';
import {
  DRAFT_LAMBDA_NAME,
  DRAFT_LAMBDA_ROLE_NAME,
  DRAFT_LOG_GROUP_NAME,
  STARTER_LAMBDA_NAME,
} from './robot.js';
import {
  AGENT_RUNTIME_NAME,
  AGENT_RUNTIME_ROLE_NAME,
  ATTEMPT_BODIES_BUCKET_PREFIX,
  foundationModelIdFor,
  STARTER_LAMBDA_ROLE_NAME,
} from './execution.js';
import { MODEL_CATALOG } from '../../shared/models.js';

// CDK's first template synthesis pays one-time construct startup cost; this
// timeout gives infrastructure assertions room for that cost without changing
// the repository-wide test timeout or implying a deployment SLA.
const CDK_SYNTH_STARTUP_TIMEOUT_MS = 15_000;

function template() {
  const app = new cdk.App();
  const stack = new PromptRunnerHostingStack(app, 'TestHosting', {
    env: { account: APPLICATION_ACCOUNT, region: APPLICATION_REGION },
    assetDeploymentRoleArn: `arn:aws:iam::${APPLICATION_ACCOUNT}:role/prompt-runner-game-frontend-asset-deployment-us-east-1`,
    buildRevision: 'test-revision',
  });

  return Template.fromStack(stack);
}

describe('PromptRunnerHostingStack', { timeout: CDK_SYNTH_STARTUP_TIMEOUT_MS }, () => {
  it('serves the public alias with a DNS-validated certificate and records in the prepared child zone', () => {
    const synthesized = template();
    expect(synthesized.toJSON().Parameters.PublicHostedZoneId).toMatchObject({
      Type: 'AWS::SSM::Parameter::Value<String>',
      Default: PUBLIC_HOSTED_ZONE_ID_PARAMETER,
    });
    synthesized.resourceCountIs('AWS::Route53::HostedZone', 0);
    synthesized.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: PUBLIC_DOMAIN,
      ValidationMethod: 'DNS',
      DomainValidationOptions: [
        { DomainName: PUBLIC_DOMAIN, HostedZoneId: { Ref: 'PublicHostedZoneId' } },
      ],
    });
    for (const type of ['A', 'AAAA'])
      synthesized.hasResourceProperties('AWS::Route53::RecordSet', {
        Type: type,
        Name: `${PUBLIC_DOMAIN}.`,
        HostedZoneId: { Ref: 'PublicHostedZoneId' },
        AliasTarget: { DNSName: Match.anyValue(), HostedZoneId: Match.anyValue() },
      });
    synthesized.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        Aliases: [PUBLIC_DOMAIN],
        ViewerCertificate: {
          AcmCertificateArn: Match.anyValue(),
          SslSupportMethod: 'sni-only',
          MinimumProtocolVersion: 'TLSv1.2_2021',
        },
        DefaultCacheBehavior: {
          FunctionAssociations: [{ EventType: 'viewer-request', FunctionARN: Match.anyValue() }],
        },
      },
    });
    expect(synthesized.toJSON().Outputs.WebsiteUrl.Value).toBe(PUBLIC_ORIGIN);
  });
  it('resolves private limits only at deployment and never publishes them as web configuration', () => {
    const synthesized = template();
    const parameters = synthesized.toJSON().Parameters as Record<
      string,
      { Type: string; Default?: string; NoEcho?: boolean }
    >;
    const limitParameters = Object.entries(parameters).filter(([, parameter]) =>
      parameter.Default?.startsWith('/prompt-runner-game/limits/'),
    );
    expect(limitParameters.length).toBeGreaterThan(0);
    for (const [, parameter] of limitParameters) {
      expect(parameter.Type).toBe('AWS::SSM::Parameter::Value<String>');
      expect(parameter.NoEcho).toBe(true);
    }
    const lambdas = Object.values(synthesized.findResources('AWS::Lambda::Function'));
    const api = lambdas.find((resource) => resource.Properties.FunctionName === DRAFT_LAMBDA_NAME);
    expect(api?.Properties.Environment.Variables).toMatchObject({
      SAVED_ROBOTS_LIMIT: { Ref: 'SavedRobotsLimit' },
      BEDROCK_DAILY_GLOBAL_BUDGET_USD: { Ref: 'DailyGlobalBudget' },
      BEDROCK_DAILY_USER_BUDGET_USD: { Ref: 'DailyUserBudget' },
    });
    const runtime = Object.values(synthesized.findResources('AWS::BedrockAgentCore::Runtime'))[0];
    expect(runtime.Properties.EnvironmentVariables).toMatchObject({
      ATTEMPT_ACTIVE_GLOBAL_LIMIT: { Ref: 'ActiveAttemptLimit' },
      BEDROCK_INPUT_USD_PER_MILLION_TOKENS: { Ref: 'InputTokenRate' },
      BEDROCK_OUTPUT_USD_PER_MILLION_TOKENS: { Ref: 'OutputTokenRate' },
    });
    const deployments = synthesized.findResources('Custom::CDKBucketDeployment');
    const published = JSON.stringify(deployments);
    for (const [id] of limitParameters) expect(published).not.toContain(`"Ref":"${id}"`);
    expect(published).not.toContain('BEDROCK_DAILY');
    expect(published).not.toContain('SAVED_ROBOTS_LIMIT');
  });

  it('sets full-account monthly alerts and daily provider billing alerts without shutdown actions', () => {
    const synthesized = template();
    const resources = Object.values(synthesized.findResources('AWS::Budgets::Budget'));
    expect(resources).toHaveLength(3);
    const monthly = resources.filter(
      (resource) => resource.Properties.Budget.TimeUnit === 'MONTHLY',
    );
    expect(
      monthly.map((resource) => resource.Properties.NotificationsWithSubscribers.length),
    ).toEqual([5, 1]);
    const thresholds = monthly.flatMap(
      (resource) => resource.Properties.NotificationsWithSubscribers,
    );
    expect(thresholds.map((entry) => entry.Notification.Threshold)).toEqual(
      Array.from({ length: 6 }, (_, index) => ({ Ref: `MonthlyAlert${index + 1}` })),
    );
    for (const resource of monthly) {
      expect(resource.Properties.Budget.CostFilters).toBeUndefined();
      expect(resource.Properties.Budget.BudgetLimit.Amount).toEqual({
        Ref: 'MonthlyAccountBudget',
      });
    }
    for (const notification of resources.flatMap(
      (resource) => resource.Properties.NotificationsWithSubscribers,
    )) {
      expect(notification.Notification).toMatchObject({
        NotificationType: 'ACTUAL',
        ThresholdType: 'ABSOLUTE_VALUE',
      });
      expect(notification.Subscribers).toEqual([
        { SubscriptionType: 'EMAIL', Address: { Ref: 'BillingAlertRecipient' } },
      ]);
    }
    const daily = resources.find((resource) => resource.Properties.Budget.TimeUnit === 'DAILY');
    expect(daily?.Properties.Budget.CostFilters).toEqual({
      Service: { 'Fn::Split': [',', { Ref: 'BedrockBillingServices' }] },
    });
    synthesized.resourceCountIs('AWS::Budgets::BudgetsAction', 0);
  });

  it('retains operational logs for one month and scopes the Runtime retention helper', () => {
    const synthesized = template();
    const groups = Object.values(synthesized.findResources('AWS::Logs::LogGroup'));
    for (const group of groups) expect(group.Properties.RetentionInDays).toBe(30);
    const calls = Object.values(synthesized.findResources('Custom::AWS')).map(
      (resource) => resource.Properties,
    );
    const retention = calls.find((call) =>
      JSON.stringify(call.Update).includes('putRetentionPolicy'),
    );
    expect(retention).toBeDefined();
    expect(JSON.stringify(retention)).toContain('retentionInDays');
    const policy = Object.values(synthesized.findResources('AWS::IAM::Policy')).find((resource) =>
      JSON.stringify(resource.Properties.PolicyDocument).includes('logs:PutRetentionPolicy'),
    );
    expect(policy).toBeDefined();
    const retentionStatements = policy?.Properties.PolicyDocument.Statement.filter(
      (statement: { Action?: string[] }) => statement.Action?.includes('logs:PutRetentionPolicy'),
    );
    expect(retentionStatements).toHaveLength(1);
    expect(JSON.stringify(retentionStatements)).toContain(
      '/aws/bedrock-agentcore/runtimes/prompt_runner_game_agent_runtime-*',
    );
    expect(retentionStatements[0].Resource).not.toBe('*');
  });

  it('keeps the website bucket private and grants only the OAC read path', () => {
    const synthesized = template();

    synthesized.resourceCountIs('AWS::S3::Bucket', 2);
    synthesized.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    const policies = synthesized.findResources('AWS::S3::BucketPolicy');
    const policy = Object.values(policies)[0].Properties.PolicyDocument;
    const statements = policy.Statement;
    const allows = statements.filter(
      (statement: { Effect?: string }) => statement.Effect === 'Allow',
    );
    expect(allows).toHaveLength(1);
    const bucketLogicalId = Object.entries(synthesized.findResources('AWS::S3::Bucket'))[0][0];
    const distributionLogicalId = Object.entries(
      synthesized.findResources('AWS::CloudFront::Distribution'),
    )[0][0];
    const sourceArn = {
      'Fn::Join': [
        '',
        [
          'arn:',
          { Ref: 'AWS::Partition' },
          ':cloudfront::',
          { Ref: 'AWS::AccountId' },
          ':distribution/',
          { Ref: distributionLogicalId },
        ],
      ],
    };
    expect(allows[0]).toEqual({
      Action: 's3:GetObject',
      Condition: { StringEquals: { 'AWS:SourceArn': sourceArn } },
      Effect: 'Allow',
      Principal: { Service: 'cloudfront.amazonaws.com' },
      Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [bucketLogicalId, 'Arn'] }, '/*']] },
    });
  });

  it('uses an OAC, HTTPS, hashed asset caching, and no SPA error fallback', () => {
    const synthesized = template();

    synthesized.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: {
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      },
    });
    synthesized.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultRootObject: 'index.html',
        HttpVersion: 'http2',
        Origins: [
          Match.objectLike({
            OriginAccessControlId: Match.anyValue(),
          }),
        ],
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
        }),
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: 'assets/*',
            ViewerProtocolPolicy: 'redirect-to-https',
          }),
        ]),
      },
    });
    const distributions = synthesized.findResources('AWS::CloudFront::Distribution');
    const distribution = Object.values(distributions)[0].Properties.DistributionConfig;
    const bucketLogicalId = Object.entries(synthesized.findResources('AWS::S3::Bucket'))[0][0];
    const oacLogicalId = Object.entries(
      synthesized.findResources('AWS::CloudFront::OriginAccessControl'),
    )[0][0];
    const cachePolicyLogicalId = Object.entries(
      synthesized.findResources('AWS::CloudFront::CachePolicy'),
    )[0][0];
    const originId = distribution.Origins[0].Id;
    expect(distribution.Origins[0]).toMatchObject({
      DomainName: { 'Fn::GetAtt': [bucketLogicalId, 'RegionalDomainName'] },
      OriginAccessControlId: { 'Fn::GetAtt': [oacLogicalId, 'Id'] },
    });
    expect(distribution.DefaultCacheBehavior.TargetOriginId).toBe(originId);
    expect(distribution.CacheBehaviors[0]).toMatchObject({
      CachePolicyId: { Ref: cachePolicyLogicalId },
      TargetOriginId: originId,
    });
    for (const resource of Object.values(distributions)) {
      expect(resource.Properties.DistributionConfig.CustomErrorResponses).toBeUndefined();
    }
  });

  it('configures a retained Essentials pool for verified email access', () => {
    const synthesized = template();
    const pools = synthesized.findResources('AWS::Cognito::UserPool');
    expect(Object.keys(pools)).toHaveLength(1);
    const pool = Object.values(pools)[0];

    expect(pool.Properties).toMatchObject({
      AccountRecoverySetting: {
        RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }],
      },
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      AutoVerifiedAttributes: ['email'],
      DeletionProtection: 'ACTIVE',
      EmailConfiguration: {
        EmailSendingAccount: 'DEVELOPER',
        SourceArn: 'arn:aws:ses:us-east-1:387483252302:identity/dondeaprendoaws.com',
        From: 'hello@dondeaprendoaws.com',
      },
      Policies: { SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD'] } },
      UserPoolTier: 'ESSENTIALS',
      UsernameAttributes: ['email'],
      VerificationMessageTemplate: {
        DefaultEmailOption: 'CONFIRM_WITH_CODE',
        EmailSubject: 'Tu código de verificación para el juego',
        EmailMessage:
          '<html><body><p>Tu código de verificación es: <strong>{####}</strong>.</p><p>Ingresalo en la pantalla donde lo solicitaste para confirmar tu email o restablecer tu contraseña. Si no pediste este código, podés ignorar este mensaje.</p></body></html>',
      },
    });
    expect(
      pool.Properties.VerificationMessageTemplate.EmailMessage.match(/\{####\}/g),
    ).toHaveLength(1);
    expect(pool.Properties).not.toHaveProperty('SmsConfiguration');
    expect(pool.Properties).not.toHaveProperty('LambdaConfig');
    expect(pool.Properties).not.toHaveProperty('MfaConfiguration');
    expect(pool.Properties).not.toHaveProperty('EmailVerificationMessage');
    expect(pool.Properties).not.toHaveProperty('EmailVerificationSubject');
    expect(pool.DeletionPolicy).toBe('Retain');
    expect(pool.UpdateReplacePolicy).toBe('Retain');
  });

  it('creates a public code client, Managed Login v2 domain, and default branding', () => {
    const synthesized = template();
    const clients = synthesized.findResources('AWS::Cognito::UserPoolClient');
    const client = Object.values(clients)[0];
    expect(client.Properties).toMatchObject({
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: ['openid', 'email', 'prompt-runner/robot'],
      GenerateSecret: false,
      ReadAttributes: ['email', 'email_verified'],
      SupportedIdentityProviders: ['COGNITO'],
      WriteAttributes: ['email'],
    });
    expect(client.Properties).not.toHaveProperty('ClientSecret');
    expect(client.Properties.CallbackURLs).toHaveLength(2);
    expect(client.Properties.CallbackURLs).toEqual([
      `${PUBLIC_ORIGIN}/jugar`,
      'http://localhost:5173/jugar',
    ]);
    expect(client.Properties.LogoutURLs).toEqual([`${PUBLIC_ORIGIN}/`, 'http://localhost:5173/']);

    synthesized.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'prompt-runner-game',
      ManagedLoginVersion: 2,
    });
    synthesized.hasResourceProperties('AWS::Cognito::ManagedLoginBranding', {
      UseCognitoProvidedValues: false,
    });
    synthesized.hasResourceProperties('AWS::Cognito::UserPoolResourceServer', {
      Identifier: 'prompt-runner',
      Scopes: [
        {
          ScopeDescription: 'Read and save the signed-in user robot draft.',
          ScopeName: 'robot',
        },
      ],
    });
    const branding = Object.values(
      synthesized.findResources('AWS::Cognito::ManagedLoginBranding'),
    )[0];
    expect(branding.Properties.Settings.categories.global.colorSchemeMode).toBe('DARK');
    expect(branding.Properties.Assets.map((asset: { Category: string }) => asset.Category)).toEqual(
      ['FORM_LOGO', 'PAGE_BACKGROUND', 'FAVICON_SVG'],
    );
  });

  it('uses the pre-created deployment role and publishes entry after assets', () => {
    const synthesized = template();

    synthesized.resourceCountIs('AWS::IAM::Role', 4);
    synthesized.resourceCountIs('Custom::CDKBucketDeployment', 2);
    const deployments = synthesized.findResources('Custom::CDKBucketDeployment');
    const deploymentProperties = Object.values(deployments).map((resource) => resource.Properties);
    expect(deploymentProperties).toHaveLength(2);
    expect(deploymentProperties.every((properties) => properties.ServiceToken)).toBe(true);
    expect(deploymentProperties.map((properties) => properties.Prune).sort()).toEqual([
      false,
      true,
    ]);
    const assetDeploymentEntry = Object.entries(deployments).find(
      ([, resource]) => resource.Properties.DestinationBucketKeyPrefix === 'assets',
    );
    const websiteEntry = Object.entries(deployments).find(
      ([, resource]) => resource.Properties.DestinationBucketKeyPrefix === undefined,
    );
    expect(assetDeploymentEntry?.[1].Properties.SystemMetadata['cache-control']).toBe(
      'max-age=31536000, immutable',
    );
    expect(websiteEntry?.[1].Properties.SystemMetadata['cache-control']).toBe('no-cache');
    expect(websiteEntry?.[1].DependsOn).toEqual(
      expect.arrayContaining([assetDeploymentEntry?.[0]]),
    );
    expect(websiteEntry?.[1].DependsOn).toEqual(expect.arrayContaining(['ManagedLoginBranding']));
    expect(websiteEntry?.[1].Properties.SourceBucketNames).toHaveLength(2);
    expect(websiteEntry?.[1].Properties.SourceMarkers[1]).toEqual({
      '<<marker:0xbaba:0>>': expect.anything(),
      '<<marker:0xbaba:1>>': expect.anything(),
      '<<marker:0xbaba:2>>': expect.anything(),
      '<<marker:0xbaba:3>>': expect.anything(),
    });
    const authConfigMarkers = JSON.stringify(websiteEntry?.[1].Properties.SourceMarkers[1]);
    expect(authConfigMarkers).toContain('cognito-idp.us-east-1.amazonaws.com');
    expect(authConfigMarkers).toContain('.auth.us-east-1.amazoncognito.com');
    expect(authConfigMarkers).not.toContain('.amazoncognito.com/');
    expect(websiteEntry?.[1].Properties.DistributionPaths).toContain('/auth-config.json');
    expect(websiteEntry?.[1].Properties.DistributionPaths).toContain('/assets/*');
    expect(JSON.stringify(websiteEntry?.[1].Properties.SourceMarkers[1])).not.toContain(
      'ClientSecret',
    );
    const functions = synthesized.findResources('AWS::Lambda::Function');
    expect(Object.values(functions)).toHaveLength(4);
    const deploymentFunction = Object.values(functions).find(
      (resource) =>
        resource.Properties.Role ===
        'arn:aws:iam::387483252302:role/prompt-runner-game-frontend-asset-deployment-us-east-1',
    );
    expect(deploymentFunction?.Properties).toMatchObject({
      Role: 'arn:aws:iam::387483252302:role/prompt-runner-game-frontend-asset-deployment-us-east-1',
    });
    const draftFunction = Object.values(functions).find(
      (resource) => resource.Properties.FunctionName === DRAFT_LAMBDA_NAME,
    );
    const draftFunctionEntry = Object.entries(functions).find(
      ([, resource]) => resource.Properties.FunctionName === DRAFT_LAMBDA_NAME,
    );
    expect(websiteEntry?.[1].DependsOn).toEqual(expect.arrayContaining([draftFunctionEntry?.[0]]));
    expect(draftFunction?.Properties).toMatchObject({
      Handler: 'index.handler',
      Runtime: 'nodejs22.x',
      Role: { 'Fn::GetAtt': [expect.any(String), 'Arn'] },
      Timeout: 15,
      Environment: {
        Variables: {
          DRAFT_TABLE_NAME: { Ref: expect.any(String) },
          COGNITO_CLIENT_ID: { Ref: expect.any(String) },
          COGNITO_USERINFO_URL: { 'Fn::Join': expect.any(Array) },
        },
      },
    });
    const roles = synthesized.findResources('AWS::IAM::Role');
    expect(Object.values(roles)[0].Properties.RoleName).toBe(DRAFT_LAMBDA_ROLE_NAME);
    const logGroups = synthesized.findResources('AWS::Logs::LogGroup');
    expect(Object.values(logGroups)[0].Properties.LogGroupName).toBe(DRAFT_LOG_GROUP_NAME);
    synthesized.hasOutput('BuildRevision', { Value: 'test-revision' });
  });

  it('publishes only the authenticated draft routes with restricted CORS', () => {
    const synthesized = template();

    const apis = synthesized.findResources('AWS::ApiGatewayV2::Api');
    const api = Object.values(apis)[0];
    expect(api.Properties).toMatchObject({
      Name: DRAFT_LAMBDA_NAME,
      ProtocolType: 'HTTP',
      CorsConfiguration: {
        AllowCredentials: false,
        AllowHeaders: ['Authorization', 'Content-Type'],
        AllowMethods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
        AllowOrigins: [PUBLIC_ORIGIN, 'http://localhost:5173'],
      },
    });
    const routes = Object.values(synthesized.findResources('AWS::ApiGatewayV2::Route'));
    expect(routes).toHaveLength(19);
    for (const route of routes) {
      expect(route.Properties).toMatchObject({
        AuthorizationType: 'JWT',
        AuthorizationScopes: ['prompt-runner/robot'],
        Target: { 'Fn::Join': expect.any(Array) },
      });
      expect([
        'GET /draft',
        'PUT /draft',
        'GET /robots',
        'GET /robots/{uuid}',
        'PUT /robots/{uuid}',
        'DELETE /robots/{uuid}',
        'GET /attempts',
        'POST /attempts',
        'GET /attempts/{attemptId}',
        'POST /attempts/{attemptId}/start',
        'POST /attempts/{attemptId}/cancel',
        'GET /attempts/{attemptId}/replay',
        'GET /attempts/{attemptId}/configuration',
        'GET /attempts/{attemptId}/decisions',
        'POST /attempts/{attemptId}/presentation-complete',
        'GET /attempt-requests/{requestKey}',
        'GET /animation-preference',
        'PUT /animation-preference',
        'GET /quota',
      ]).toContain(route.Properties.RouteKey);
    }
  });

  it('retains the on-demand draft table and limits the Lambda data policy', () => {
    const synthesized = template();

    const tables = synthesized.findResources('AWS::DynamoDB::Table');
    expect(Object.values(tables)).toHaveLength(1);
    const table = Object.values(tables)[0];
    expect(table.Properties).toMatchObject({
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
    });
    expect(table).toMatchObject({ DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    expect(table.Properties).not.toHaveProperty('TimeToLiveSpecification');

    const policies = synthesized.findResources('AWS::IAM::Policy');
    const runtimePolicies = Object.values(policies).filter((policy) =>
      JSON.stringify(policy.Properties.PolicyDocument).includes('DraftTableReadWrite'),
    );
    expect(runtimePolicies).toHaveLength(1);
    const statements = runtimePolicies[0].Properties.PolicyDocument.Statement;
    expect(statements).toContainEqual(
      expect.objectContaining({
        Sid: 'DraftTableReadWrite',
        Action: expect.arrayContaining([
          'dynamodb:GetItem',
          'dynamodb:ConditionCheckItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:Query',
        ]),
      }),
    );
    expect(JSON.stringify(statements)).not.toContain('dynamodb:Scan');
    expect(JSON.stringify(statements)).toContain('dynamodb:DeleteItem');
    const apiPolicyJson = JSON.stringify(runtimePolicies[0].Properties.PolicyDocument);
    expect(apiPolicyJson).toContain('s3:GetObject');
    const bodyBucketEntry = Object.entries(synthesized.findResources('AWS::S3::Bucket')).find(
      ([, resource]) => resource.Properties.BucketName?.startsWith(ATTEMPT_BODIES_BUCKET_PREFIX),
    );
    expect(bodyBucketEntry).toBeDefined();
    const locateBodies = statements.find(
      (statement: { Sid?: string; Action?: unknown; Resource?: unknown }) =>
        statement.Sid === 'LocateInferenceBodies',
    );
    expect(locateBodies).toBeDefined();
    expect(locateBodies?.Action).toBe('s3:ListBucket');
    expect(JSON.stringify(locateBodies?.Resource)).toContain(bodyBucketEntry?.[0]);
    expect(apiPolicyJson).not.toContain('s3:PutObject');
    expect(apiPolicyJson).not.toMatch(/bedrock:|cognito-idp:|iam:/);
  });

  it('keeps attempt bodies private and wires the phase 3 execution assets', () => {
    const synthesized = template();
    const buckets = synthesized.findResources('AWS::S3::Bucket');
    const bodiesBucket = Object.values(buckets).find((resource) =>
      resource.Properties.BucketName?.startsWith(ATTEMPT_BODIES_BUCKET_PREFIX),
    );
    expect(bodiesBucket).toBeDefined();
    expect(bodiesBucket).toMatchObject({
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
          ],
        },
      },
    });
    const bodyPolicies = Object.values(synthesized.findResources('AWS::S3::BucketPolicy')).filter(
      (resource) =>
        resource.Properties.Bucket?.Ref ===
        Object.keys(buckets).find((key) => buckets[key] === bodiesBucket),
    );
    expect(bodyPolicies).toHaveLength(1);
    expect(JSON.stringify(bodyPolicies[0])).toContain('aws:SecureTransport');

    const runtimes = synthesized.findResources('AWS::BedrockAgentCore::Runtime');
    expect(Object.values(runtimes)).toHaveLength(1);
    const runtimeEntry = Object.entries(runtimes)[0];
    const runtime = runtimeEntry[1];
    expect(runtime.Properties.AgentRuntimeName).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,47}$/u);
    expect(runtime.Properties).toMatchObject({
      AgentRuntimeName: AGENT_RUNTIME_NAME,
      AgentRuntimeArtifact: {
        CodeConfiguration: {
          Runtime: 'NODE_22',
          EntryPoint: ['index.js'],
          Code: { S3: { Bucket: expect.anything(), Prefix: expect.anything() } },
        },
      },
      LifecycleConfiguration: { MaxLifetime: 1800 },
      NetworkConfiguration: { NetworkMode: 'PUBLIC' },
      RoleArn: { 'Fn::GetAtt': [expect.any(String), 'Arn'] },
    });
    expect(runtime.Properties.AuthorizerConfiguration).toBeUndefined();

    const functions = Object.values(synthesized.findResources('AWS::Lambda::Function'));
    const starter = functions.find(
      (resource) => resource.Properties.FunctionName === STARTER_LAMBDA_NAME,
    );
    expect(starter?.Properties).toMatchObject({
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      Timeout: 120,
      Environment: {
        Variables: {
          AGENT_RUNTIME_ARN: { 'Fn::GetAtt': [expect.any(String), 'AgentRuntimeArn'] },
          DRAFT_TABLE_NAME: { Ref: expect.any(String) },
        },
      },
    });
    const invokeConfig = Object.values(synthesized.findResources('AWS::Lambda::EventInvokeConfig'));
    expect(invokeConfig).toHaveLength(1);
    expect(invokeConfig[0].Properties.MaximumEventAgeInSeconds).toBe(300);

    const roles = Object.values(synthesized.findResources('AWS::IAM::Role'));
    expect(roles.some((resource) => resource.Properties.RoleName === AGENT_RUNTIME_ROLE_NAME)).toBe(
      true,
    );
    expect(
      roles.some((resource) => resource.Properties.RoleName === STARTER_LAMBDA_ROLE_NAME),
    ).toBe(true);
    const starterRoleEntry = Object.entries(synthesized.findResources('AWS::IAM::Role')).find(
      ([, resource]) => resource.Properties.RoleName === STARTER_LAMBDA_ROLE_NAME,
    );
    const runnerRoleEntry = Object.entries(synthesized.findResources('AWS::IAM::Role')).find(
      ([, resource]) => resource.Properties.RoleName === AGENT_RUNTIME_ROLE_NAME,
    );
    const rolePolicies = Object.values(synthesized.findResources('AWS::IAM::Policy'));
    const starterPolicy = rolePolicies.find((resource) =>
      resource.Properties.Roles.some(
        (role: { Ref?: string }) => role.Ref === starterRoleEntry?.[0],
      ),
    );
    const runnerPolicy = rolePolicies.find((resource) =>
      resource.Properties.Roles.some((role: { Ref?: string }) => role.Ref === runnerRoleEntry?.[0]),
    );
    const starterPolicyJson = JSON.stringify(starterPolicy?.Properties.PolicyDocument);
    expect(starterPolicyJson).toContain('bedrock-agentcore:InvokeAgentRuntime');
    expect(starterPolicyJson).toContain(
      'runtime/prompt_runner_game_agent_runtime-*/runtime-endpoint/*',
    );
    expect(JSON.stringify(runnerPolicy?.Properties.PolicyDocument)).toContain(
      'bedrock:InvokeModel',
    );
    const runtimeLogPolicyJson = JSON.stringify(runnerPolicy?.Properties.PolicyDocument);
    expect(runtimeLogPolicyJson).toContain('dynamodb:ConditionCheckItem');
    expect(runtimeLogPolicyJson).toContain('logs:DescribeLogStreams');
    expect(runtimeLogPolicyJson).toContain('logs:DescribeLogGroups');
    expect(runtimeLogPolicyJson).toContain('logs:PutResourcePolicy');
    expect(runtimeLogPolicyJson).toContain(
      '/aws/bedrock-agentcore/runtimes/prompt_runner_game_agent_runtime-*',
    );
    const runtimeLogStatements = (
      runnerPolicy?.Properties.PolicyDocument as {
        Statement: Array<{
          Sid?: string;
          Action?: unknown;
          Resource?: unknown;
          Condition?: unknown;
        }>;
      }
    ).Statement;
    expect(
      runtimeLogStatements.find((statement) => statement.Sid === 'ReadWriteAttemptRecords'),
    ).toEqual(
      expect.objectContaining({
        Action: expect.arrayContaining([
          'dynamodb:GetItem',
          'dynamodb:ConditionCheckItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:Query',
        ]),
      }),
    );
    expect(
      runtimeLogStatements.find((statement) => statement.Sid === 'RuntimeLogResourcePolicy'),
    ).toEqual(
      expect.objectContaining({
        Resource: '*',
        Condition: { StringEquals: { 'aws:RequestedRegion': 'us-east-1' } },
      }),
    );
    const runnerPolicyJson = JSON.stringify(runnerPolicy?.Properties.PolicyDocument);
    for (const profile of MODEL_CATALOG) {
      expect(runnerPolicyJson).toContain(`inference-profile/${profile.modelId}`);
      expect(
        runnerPolicyJson.match(
          new RegExp(`foundation-model/${foundationModelIdFor(profile)}(?=")`, 'gu'),
        ),
      ).toHaveLength(3);
    }
    expect(runnerPolicyJson).not.toContain('inference-profile/*');
    expect(runnerPolicyJson).not.toContain('gpt-6');
    expect(runnerPolicyJson).not.toContain('claude-sonnet-5-v1');
    expect(JSON.stringify(runnerPolicy?.Properties.PolicyDocument)).not.toContain(
      'bedrock-agentcore:InvokeAgentRuntime',
    );
    const api = functions.find(
      (resource) => resource.Properties.FunctionName === DRAFT_LAMBDA_NAME,
    );
    expect(api?.Properties.Environment.Variables).toMatchObject({
      ATTEMPT_BODIES_BUCKET: { Ref: expect.any(String) },
      STARTER_FUNCTION_NAME: { Ref: expect.any(String) },
    });
    expect(api?.DependsOn).toEqual(expect.arrayContaining([runtimeEntry[0]]));
    const runnerPolicyEntry = Object.entries(synthesized.findResources('AWS::IAM::Policy')).find(
      ([, resource]) =>
        resource.Properties.Roles.some(
          (role: { Ref?: string }) => role.Ref === runnerRoleEntry?.[0],
        ),
    );
    expect(runtime.DependsOn).toEqual(
      expect.arrayContaining([runnerRoleEntry?.[0], runnerPolicyEntry?.[0]]),
    );
  });
});
