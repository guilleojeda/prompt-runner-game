import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { PromptRunnerAccessStack } from './access-stack.js';
import { APPLICATION_ACCOUNT, APPLICATION_REGION } from './stack.js';
import {
  AGENT_RUNTIME_NAME,
  AGENT_RUNTIME_ROLE_NAME,
  STARTER_LAMBDA_ROLE_NAME,
  STARTER_LOG_GROUP_NAME,
  attemptBodiesBucketNameFor,
} from './execution.js';
import { STARTER_LAMBDA_NAME } from './robot.js';

// CDK's first template synthesis pays one-time construct startup cost; this
// timeout gives infrastructure assertions room for that cost without changing
// the repository-wide test timeout or implying a deployment SLA.
const CDK_SYNTH_STARTUP_TIMEOUT_MS = 15_000;

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

describe('PromptRunnerAccessStack', { timeout: CDK_SYNTH_STARTUP_TIMEOUT_MS }, () => {
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

  it('keeps the phase 0 policy within IAM limits and attaches robot permissions to bootstrap', () => {
    const app = new cdk.App();
    const stack = new PromptRunnerAccessStack(app, 'TestAccessPhase2', {
      env: { account: APPLICATION_ACCOUNT, region: APPLICATION_REGION },
      githubOidcProviderArn: `arn:aws:iam::${APPLICATION_ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`,
    });
    const synthesized = Template.fromStack(stack);
    const policies = synthesized.findResources('AWS::IAM::ManagedPolicy');
    const phase0 = Object.values(policies).find(
      (resource) =>
        resource.Properties.ManagedPolicyName === 'prompt-runner-game-phase0-cfn-execution',
    );
    const phase2 = Object.values(policies).find(
      (resource) =>
        resource.Properties.ManagedPolicyName === 'prompt-runner-game-robot-cfn-execution',
    );

    expect(phase0).toBeDefined();
    expect(phase2).toBeDefined();
    expect(
      JSON.stringify(resolvePolicyTokens(phase0?.Properties.PolicyDocument)).length,
    ).toBeLessThanOrEqual(6144);
    expect(phase2?.Properties.Roles).toEqual([
      'cdk-hnb659fds-cfn-exec-role-387483252302-us-east-1',
    ]);
    const resolvedPhase2Document = resolvePolicyTokens(phase2?.Properties.PolicyDocument) as {
      Statement: Array<{
        Sid?: string;
        Action?: string | string[];
        Resource?: unknown;
      }>;
    };
    const statements = resolvedPhase2Document.Statement;
    const bySid = (sid: string) => statements.find((statement) => statement.Sid === sid);
    expect(bySid('DraftTableLifecycle')).toEqual(
      expect.objectContaining({
        Action: expect.arrayContaining([
          'dynamodb:CreateTable',
          'dynamodb:UpdateTable',
          'dynamodb:DescribeContinuousBackups',
          'dynamodb:DescribeContributorInsights',
          'dynamodb:DescribeKinesisStreamingDestination',
          'dynamodb:DescribeTimeToLive',
          'dynamodb:GetResourcePolicy',
        ]),
        Resource: 'arn:aws:dynamodb:us-east-1:387483252302:table/prompt-runner-game-drafts',
      }),
    );
    expect(bySid('DraftFunctionLifecycle')).toEqual(
      expect.objectContaining({
        Action: expect.arrayContaining(['lambda:Get*', 'lambda:UpdateFunctionCode']),
        Resource: expect.arrayContaining([
          'arn:aws:lambda:us-east-1:387483252302:function:prompt-runner-game-draft-api',
          'arn:aws:lambda:us-east-1:387483252302:function:prompt-runner-game-draft-api:*',
        ]),
      }),
    );
    expect(bySid('DraftHttpApi')).toEqual(
      expect.objectContaining({
        Action: expect.arrayContaining([
          'apigateway:GET',
          'apigateway:POST',
          'apigateway:PATCH',
          'apigateway:DELETE',
        ]),
      }),
    );
    expect(bySid('ReadDraftApiLogGroups')).toEqual(
      expect.objectContaining({
        Action: expect.arrayContaining([
          'logs:DescribeLogGroups',
          'logs:DescribeIndexPolicies',
          'logs:DescribeResourcePolicies',
        ]),
        Resource: '*',
        Condition: { StringEquals: { 'aws:RequestedRegion': 'us-east-1' } },
      }),
    );
    expect(bySid('ReadDraftApiLogGroupDetails')).toEqual(
      expect.objectContaining({
        Action: 'logs:GetDataProtectionPolicy',
        Resource:
          'arn:aws:logs:us-east-1:387483252302:log-group:/aws/lambda/prompt-runner-game-draft-api:*',
      }),
    );
    expect(bySid('ListDraftApiLogGroupTags')).toEqual(
      expect.objectContaining({
        Action: 'logs:ListTagsForResource',
        Resource:
          'arn:aws:logs:us-east-1:387483252302:log-group:/aws/lambda/prompt-runner-game-draft-api',
      }),
    );
    expect(bySid('TagDraftApiStages')).toEqual(
      expect.objectContaining({
        Action: ['apigateway:TagResource', 'apigateway:UntagResource'],
        Resource: expect.arrayContaining([
          'arn:aws:apigateway:us-east-1::/apis/*/stages',
          'arn:aws:apigateway:us-east-1::/apis/*/stages/*',
        ]),
      }),
    );
    expect(bySid('CognitoRobotResourceServer')).toEqual(
      expect.objectContaining({
        Action: expect.arrayContaining(['cognito-idp:CreateResourceServer']),
        Resource: 'arn:aws:cognito-idp:us-east-1:387483252302:userpool/*',
      }),
    );
  });

  it('keeps phase 3 CloudFormation access complementary and scoped by resource', () => {
    const app = new cdk.App();
    const stack = new PromptRunnerAccessStack(app, 'TestAccessPhase3', {
      env: { account: APPLICATION_ACCOUNT, region: APPLICATION_REGION },
      githubOidcProviderArn: `arn:aws:iam::${APPLICATION_ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`,
    });
    const synthesized = Template.fromStack(stack);
    const policies = synthesized.findResources('AWS::IAM::ManagedPolicy');
    const phase0 = Object.values(policies).find(
      (resource) =>
        resource.Properties.ManagedPolicyName === 'prompt-runner-game-phase0-cfn-execution',
    );
    const phase3 = Object.values(policies).find(
      (resource) =>
        resource.Properties.ManagedPolicyName === 'prompt-runner-game-phase3-cfn-execution',
    );
    const phase3Provider = Object.values(policies).find(
      (resource) =>
        resource.Properties.ManagedPolicyName ===
        'prompt-runner-game-phase3-agentcore-cfn-execution',
    );
    expect(phase0?.Properties.Description).toBe(
      'Phase 0 CloudFormation execution permissions for hosting only.',
    );
    expect(phase3).toBeDefined();
    expect(
      JSON.stringify(resolvePolicyTokens(phase3?.Properties.PolicyDocument)).length,
    ).toBeLessThanOrEqual(6144);
    expect(phase3Provider).toBeDefined();
    expect(
      JSON.stringify(resolvePolicyTokens(phase3Provider?.Properties.PolicyDocument)).length,
    ).toBeLessThanOrEqual(6144);
    expect(phase3?.Properties.Roles).toEqual([
      'cdk-hnb659fds-cfn-exec-role-387483252302-us-east-1',
    ]);
    const phase3Document = resolvePolicyTokens(phase3?.Properties.PolicyDocument) as {
      Statement: Array<{
        Sid?: string;
        Action?: string | string[];
        Resource?: unknown;
        Condition?: unknown;
      }>;
    };
    const providerDocument = resolvePolicyTokens(phase3Provider?.Properties.PolicyDocument) as {
      Statement: Array<{
        Sid?: string;
        Action?: string | string[];
        Resource?: unknown;
        Condition?: unknown;
      }>;
    };
    const statements = [...phase3Document.Statement, ...providerDocument.Statement];
    const bySid = (sid: string) => statements.find((statement) => statement.Sid === sid);
    expect(bySid('AttemptBodiesBucketLifecycle')).toEqual(
      expect.objectContaining({
        Action: expect.arrayContaining(['s3:CreateBucket', 's3:PutBucketPolicy']),
        Resource: `arn:aws:s3:::${attemptBodiesBucketNameFor(APPLICATION_ACCOUNT, APPLICATION_REGION)}`,
      }),
    );
    expect(bySid('StarterFunctionLifecycle')).toEqual(
      expect.objectContaining({
        Action: expect.arrayContaining([
          'lambda:CreateFunction',
          'lambda:UpdateFunctionCode',
          'lambda:PutFunctionEventInvokeConfig',
        ]),
        Resource: expect.arrayContaining([
          `arn:aws:lambda:us-east-1:387483252302:function:${STARTER_LAMBDA_NAME}`,
          `arn:aws:lambda:us-east-1:387483252302:function:${STARTER_LAMBDA_NAME}:*`,
        ]),
      }),
    );
    expect(bySid('PassStarterLambdaRole')).toEqual(
      expect.objectContaining({
        Resource: `arn:aws:iam::387483252302:role/${STARTER_LAMBDA_ROLE_NAME}`,
        Condition: { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } },
      }),
    );
    expect(bySid('StarterLogs')).toEqual(
      expect.objectContaining({
        Resource: expect.arrayContaining([
          `arn:aws:logs:us-east-1:387483252302:log-group:${STARTER_LOG_GROUP_NAME}`,
        ]),
      }),
    );
    expect(bySid('ReadStarterLogGroupDetails')).toEqual(
      expect.objectContaining({
        Action: 'logs:GetDataProtectionPolicy',
        Resource: `arn:aws:logs:us-east-1:387483252302:log-group:${STARTER_LOG_GROUP_NAME}:*`,
      }),
    );
    expect(bySid('ListStarterLogGroupTags')).toEqual(
      expect.objectContaining({
        Action: 'logs:ListTagsForResource',
        Resource: `arn:aws:logs:us-east-1:387483252302:log-group:${STARTER_LOG_GROUP_NAME}`,
      }),
    );
    expect(bySid('PassRuntimeRole')).toEqual(
      expect.objectContaining({
        Resource: `arn:aws:iam::387483252302:role/${AGENT_RUNTIME_ROLE_NAME}`,
        Condition: {
          StringEquals: { 'iam:PassedToService': 'bedrock-agentcore.amazonaws.com' },
        },
      }),
    );
    expect(bySid('CreateAgentRuntime')).toEqual(
      expect.objectContaining({
        Action: 'bedrock-agentcore:CreateAgentRuntime',
        Resource: '*',
        Condition: {
          StringEquals: {
            'aws:RequestTag/Application': 'prompt-runner-game',
            'aws:RequestedRegion': 'us-east-1',
          },
        },
      }),
    );
    expect(bySid('CreateAgentRuntimeEndpointForApplication')).toEqual(
      expect.objectContaining({
        Action: 'bedrock-agentcore:CreateAgentRuntimeEndpoint',
        Resource: 'arn:aws:bedrock-agentcore:us-east-1:387483252302:runtime/*',
        Condition: {
          StringEquals: {
            'aws:RequestTag/Application': 'prompt-runner-game',
            'aws:RequestedRegion': 'us-east-1',
          },
        },
      }),
    );
    expect(bySid('TagAgentRuntimeOnCreate')).toEqual(
      expect.objectContaining({
        Action: 'bedrock-agentcore:TagResource',
        Resource: [
          'arn:aws:bedrock-agentcore:us-east-1:387483252302:runtime/*',
          'arn:aws:bedrock-agentcore:us-east-1:387483252302:workload-identity-directory/default/workload-identity/*',
        ],
        Condition: {
          StringEquals: {
            'aws:RequestTag/Application': 'prompt-runner-game',
            'aws:RequestedRegion': 'us-east-1',
          },
        },
      }),
    );
    expect(bySid('TagAgentRuntimeDependencies')).toEqual(
      expect.objectContaining({
        Action: 'bedrock-agentcore:TagResource',
        Resource: expect.arrayContaining([
          `arn:aws:bedrock-agentcore:us-east-1:387483252302:runtime/${AGENT_RUNTIME_NAME}-*/runtime-endpoint/*`,
          `arn:aws:bedrock-agentcore:us-east-1:387483252302:workload-identity-directory/default/workload-identity/${AGENT_RUNTIME_NAME}-*`,
        ]),
      }),
    );
    expect(bySid('AgentRuntimeLifecycle')).toEqual(
      expect.objectContaining({
        Action: expect.arrayContaining([
          'bedrock-agentcore:GetAgentRuntime',
          'bedrock-agentcore:UpdateAgentRuntime',
        ]),
        Resource: `arn:aws:bedrock-agentcore:us-east-1:387483252302:runtime/${AGENT_RUNTIME_NAME}-*`,
      }),
    );
    expect(bySid('ProvisionAgentRuntimeDependencies')).toEqual(
      expect.objectContaining({
        Action: expect.arrayContaining([
          'bedrock-agentcore:GetAgentRuntimeEndpoint',
          'bedrock-agentcore:CreateWorkloadIdentity',
        ]),
        Resource: expect.arrayContaining([
          'arn:aws:bedrock-agentcore:us-east-1:387483252302:workload-identity-directory/default',
          `arn:aws:bedrock-agentcore:us-east-1:387483252302:workload-identity-directory/default/workload-identity/${AGENT_RUNTIME_NAME}-*`,
        ]),
      }),
    );
    expect(bySid('AgentRuntimeEndpointLifecycle')).toEqual(
      expect.objectContaining({
        Action: expect.arrayContaining([
          'bedrock-agentcore:DeleteAgentRuntimeEndpoint',
          'bedrock-agentcore:UpdateAgentRuntimeEndpoint',
        ]),
        Resource: expect.arrayContaining([
          `arn:aws:bedrock-agentcore:us-east-1:387483252302:runtime/${AGENT_RUNTIME_NAME}-*`,
          `arn:aws:bedrock-agentcore:us-east-1:387483252302:runtime/${AGENT_RUNTIME_NAME}-*/runtime-endpoint/*`,
        ]),
      }),
    );
    expect(bySid('AgentRuntimeWorkloadIdentityLifecycle')).toEqual(
      expect.objectContaining({
        Action: 'bedrock-agentcore:DeleteWorkloadIdentity',
        Resource: expect.arrayContaining([
          'arn:aws:bedrock-agentcore:us-east-1:387483252302:workload-identity-directory/default',
          `arn:aws:bedrock-agentcore:us-east-1:387483252302:workload-identity-directory/default/workload-identity/${AGENT_RUNTIME_NAME}-*`,
        ]),
      }),
    );
    expect(bySid('CreateAgentCoreServiceLinkedRole')).toEqual(
      expect.objectContaining({
        Action: 'iam:CreateServiceLinkedRole',
        Resource:
          'arn:aws:iam::387483252302:role/aws-service-role/runtime-identity.bedrock-agentcore.amazonaws.com/AWSServiceRoleForBedrockAgentCoreRuntimeIdentity',
        Condition: {
          StringEquals: {
            'iam:AWSServiceName': 'runtime-identity.bedrock-agentcore.amazonaws.com',
          },
        },
      }),
    );
    expect(bySid('ReadAgentRuntimeCodeAsset')).toEqual(
      expect.objectContaining({
        Action: ['s3:GetObject', 's3:GetObjectVersion'],
        Resource: 'arn:aws:s3:::cdk-hnb659fds-assets-387483252302-us-east-1/*',
      }),
    );
  });
});
