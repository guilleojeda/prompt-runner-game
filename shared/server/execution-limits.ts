import type { Usage } from './attempt.js';

export class AttemptCapacityError extends Error {
  public constructor() {
    super(
      'Hay una partida activa o no hay capacidad disponible. Podés retomarla o intentar más tarde.',
    );
    this.name = 'AttemptCapacityError';
  }
}

export class BudgetUnavailableError extends Error {
  public readonly code = 'inference_budget_unavailable';
  public constructor() {
    super('No se pueden iniciar más decisiones por ahora. Podés editar y consultar tus partidas.');
    this.name = 'BudgetUnavailableError';
  }
}

/** Private server configuration; monetary ledger values are integer millionths of USD. */
export type ExecutionLimits = Readonly<{
  globalActiveAttempts: number;
  globalDailyMicros: number;
  userDailyMicros: number;
  rates: TokenRates;
}>;

export type TokenRates = Readonly<{
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}>;

export type CallBudget = Readonly<{
  day: string;
  reservedMicros: number;
  settledMicros?: number;
  rates: TokenRates;
}>;

const positive = (value: string | undefined): number => {
  const parsed = Number(value);
  if (!value || !Number.isFinite(parsed) || parsed <= 0) throw new BudgetUnavailableError();
  return parsed;
};

/** No public defaults: deployment supplies every operational amount privately. */
export const readExecutionLimits = (env: NodeJS.ProcessEnv = process.env): ExecutionLimits => {
  const limits: ExecutionLimits = {
    globalActiveAttempts: positive(env.ATTEMPT_ACTIVE_GLOBAL_LIMIT),
    globalDailyMicros: Math.floor(positive(env.BEDROCK_DAILY_GLOBAL_BUDGET_USD) * 1_000_000),
    userDailyMicros: Math.floor(positive(env.BEDROCK_DAILY_USER_BUDGET_USD) * 1_000_000),
    rates: {
      input: positive(env.BEDROCK_INPUT_USD_PER_MILLION_TOKENS),
      output: positive(env.BEDROCK_OUTPUT_USD_PER_MILLION_TOKENS),
      cacheRead: positive(env.BEDROCK_CACHE_READ_USD_PER_MILLION_TOKENS),
      cacheWrite: positive(env.BEDROCK_CACHE_WRITE_USD_PER_MILLION_TOKENS),
    },
  };
  if (
    !Number.isSafeInteger(limits.globalActiveAttempts) ||
    !Number.isSafeInteger(limits.globalDailyMicros) ||
    !Number.isSafeInteger(limits.userDailyMicros)
  )
    throw new BudgetUnavailableError();
  return limits;
};

/** CountTokens input and output bound, priced conservatively across possible cache categories. */
export const reserveCallCost = (
  inputTokens: number,
  maxOutputTokens: number,
  limits: ExecutionLimits,
): number => {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw new BudgetUnavailableError();
  const micros = Math.ceil(
    inputTokens * Math.max(limits.rates.input, limits.rates.cacheWrite, limits.rates.cacheRead) +
      maxOutputTokens * limits.rates.output,
  );
  if (!Number.isSafeInteger(micros) || micros <= 0) throw new BudgetUnavailableError();
  return micros;
};

/** Normalized input includes cache exactly once; reasoning is a subset of output. */
export const measuredCallCost = (usage: Usage, rates: TokenRates): number | undefined => {
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  if (
    input === null ||
    output === null ||
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    input < 0 ||
    output < 0
  )
    return undefined;
  // Bedrock reports ordinary input separately from cache input. When a cache
  // counter is absent, normalized input can omit an unknown cache volume, so
  // no measured total can safely replace the reservation.
  if (usage.cacheReadTokens === null || usage.cacheWriteTokens === null) return undefined;
  const read = usage.cacheReadTokens;
  const write = usage.cacheWriteTokens;
  if (
    !Number.isSafeInteger(read) ||
    !Number.isSafeInteger(write) ||
    read < 0 ||
    write < 0 ||
    read + write > input
  )
    return undefined;
  const micros = Math.ceil(
    (input - read - write) * rates.input +
      read * rates.cacheRead +
      write * rates.cacheWrite +
      output * rates.output,
  );
  return Number.isSafeInteger(micros) ? micros : undefined;
};
