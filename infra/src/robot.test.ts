import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { createAuthenticationResources } from './auth.js';
import { createRobotResources, DRAFT_LOG_GROUP_NAME } from './robot.js';

const privateLimits = {
  savedRobots: 'saved-robots-parameter',
  activeGlobal: 'active-attempts-parameter',
  dailyGlobalUsd: 'global-budget-parameter',
  dailyUserUsd: 'user-budget-parameter',
  rates: {
    input: 'input-token-rate-parameter',
    output: 'output-token-rate-parameter',
    cacheRead: 'cache-read-token-rate-parameter',
    cacheWrite: 'cache-write-token-rate-parameter',
  },
  apiThrottle: {
    rate: 19,
    burst: 31,
    draftRate: 7,
    draftBurst: 9,
    writeRate: 5,
    writeBurst: 8,
    attemptRate: 3,
    attemptBurst: 6,
    cancelRate: 11,
    cancelBurst: 13,
  },
};

const synthesizeRobotResources = () => {
  const stack = new cdk.Stack();
  const authentication = createAuthenticationResources(stack, {
    region: 'us-east-1',
    productionWebOrigin: 'https://game.example.test/',
    identityRateLimit: 37,
  });
  createRobotResources(stack, {
    authentication,
    productionWebOrigin: 'https://game.example.test',
    limits: privateLimits,
  });
  return Template.fromStack(stack);
};

// Match the existing infrastructure suites' CDK startup allowance.
describe('robot infrastructure', { timeout: 15_000 }, () => {
  it('sets operational log retention to thirty days', () => {
    const template = synthesizeRobotResources();

    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: DRAFT_LOG_GROUP_NAME,
      RetentionInDays: 30,
    });
  });

  it('passes private execution limits to the API Lambda without adding defaults', () => {
    const template = synthesizeRobotResources();

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'prompt-runner-game-draft-api',
      Environment: {
        Variables: Match.objectLike({
          SAVED_ROBOTS_LIMIT: 'saved-robots-parameter',
          ATTEMPT_ACTIVE_GLOBAL_LIMIT: 'active-attempts-parameter',
          BEDROCK_DAILY_GLOBAL_BUDGET_USD: 'global-budget-parameter',
          BEDROCK_DAILY_USER_BUDGET_USD: 'user-budget-parameter',
          BEDROCK_INPUT_USD_PER_MILLION_TOKENS: 'input-token-rate-parameter',
          BEDROCK_OUTPUT_USD_PER_MILLION_TOKENS: 'output-token-rate-parameter',
          BEDROCK_CACHE_READ_USD_PER_MILLION_TOKENS: 'cache-read-token-rate-parameter',
          BEDROCK_CACHE_WRITE_USD_PER_MILLION_TOKENS: 'cache-write-token-rate-parameter',
        }),
      },
    });
  });

  it('sets stage throttles and stricter write overrides while keeping cancellation independent', () => {
    const template = synthesizeRobotResources();
    const stages = Object.values(template.findResources('AWS::ApiGatewayV2::Stage'));
    expect(stages).toHaveLength(1);
    expect(stages[0].Properties).toMatchObject({
      StageName: '$default',
      AutoDeploy: true,
      DefaultRouteSettings: {
        ThrottlingRateLimit: privateLimits.apiThrottle.rate,
        ThrottlingBurstLimit: privateLimits.apiThrottle.burst,
      },
      RouteSettings: {
        'PUT /draft': {
          ThrottlingRateLimit: privateLimits.apiThrottle.draftRate,
          ThrottlingBurstLimit: privateLimits.apiThrottle.draftBurst,
        },
        'PUT /robots/{uuid}': {
          ThrottlingRateLimit: privateLimits.apiThrottle.writeRate,
          ThrottlingBurstLimit: privateLimits.apiThrottle.writeBurst,
        },
        'DELETE /robots/{uuid}': {
          ThrottlingRateLimit: privateLimits.apiThrottle.writeRate,
          ThrottlingBurstLimit: privateLimits.apiThrottle.writeBurst,
        },
        'POST /attempts': {
          ThrottlingRateLimit: privateLimits.apiThrottle.attemptRate,
          ThrottlingBurstLimit: privateLimits.apiThrottle.attemptBurst,
        },
        'POST /attempts/{attemptId}/cancel': {
          ThrottlingRateLimit: privateLimits.apiThrottle.cancelRate,
          ThrottlingBurstLimit: privateLimits.apiThrottle.cancelBurst,
        },
      },
    });
    expect(stages[0].Properties.RouteSettings).not.toHaveProperty('GET /attempts/{attemptId}');
  });
});
