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
    const functions = synthesized.findResources('AWS::Lambda::Function');
    expect(Object.values(functions)).toHaveLength(1);
    expect(Object.values(functions)[0].Properties).toMatchObject({
      Role: 'arn:aws:iam::387483252302:role/prompt-runner-game-frontend-asset-deployment-us-east-1',
    });
    synthesized.hasOutput('BuildRevision', { Value: 'test-revision' });
  });
});
