import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { PromptRunnerAccessStack } from './access-stack.js';
import { APPLICATION_ACCOUNT, APPLICATION_REGION, websiteBucketNameFor } from './stack.js';

// Acceptance of the monitor's deployment preparation, not its runtime role.
const bucket = `prompt-runner-game-monitoring-${APPLICATION_ACCOUNT}-${APPLICATION_REGION}`;
const functionArn = `arn:aws:lambda:${APPLICATION_REGION}:${APPLICATION_ACCOUNT}:function:prompt-runner-game-monitoring-metrics`;
const roleArn = `arn:aws:iam::${APPLICATION_ACCOUNT}:role/prompt-runner-game-monitoring-metrics-execution-us-east-1`;
const publisherName = 'prompt-runner-game-monitoring-asset-deployment-us-east-1';
const bootstrapName = `cdk-hnb659fds-cfn-exec-role-${APPLICATION_ACCOUNT}-${APPLICATION_REGION}`;

interface Statement {
  Action: string | string[];
  Resource: string | string[];
  Effect: string;
  Condition?: Record<string, unknown>;
}

function resolve(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolve);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (object.Ref === 'AWS::Partition') return 'aws';
    if ('Fn::Join' in object) {
      const [separator, parts] = object['Fn::Join'] as [string, unknown[]];
      return parts.map(resolve).join(separator);
    }
    return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, resolve(entry)]));
  }
  return value;
}

describe('monitoring deployment access', { timeout: 15_000 }, () => {
  let template: Template;

  beforeAll(() => {
    template = Template.fromStack(
      new PromptRunnerAccessStack(new cdk.App(), 'MonitoringAccessAcceptance', {
        env: { account: APPLICATION_ACCOUNT, region: APPLICATION_REGION },
        githubOidcProviderArn: `arn:aws:iam::${APPLICATION_ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`,
      }),
    );
  });

  function monitoringPolicy() {
    const policies = Object.values(template.findResources('AWS::IAM::ManagedPolicy'));
    const policy = policies.find(
      (resource) =>
        resource.Properties.ManagedPolicyName === 'prompt-runner-game-monitoring-cfn-execution',
    );
    expect(
      policy,
      'the existing bootstrap role needs monitor deployment permissions',
    ).toBeDefined();
    return policy!;
  }

  it('attaches a bounded complementary policy without replacing the existing hosting policy', () => {
    const policy = monitoringPolicy();
    expect(policy.Properties.Roles).toEqual([bootstrapName]);
    const document = resolve(policy.Properties.PolicyDocument) as { Statement: Statement[] };
    expect(JSON.stringify(document).length).toBeLessThanOrEqual(6144);
    for (const statement of document.Statement) {
      expect([statement.Action].flat()).not.toContain('*');
      expect([statement.Resource].flat()).not.toContain('*');
    }
    const hosting = Object.values(template.findResources('AWS::IAM::ManagedPolicy')).find(
      (resource) =>
        resource.Properties.ManagedPolicyName === 'prompt-runner-game-phase0-cfn-execution',
    );
    expect(hosting?.Properties.Description).toBe(
      'Phase 0 CloudFormation execution permissions for hosting only.',
    );
  });

  it('permits the exact auth function, metrics URL lifecycle and restricted PassRole', () => {
    const policy = monitoringPolicy();
    const { Statement: statements } = resolve(policy.Properties.PolicyDocument) as {
      Statement: Statement[];
    };
    const statementsFor = (resource: string) =>
      statements.filter((statement) => [statement.Resource].flat().includes(resource));
    const authArn = `arn:aws:cloudfront::${APPLICATION_ACCOUNT}:function/prompt-runner-game-monitoring-auth`;
    const auth = statementsFor(authArn).flatMap((statement) => [statement.Action].flat());
    expect(auth).toEqual(
      expect.arrayContaining(['cloudfront:CreateFunction', 'cloudfront:PublishFunction']),
    );
    const urlActions = statementsFor(functionArn).flatMap((statement) => [statement.Action].flat());
    expect(urlActions).toEqual(
      expect.arrayContaining([
        'lambda:CreateFunction',
        'lambda:CreateFunctionUrlConfig',
        'lambda:UpdateFunctionUrlConfig',
        'lambda:DeleteFunctionUrlConfig',
        'lambda:AddPermission',
        'lambda:RemovePermission',
      ]),
    );
    for (const statement of statements.filter((entry) =>
      [entry.Action].flat().includes('iam:PassRole'),
    )) {
      expect(statement.Condition).toEqual({
        StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' },
      });
    }
    expect(statementsFor(roleArn).flatMap((statement) => [statement.Action].flat())).toEqual(
      expect.arrayContaining(['iam:CreateRole', 'iam:PutRolePolicy', 'iam:PassRole']),
    );
  });

  it('prepares a publisher for only the monitor bucket without changing the game publisher', () => {
    const roles = template.findResources('AWS::IAM::Role');
    const publisher = Object.entries(roles).find(
      ([, resource]) => resource.Properties.RoleName === publisherName,
    );
    expect(publisher).toBeDefined();
    expect(publisher![1].Properties.AssumeRolePolicyDocument.Statement).toEqual([
      {
        Action: 'sts:AssumeRole',
        Effect: 'Allow',
        Principal: { Service: 'lambda.amazonaws.com' },
      },
    ]);
    const attached = Object.values(template.findResources('AWS::IAM::Policy')).filter((resource) =>
      resource.Properties.Roles.some((role: { Ref?: string }) => role.Ref === publisher![0]),
    );
    const statements = attached.flatMap(
      (resource) =>
        (resolve(resource.Properties.PolicyDocument) as { Statement: Statement[] }).Statement,
    );
    for (const action of ['s3:GetObject', 's3:PutObject', 's3:DeleteObject']) {
      const monitorObjectActions = statements
        .filter((statement) => [statement.Resource].flat().includes(`arn:aws:s3:::${bucket}/*`))
        .flatMap((statement) => [statement.Action].flat());
      expect(monitorObjectActions).toContain(action);
    }
    expect(JSON.stringify(statements)).not.toContain(websiteBucketNameFor(APPLICATION_ACCOUNT));
    expect(
      Object.values(roles).some(
        (resource) =>
          resource.Properties.RoleName === 'prompt-runner-game-frontend-asset-deployment-us-east-1',
      ),
    ).toBe(true);
  });
});
