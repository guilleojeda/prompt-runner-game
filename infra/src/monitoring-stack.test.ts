import * as cdk from 'aws-cdk-lib';
import { aws_cognito as cognito } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as crypto from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import { PromptRunnerMonitoringStack } from './monitoring-stack.js';
import { APPLICATION_ACCOUNT, APPLICATION_REGION } from './stack.js';

// Fictitious acceptance credential. Never the operator's real password/verifier.
const password = 'fixture-only-password';
const verifier = crypto.createHash('sha256').update(`monitor:${password}`).digest('hex');

describe('protected monitoring publication', { timeout: 15_000 }, () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const sources = new cdk.Stack(app, 'ExistingGameSources', {
      env: { account: APPLICATION_ACCOUNT, region: APPLICATION_REGION },
    });
    const userPool = cognito.UserPool.fromUserPoolId(sources, 'Pool', 'us-east-1_existing');
    template = Template.fromStack(
      new PromptRunnerMonitoringStack(app, 'PromptRunnerMonitoring', {
        env: { account: APPLICATION_ACCOUNT, region: APPLICATION_REGION },
        userPool,
        authVerifier: verifier,
        buildRevision: 'acceptance-revision',
      }),
    );
  });

  it('protects the page, every asset behavior and the uncached API before origin access', () => {
    const distributions = Object.values(template.findResources('AWS::CloudFront::Distribution'));
    expect(distributions).toHaveLength(1);
    const config = distributions[0].Properties.DistributionConfig;
    const behaviors = [config.DefaultCacheBehavior, ...(config.CacheBehaviors ?? [])];
    expect(behaviors.some((behavior) => behavior.PathPattern === 'api/*')).toBe(true);
    for (const behavior of behaviors) {
      expect(behavior.ViewerProtocolPolicy).toBe('redirect-to-https');
      expect(behavior.FunctionAssociations).toEqual([
        { EventType: 'viewer-request', FunctionARN: expect.anything() },
      ]);
    }
    expect(
      new Set(behaviors.map((behavior) => JSON.stringify(behavior.FunctionAssociations))).size,
    ).toBe(1);
    const api = behaviors.find((behavior) => behavior.PathPattern === 'api/*');
    expect(api.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    expect(config.CustomErrorResponses ?? []).toHaveLength(0);
  });

  it('rejects missing or wrong credentials and strips valid Basic credentials before OAC', () => {
    const functions = Object.values(template.findResources('AWS::CloudFront::Function'));
    expect(functions).toHaveLength(1);
    const code = functions[0].Properties.FunctionCode as string;
    expect(code).not.toContain(password);
    expect(code).not.toContain(Buffer.from(`monitor:${password}`).toString('base64'));
    const invoke = (authorization?: string) => {
      const event = {
        request: {
          method: 'GET',
          uri: '/api/metrics',
          querystring: {},
          headers: authorization ? { authorization: { value: authorization } } : {},
          cookies: {},
        },
      };
      return runInNewContext(`${code}; handler(event)`, {
        event,
        Buffer,
        require: (name: string) => {
          if (name !== 'crypto') throw new Error(`Unexpected edge dependency ${name}`);
          return crypto;
        },
      });
    };
    for (const invalid of [
      undefined,
      '',
      'Bearer token',
      'Basic ???',
      `Basic ${Buffer.from('monitor:wrong').toString('base64')}`,
    ]) {
      const response = invoke(invalid);
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate'].value).toMatch(/^Basic /);
      expect(response.headers['cache-control'].value).toBe('no-store');
    }
    const allowed = invoke(`Basic ${Buffer.from(`monitor:${password}`).toString('base64')}`);
    expect(allowed.uri).toBe('/api/metrics');
    expect(allowed.headers.authorization).toBeUndefined();
  });

  it('keeps both origins private and authorizes Lambda only from its distribution', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    const bucketAllows = Object.values(template.findResources('AWS::S3::BucketPolicy')).flatMap(
      (resource) =>
        resource.Properties.PolicyDocument.Statement.filter(
          (statement: { Effect: string }) => statement.Effect === 'Allow',
        ),
    );
    expect(bucketAllows).toHaveLength(1);
    expect(bucketAllows[0]).toMatchObject({
      Principal: { Service: 'cloudfront.amazonaws.com' },
      Action: 's3:GetObject',
      Condition: { StringEquals: { 'AWS:SourceArn': expect.anything() } },
    });
    const oacs = Object.values(template.findResources('AWS::CloudFront::OriginAccessControl'));
    expect(oacs).toHaveLength(2);
    expect(
      oacs
        .map(
          (resource) => resource.Properties.OriginAccessControlConfig.OriginAccessControlOriginType,
        )
        .sort(),
    ).toEqual(['lambda', 's3']);
    for (const resource of oacs) {
      expect(resource.Properties.OriginAccessControlConfig).toMatchObject({
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      });
    }
    template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
    const permissions = Object.values(template.findResources('AWS::Lambda::Permission'));
    const distributionId = Object.keys(template.findResources('AWS::CloudFront::Distribution'))[0];
    expect(JSON.stringify(bucketAllows[0].Condition)).toContain(distributionId);
    expect(permissions.map((resource) => resource.Properties.Action).sort()).toEqual([
      'lambda:InvokeFunction',
      'lambda:InvokeFunctionUrl',
    ]);
    for (const permission of permissions) {
      expect(permission.Properties).toMatchObject({
        Principal: 'cloudfront.amazonaws.com',
        SourceArn: expect.anything(),
      });
      expect(JSON.stringify(permission.Properties.SourceArn)).toContain('distribution/');
      expect(JSON.stringify(permission.Properties.SourceArn)).toContain(distributionId);
    }
    template.resourceCountIs('AWS::Cognito::UserPool', 0);
    template.resourceCountIs('AWS::DynamoDB::Table', 0);
  });

  it('grants the metrics function only confirmed-account source reads and its own log writes', () => {
    const roles = template.findResources('AWS::IAM::Role');
    const metricsRole = Object.entries(roles).find(
      ([, resource]) =>
        resource.Properties.RoleName ===
        'prompt-runner-game-monitoring-metrics-execution-us-east-1',
    );
    expect(metricsRole).toBeDefined();
    const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter((resource) =>
      resource.Properties.Roles.some((role: { Ref?: string }) => role.Ref === metricsRole![0]),
    );
    const statements = policies.flatMap((resource) => resource.Properties.PolicyDocument.Statement);
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Action: 'cognito-idp:ListUsers',
          Resource: 'arn:aws:cognito-idp:us-east-1:387483252302:userpool/us-east-1_existing',
        }),
      ]),
    );
    const actions = statements.flatMap((statement: { Action: string | string[] }) =>
      [statement.Action].flat(),
    );
    expect(actions.filter((action: string) => !action.startsWith('logs:'))).toEqual([
      'cognito-idp:ListUsers',
    ]);
    expect(JSON.stringify(statements)).not.toContain('prompt-runner-game-draft-api');
    expect(JSON.stringify(statements)).not.toContain('prompt-runner-game-drafts');
  });
});
