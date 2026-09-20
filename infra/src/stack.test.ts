import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { APPLICATION_ACCOUNT, APPLICATION_REGION, PromptRunnerHostingStack } from './stack.js';

function template() {
  const app = new cdk.App();
  const stack = new PromptRunnerHostingStack(app, 'TestHosting', {
    env: { account: APPLICATION_ACCOUNT, region: APPLICATION_REGION },
    assetDeploymentRoleArn: `arn:aws:iam::${APPLICATION_ACCOUNT}:role/prompt-runner-game-frontend-asset-deployment-us-east-1`,
    buildRevision: 'test-revision',
  });

  return Template.fromStack(stack);
}

describe('PromptRunnerHostingStack', () => {
  it('keeps the website bucket private and grants only the OAC read path', () => {
    const synthesized = template();

    synthesized.resourceCountIs('AWS::S3::Bucket', 1);
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
      EmailConfiguration: { EmailSendingAccount: 'COGNITO_DEFAULT' },
      Policies: { SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD'] } },
      UserPoolTier: 'ESSENTIALS',
      UsernameAttributes: ['email'],
      VerificationMessageTemplate: { DefaultEmailOption: 'CONFIRM_WITH_CODE' },
    });
    expect(pool.Properties.EmailConfiguration).toEqual({ EmailSendingAccount: 'COGNITO_DEFAULT' });
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
      AllowedOAuthScopes: ['openid', 'email'],
      GenerateSecret: false,
      ReadAttributes: ['email', 'email_verified'],
      SupportedIdentityProviders: ['COGNITO'],
      WriteAttributes: ['email'],
    });
    expect(client.Properties).not.toHaveProperty('ClientSecret');
    expect(client.Properties.CallbackURLs).toHaveLength(2);
    expect(client.Properties.LogoutURLs).toEqual(client.Properties.CallbackURLs);
    expect(client.Properties.CallbackURLs[1]).toBe('http://localhost:5173/');
    expect(client.Properties.CallbackURLs[0]).toEqual({
      'Fn::Join': ['', ['https://', { 'Fn::GetAtt': [expect.any(String), 'DomainName'] }, '/']],
    });

    synthesized.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'prompt-runner-game',
      ManagedLoginVersion: 2,
    });
    synthesized.hasResourceProperties('AWS::Cognito::ManagedLoginBranding', {
      UseCognitoProvidedValues: true,
    });
    const branding = Object.values(
      synthesized.findResources('AWS::Cognito::ManagedLoginBranding'),
    )[0];
    expect(branding.Properties).not.toHaveProperty('Settings');
    expect(branding.Properties).not.toHaveProperty('Assets');
  });

  it('uses the pre-created deployment role and publishes entry after assets', () => {
    const synthesized = template();

    synthesized.resourceCountIs('AWS::IAM::Role', 0);
    synthesized.resourceCountIs('Custom::CDKBucketDeployment', 2);
    const deployments = synthesized.findResources('Custom::CDKBucketDeployment');
    const deploymentProperties = Object.values(deployments).map((resource) => resource.Properties);
    expect(deploymentProperties).toHaveLength(2);
    expect(deploymentProperties.every((properties) => properties.ServiceToken)).toBe(true);
    expect(deploymentProperties.every((properties) => properties.Prune === false)).toBe(true);
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
      '<<marker:0xbaba:4>>': expect.anything(),
    });
    const authConfigMarkers = JSON.stringify(websiteEntry?.[1].Properties.SourceMarkers[1]);
    expect(authConfigMarkers).toContain('cognito-idp.us-east-1.amazonaws.com');
    expect(authConfigMarkers).toContain('.auth.us-east-1.amazoncognito.com');
    expect(authConfigMarkers).not.toContain('.amazoncognito.com/');
    expect(websiteEntry?.[1].Properties.DistributionPaths).toContain('/auth-config.json');
    expect(JSON.stringify(websiteEntry?.[1].Properties.SourceMarkers[1])).not.toContain(
      'ClientSecret',
    );
    const functions = synthesized.findResources('AWS::Lambda::Function');
    expect(Object.values(functions)).toHaveLength(1);
    expect(Object.values(functions)[0].Properties).toMatchObject({
      Role: 'arn:aws:iam::387483252302:role/prompt-runner-game-frontend-asset-deployment-us-east-1',
    });
    synthesized.hasOutput('BuildRevision', { Value: 'test-revision' });
  });
});
