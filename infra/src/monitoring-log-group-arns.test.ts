import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { PromptRunnerAccessStack } from './access-stack.js';
import {
  MONITORING_ASSET_DEPLOYMENT_LOG_GROUP_NAME,
  MONITORING_METRICS_LOG_GROUP_NAME,
} from './monitoring-constants.js';
import { APPLICATION_ACCOUNT, APPLICATION_REGION } from './stack.js';

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

describe('monitoring log group IAM ARN forms', { timeout: 15_000 }, () => {
  let statements: Array<{ Sid: string; Action: string | string[]; Resource: string | string[] }>;

  beforeAll(() => {
    const template = Template.fromStack(
      new PromptRunnerAccessStack(new cdk.App(), 'MonitoringLogGroupArns', {
        env: { account: APPLICATION_ACCOUNT, region: APPLICATION_REGION },
      }),
    );
    const policy = Object.values(template.findResources('AWS::IAM::ManagedPolicy')).find(
      (resource) =>
        resource.Properties.ManagedPolicyName === 'prompt-runner-game-monitoring-cfn-execution',
    );
    expect(policy).toBeDefined();
    statements = (resolve(policy!.Properties.PolicyDocument) as { Statement: typeof statements })
      .Statement;
  });

  for (const [label, lifecycleSid, tagsSid, logGroupName] of [
    [
      'metrics',
      'MonitoringMetricsLogGroupLifecycle',
      'MonitoringMetricsLogGroupTags',
      MONITORING_METRICS_LOG_GROUP_NAME,
    ],
    [
      'asset deployment',
      'MonitoringAssetDeploymentLogGroupLifecycle',
      'MonitoringAssetDeploymentLogGroupTags',
      MONITORING_ASSET_DEPLOYMENT_LOG_GROUP_NAME,
    ],
  ]) {
    it(`uses the CloudWatch Logs lifecycle and tagging ARN forms for ${label}`, () => {
      const arn = `arn:aws:logs:${APPLICATION_REGION}:${APPLICATION_ACCOUNT}:log-group:${logGroupName}`;
      const lifecycle = statements.find((statement) => statement.Sid === lifecycleSid);
      const tags = statements.find((statement) => statement.Sid === tagsSid);

      expect(lifecycle).toBeDefined();
      expect([lifecycle!.Action].flat()).toEqual(
        expect.arrayContaining(['logs:CreateLogGroup', 'logs:DeleteLogGroup']),
      );
      expect(lifecycle!.Resource).toBe(`${arn}:*`);
      expect([lifecycle!.Action].flat()).not.toEqual(
        expect.arrayContaining(['logs:TagResource', 'logs:UntagResource']),
      );

      expect(tags).toBeDefined();
      expect([tags!.Action].flat()).toEqual(
        expect.arrayContaining([
          'logs:ListTagsForResource',
          'logs:TagResource',
          'logs:UntagResource',
        ]),
      );
      expect(tags!.Resource).toBe(arn);
    });
  }
});
