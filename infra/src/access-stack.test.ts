import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { PromptRunnerAccessStack } from './access-stack.js';
import { APPLICATION_ACCOUNT, APPLICATION_REGION } from './stack.js';

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
    expect(JSON.stringify(synthesized.toJSON())).not.toContain('cdk-bootstrap');
  });
});
