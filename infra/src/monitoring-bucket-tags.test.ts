import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { PromptRunnerAccessStack } from './access-stack.js';
import { APPLICATION_ACCOUNT, APPLICATION_REGION } from './stack.js';
import { monitoringBucketNameFor } from './monitoring-constants.js';

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

describe('monitoring bucket tag permissions', { timeout: 15_000 }, () => {
  let statements: Array<{ Sid: string; Action: string | string[]; Resource: string | string[] }>;

  beforeAll(() => {
    const template = Template.fromStack(
      new PromptRunnerAccessStack(new cdk.App(), 'MonitoringBucketTags', {
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

  it('grants CloudFormation S3 tag APIs only on the monitoring bucket', () => {
    const bucketArn = `arn:aws:s3:::${monitoringBucketNameFor(APPLICATION_ACCOUNT, APPLICATION_REGION)}`;
    const statement = statements.find((entry) => entry.Sid === 'MonitoringBucketLifecycle');

    expect(statement).toBeDefined();
    expect([statement!.Action].flat()).toEqual(
      expect.arrayContaining(['s3:TagResource', 's3:UntagResource']),
    );
    expect(resolve(statement!.Resource)).toBe(bucketArn);
  });
});
