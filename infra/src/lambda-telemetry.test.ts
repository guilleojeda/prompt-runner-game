import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { PromptRunnerAccessStack } from './access-stack.js';
import { PromptRunnerMonitoringStack } from './monitoring-stack.js';
import { APPLICATION_ACCOUNT, APPLICATION_REGION, PromptRunnerHostingStack } from './stack.js';

// Published AWS distro v0.13.0; this is deliberately independent of the product
// configuration so a wrong layer/wrapper cannot validate its own readback.
const layerArn = 'arn:aws:lambda:us-east-1:615299751070:layer:AWSOpenTelemetryDistroJs:16';
const functionNames = [
  'prompt-runner-game-draft-api',
  'prompt-runner-game-attempt-starter',
  'prompt-runner-game-monitoring-metrics',
];

describe('Lambda traces and correlated log delivery', { timeout: 15_000 }, () => {
  let hosting: Template;
  let monitoring: Template;
  let access: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const env = { account: APPLICATION_ACCOUNT, region: APPLICATION_REGION };
    const game = new PromptRunnerHostingStack(app, 'TelemetryGame', {
      env,
      assetDeploymentRoleArn: `arn:aws:iam::${APPLICATION_ACCOUNT}:role/prompt-runner-game-frontend-asset-deployment-us-east-1`,
      buildRevision: 'telemetry-acceptance',
    });
    const monitoringProps = {
      env,
      userPool: game.userPool,
      draftTable: game.draftTable,
      // Same fictitious verifier used by the pull-request verification workflow.
      authVerifier: 'a8b72980f5f7bd9fa1ac542c5608252885ff846c0bfdda2e07750608c55ac64f',
      apiKeyVerifier: 'b7c9d143f3da3e38793d79c2088ae9fb58e5ce752d8b7c4ca1c432d4fa6e0b79',
      buildRevision: 'telemetry-acceptance',
    };
    const monitor = new PromptRunnerMonitoringStack(app, 'TelemetryMonitoring', monitoringProps);
    const permissions = new PromptRunnerAccessStack(app, 'TelemetryAccess', {
      env,
      githubOidcProviderArn: `arn:aws:iam::${APPLICATION_ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`,
    });
    hosting = Template.fromStack(game);
    monitoring = Template.fromStack(monitor);
    access = Template.fromStack(permissions);
  }, 15_000);

  it.each(functionNames)('enables traces and JSON logs without OTel metrics for %s', (name) => {
    const template = name.endsWith('monitoring-metrics') ? monitoring : hosting;
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: name,
      Runtime: 'nodejs22.x',
      TracingConfig: { Mode: 'Active' },
      Layers: [layerArn],
      LoggingConfig: { LogFormat: 'JSON' },
      Environment: {
        Variables: Match.objectLike({
          AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-instrument',
          OTEL_AWS_APPLICATION_SIGNALS_ENABLED: 'false',
          OTEL_METRICS_EXPORTER: 'none',
          OTEL_LOGS_EXPORTER: 'none',
          OTEL_TRACES_EXPORTER: 'otlp',
          OTEL_NODE_ENABLED_INSTRUMENTATIONS: 'aws-lambda',
          OTEL_NODE_DISABLED_INSTRUMENTATIONS: 'aws-sdk,http',
          AWS_REDACT_SPAN_ATTRIBUTES: 'url.full',
        }),
      },
    });
    const fn = Object.values(template.findResources('AWS::Lambda::Function')).find(
      (resource) => resource.Properties.FunctionName === name,
    );
    expect(fn?.Properties.Environment.Variables).not.toHaveProperty(
      'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
    );
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: `/aws/lambda/${name}`,
      RetentionInDays: 30,
    });
  });

  it.each(functionNames)('allows %s to publish traces through its own role', (name) => {
    const template = name.endsWith('monitoring-metrics') ? monitoring : hosting;
    const fn = Object.values(template.findResources('AWS::Lambda::Function')).find(
      (resource) => resource.Properties.FunctionName === name,
    );
    const role = fn?.Properties.Role['Fn::GetAtt'][0];
    expect(role).toBeTypeOf('string');
    template.hasResourceProperties('AWS::IAM::Policy', {
      Roles: [Match.objectEquals({ Ref: role })],
      PolicyDocument: {
        Statement: Match.arrayWith([
          {
            Effect: 'Allow',
            Action: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
            Resource: '*',
          },
        ]),
      },
    });
  });

  it('lets the existing CloudFormation execution role read only the pinned public layer', () => {
    access.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      Roles: [`cdk-hnb659fds-cfn-exec-role-${APPLICATION_ACCOUNT}-${APPLICATION_REGION}`],
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 'lambda:GetLayerVersion',
            Resource: layerArn,
          }),
        ]),
      },
    });
  });

  it('keeps deployment helpers and AgentCore outside Lambda instrumentation', () => {
    for (const template of [hosting, monitoring]) {
      for (const resource of Object.values(template.findResources('AWS::Lambda::Function'))) {
        if (functionNames.includes(resource.Properties.FunctionName)) continue;
        expect(resource.Properties.TracingConfig?.Mode).not.toBe('Active');
        expect(resource.Properties.Environment?.Variables ?? {}).not.toHaveProperty(
          'AWS_LAMBDA_EXEC_WRAPPER',
        );
        expect(resource.Properties.Layers ?? []).not.toContain(layerArn);
      }
    }
    const runtime = Object.values(hosting.findResources('AWS::BedrockAgentCore::Runtime'))[0];
    expect(
      Object.keys(runtime.Properties.EnvironmentVariables).filter((key) =>
        /^(?:OTEL_|AWS_LAMBDA_EXEC_WRAPPER)/u.test(key),
      ),
    ).toEqual([]);
  });
});
