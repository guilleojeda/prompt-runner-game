import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { PromptRunnerAccessStack } from './access-stack.js';
import { APPLICATION_ACCOUNT, APPLICATION_REGION } from './stack.js';

function resolvePolicyTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolvePolicyTokens);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (Object.keys(object).length === 1 && 'Ref' in object && object.Ref === 'AWS::Partition') {
      return 'aws';
    }
    if (Object.keys(object).length === 1 && 'Fn::Join' in object) {
      const join = object['Fn::Join'] as [string, unknown[]];
      return join[1].map(resolvePolicyTokens).join(join[0]);
    }
    return Object.fromEntries(
      Object.entries(object).map(([key, entry]) => [key, resolvePolicyTokens(entry)]),
    );
  }
  return value;
}

describe('PromptRunnerAccessStack', () => {
  it('restricts GitHub OIDC to the approved audience and main branch subject', () => {
    const app = new cdk.App();
    const stack = new PromptRunnerAccessStack(app, 'TestAccess', {
      env: { account: APPLICATION_ACCOUNT, region: APPLICATION_REGION },
      githubOidcProviderArn: `arn:aws:iam::${APPLICATION_ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`,
    });
    const synthesized = Template.fromStack(stack);

    const roles = synthesized.findResources('AWS::IAM::Role');
    const githubRoleEntry = Object.entries(roles).find(
      ([, resource]) =>
        resource.Properties.RoleName === 'prompt-runner-game-github-actions-deploy-us-east-1',
    );
    const githubRole = githubRoleEntry?.[1];
    expect(githubRole).toBeDefined();
    expect(githubRole?.Properties.AssumeRolePolicyDocument).toEqual({
      Statement: [
        {
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              'token.actions.githubusercontent.com:sub':
                'repo:guilleojeda@18320860/prompt-runner-game@1373331195:ref:refs/heads/main',
            },
          },
          Effect: 'Allow',
          Principal: {
            Federated:
              'arn:aws:iam::387483252302:oidc-provider/token.actions.githubusercontent.com',
          },
        },
      ],
      Version: '2012-10-17',
    });
    const policies = synthesized.findResources('AWS::IAM::Policy');
    expect(
      Object.values(policies).filter((resource) =>
        resource.Properties.Roles.some(
          (role: { Ref?: string }) => role.Ref === githubRoleEntry?.[0],
        ),
      ),
    ).toHaveLength(1);
    const githubPolicy = Object.values(policies).find((resource) =>
      resource.Properties.PolicyDocument.Statement.some(
        (statement: { Sid?: string }) => statement.Sid === 'AssumePhase0CdkBootstrapRoles',
      ),
    );
    expect(githubPolicy).toBeDefined();
    const assumeStatement = githubPolicy?.Properties.PolicyDocument.Statement.find(
      (statement: { Sid?: string }) => statement.Sid === 'AssumePhase0CdkBootstrapRoles',
    );
    expect(githubPolicy?.Properties.PolicyDocument.Statement).toHaveLength(1);
    expect(assumeStatement).toEqual({
      Sid: 'AssumePhase0CdkBootstrapRoles',
      Action: 'sts:AssumeRole',
      Effect: 'Allow',
      Resource: [
        {
          'Fn::Join': [
            '',
            [
              'arn:',
              { Ref: 'AWS::Partition' },
              ':iam::387483252302:role/cdk-hnb659fds-deploy-role-387483252302-us-east-1',
            ],
          ],
        },
        {
          'Fn::Join': [
            '',
            [
              'arn:',
              { Ref: 'AWS::Partition' },
              ':iam::387483252302:role/cdk-hnb659fds-file-publishing-role-387483252302-us-east-1',
            ],
          ],
        },
      ],
    });
    expect(githubRole?.Properties.Policies).toBeUndefined();
    expect(githubRole?.Properties.ManagedPolicyArns).toBeUndefined();
    expect(githubPolicy?.Properties.Roles).toEqual([{ Ref: githubRoleEntry?.[0] }]);
  });

  it('can create the provider with native IAM resources and no bootstrap dependency', () => {
    const app = new cdk.App();
    const stack = new PromptRunnerAccessStack(app, 'TestAccessNativeProvider', {
      env: { account: APPLICATION_ACCOUNT, region: APPLICATION_REGION },
    });
    const synthesized = Template.fromStack(stack);

    synthesized.hasResourceProperties('AWS::IAM::OIDCProvider', {
      Url: 'https://token.actions.githubusercontent.com',
      ClientIdList: ['sts.amazonaws.com'],
    });
    synthesized.resourceCountIs('AWS::CloudFormation::CustomResource', 0);
    expect(synthesized.toJSON().Parameters).toBeUndefined();
    expect(synthesized.toJSON().Rules).toBeUndefined();
    expect(
      Object.values(synthesized.toJSON().Resources).every(
        (resource) =>
          typeof resource === 'object' &&
          resource !== null &&
          'Type' in resource &&
          typeof resource.Type === 'string' &&
          (resource.Type.startsWith('AWS::IAM::') || resource.Type === 'AWS::CDK::Metadata'),
      ),
    ).toBe(true);
  });

  it('keeps the physical execution policy and grants only the configured Cognito lifecycle', () => {
    const app = new cdk.App();
    const stack = new PromptRunnerAccessStack(app, 'TestAccessPolicy', {
      env: { account: APPLICATION_ACCOUNT, region: APPLICATION_REGION },
      githubOidcProviderArn: `arn:aws:iam::${APPLICATION_ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`,
    });
    const synthesized = Template.fromStack(stack);
    const policies = synthesized.findResources('AWS::IAM::ManagedPolicy');
    const policy = Object.values(policies).find(
      (resource) =>
        resource.Properties.ManagedPolicyName === 'prompt-runner-game-phase0-cfn-execution',
    );
    expect(policy).toBeDefined();
    expect(policy?.Properties.Description).toBe(
      'Phase 0 CloudFormation execution permissions for hosting only.',
    );
    const resolvedDocument = resolvePolicyTokens(policy?.Properties.PolicyDocument);
    expect(JSON.stringify(resolvedDocument).length).toBeLessThanOrEqual(6144);

    const statements = policy?.Properties.PolicyDocument.Statement as Array<{
      Sid?: string;
      Action?: string | string[];
      Resource?: unknown;
      Condition?: Record<string, unknown>;
    }>;
    const bySid = (sid: string) => statements.find((statement) => statement.Sid === sid);
    expect(bySid('CognitoCreateUserPool')).toEqual(
      expect.objectContaining({
        Action: 'cognito-idp:CreateUserPool',
        Resource: '*',
        Condition: {
          StringEquals: {
            'aws:RequestTag/Application': 'prompt-runner-game',
            'aws:RequestedRegion': 'us-east-1',
          },
        },
      }),
    );
    expect(bySid('CognitoListUserPools')).toEqual(
      expect.objectContaining({
        Action: 'cognito-idp:ListUserPools',
        Resource: '*',
        Condition: { StringEquals: { 'aws:RequestedRegion': 'us-east-1' } },
      }),
    );

    for (const sid of ['CognitoUserPoolTagsOnCreate', 'CognitoManagedResources']) {
      const statement = bySid(sid);
      expect(statement).toBeDefined();
      expect(JSON.stringify(statement?.Resource)).toContain(
        ':cognito-idp:us-east-1:387483252302:userpool/*',
      );
      if (sid !== 'CognitoUserPoolTagsOnCreate') {
        expect(statement?.Condition).toEqual({
          StringEquals: { 'aws:ResourceTag/Application': 'prompt-runner-game' },
        });
      }
    }
    expect(bySid('CognitoDescribeUserPoolDomain')).toEqual(
      expect.objectContaining({
        Action: 'cognito-idp:DescribeUserPoolDomain',
        Resource: '*',
        Condition: { StringEquals: { 'aws:RequestedRegion': 'us-east-1' } },
      }),
    );

    const cognitoStatements = statements.filter((statement) =>
      statement.Sid?.startsWith('Cognito'),
    );
    const cognitoActions = cognitoStatements.flatMap((statement) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action],
    );
    expect(cognitoActions).toEqual(
      expect.arrayContaining([
        'cognito-idp:CreateUserPool',
        'cognito-idp:DescribeUserPool',
        'cognito-idp:UpdateUserPool',
        'cognito-idp:DeleteUserPool',
        'cognito-idp:CreateUserPoolClient',
        'cognito-idp:DescribeUserPoolClient',
        'cognito-idp:UpdateUserPoolClient',
        'cognito-idp:DeleteUserPoolClient',
        'cognito-idp:CreateUserPoolDomain',
        'cognito-idp:DescribeUserPoolDomain',
        'cognito-idp:UpdateUserPoolDomain',
        'cognito-idp:DeleteUserPoolDomain',
        'cognito-idp:CreateManagedLoginBranding',
        'cognito-idp:DescribeManagedLoginBranding',
        'cognito-idp:DescribeManagedLoginBrandingByClient',
        'cognito-idp:UpdateManagedLoginBranding',
        'cognito-idp:DeleteManagedLoginBranding',
      ]),
    );
    expect(cognitoActions).not.toEqual(
      expect.arrayContaining([
        'iam:PassRole',
        'iam:CreateServiceLinkedRole',
        'kms:CreateGrant',
        'cloudfront:UpdateDistribution',
      ]),
    );
  });
});
