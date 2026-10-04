import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export const LIMIT_PARAMETER_PREFIX = '/prompt-runner-game/limits';

/** Values resolve in CloudFormation, never during synthesis or into CI artifacts. */
export function createPrivateLimits(scope: Construct) {
  const value = (id: string, key: string): string =>
    new cdk.CfnParameter(scope, id, {
      type: 'AWS::SSM::Parameter::Value<String>',
      default: `${LIMIT_PARAMETER_PREFIX}/${key}`,
      noEcho: true,
    }).valueAsString;
  const number = (id: string, key: string): number => cdk.Token.asNumber(value(id, key));
  return {
    savedRobots: value('SavedRobotsLimit', 'saved-robots'),
    activeGlobal: value('ActiveAttemptLimit', 'active-attempts'),
    dailyGlobalUsd: value('DailyGlobalBudget', 'daily-global-usd'),
    dailyUserUsd: value('DailyUserBudget', 'daily-user-usd'),
    rates: {
      input: value('InputTokenRate', 'token-input-usd-per-million'),
      output: value('OutputTokenRate', 'token-output-usd-per-million'),
      cacheRead: value('CacheReadTokenRate', 'token-cache-read-usd-per-million'),
      cacheWrite: value('CacheWriteTokenRate', 'token-cache-write-usd-per-million'),
    },
    apiThrottle: {
      rate: number('ApiRate', 'api-rate'),
      burst: number('ApiBurst', 'api-burst'),
      draftRate: number('DraftWriteRate', 'draft-write-rate'),
      draftBurst: number('DraftWriteBurst', 'draft-write-burst'),
      writeRate: number('ConfigurationWriteRate', 'configuration-write-rate'),
      writeBurst: number('ConfigurationWriteBurst', 'configuration-write-burst'),
      attemptRate: number('AttemptAdmissionRate', 'attempt-admission-rate'),
      attemptBurst: number('AttemptAdmissionBurst', 'attempt-admission-burst'),
      cancelRate: number('AttemptCancelRate', 'attempt-cancel-rate'),
      cancelBurst: number('AttemptCancelBurst', 'attempt-cancel-burst'),
    },
    identityRateLimit: number('IdentityOriginRate', 'identity-origin-rate'),
    billing: {
      monthlyUsd: value('MonthlyAccountBudget', 'monthly-account-usd'),
      monthlyThresholds: Array.from({ length: 6 }, (_, index) =>
        number(`MonthlyAlert${index + 1}`, `monthly-alert-${index + 1}`),
      ),
      recipient: value('BillingAlertRecipient', 'billing-alert-recipient'),
      bedrockServices: cdk.Fn.split(
        ',',
        value('BedrockBillingServices', 'bedrock-billing-services'),
      ),
    },
  };
}

export type PrivateLimits = ReturnType<typeof createPrivateLimits>;

export const executionLimitEnvironment = (
  limits: Pick<PrivateLimits, 'activeGlobal' | 'dailyGlobalUsd' | 'dailyUserUsd' | 'rates'>,
): Record<string, string> => ({
  ATTEMPT_ACTIVE_GLOBAL_LIMIT: limits.activeGlobal,
  BEDROCK_DAILY_GLOBAL_BUDGET_USD: limits.dailyGlobalUsd,
  BEDROCK_DAILY_USER_BUDGET_USD: limits.dailyUserUsd,
  BEDROCK_INPUT_USD_PER_MILLION_TOKENS: limits.rates.input,
  BEDROCK_OUTPUT_USD_PER_MILLION_TOKENS: limits.rates.output,
  BEDROCK_CACHE_READ_USD_PER_MILLION_TOKENS: limits.rates.cacheRead,
  BEDROCK_CACHE_WRITE_USD_PER_MILLION_TOKENS: limits.rates.cacheWrite,
});
