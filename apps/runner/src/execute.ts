import { createHash, randomUUID } from 'node:crypto';
import {
  createInitialState,
  LEVEL,
  normalizeSelection,
  observe,
  progressFor,
  resolveAction,
  type GameSnapshot,
  type LevelDefinition,
} from '../../../shared/game.js';
import type { ModelProfile } from '../../../shared/models.js';
import type { RobotSkillId } from '../../../shared/robot.js';
import type {
  ActionPublication,
  PersistedAttempt,
  AttemptSkill,
  AttemptStore,
  BodyStore,
  CallRecord,
  Usage,
} from '../../../shared/server/attempt.js';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

export type EngineAdapter = {
  readonly observe: (input: {
    readonly snapshot: unknown;
    readonly level: LevelDefinition;
    readonly skills: readonly AttemptSkill[];
  }) => JsonValue;
  readonly apply: (input: {
    readonly snapshot: unknown;
    readonly level: LevelDefinition;
    readonly skills: readonly AttemptSkill[];
    readonly action: { readonly name: string; readonly input: unknown };
    readonly seq: number;
    readonly maxTurns: number;
  }) => {
    readonly afterSnapshot: unknown;
    readonly beforeStateId: string;
    readonly afterStateId: string;
    readonly resolution: unknown;
    readonly normalizedAction: unknown;
    readonly terminalStatus?: 'victory' | 'defeat' | 'incomplete';
    readonly reason?: string;
    readonly progress: number;
    readonly finalSupport: number;
    readonly turnsUsed: number;
  };
};

export type DecisionTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
};

export type DecisionResult = {
  readonly action: { readonly name: string; readonly input: unknown };
  readonly usage?:
    | (Partial<Usage> & { readonly reasoningTokens?: number | null })
    | { readonly normalized?: Partial<Usage> & { readonly reasoningTokens?: number | null } };
};

export type DecisionAudit = {
  readonly beforeSend: (requestBytes: Uint8Array) => Promise<void>;
  readonly afterReceive: (receipt: {
    readonly bytes: Uint8Array | null;
    readonly statusCode: number | null;
    readonly requestId: string | null;
    readonly complete: boolean;
    readonly error?: { readonly name: string; readonly message: string };
  }) => Promise<void>;
};

export type InferenceAdapter = (input: {
  readonly instructions: string;
  readonly tools: readonly DecisionTool[];
  readonly observation: JsonValue;
  readonly modelConfig: Readonly<ModelProfile>;
  readonly audit: DecisionAudit;
  readonly timeoutMs?: number;
}) => Promise<DecisionResult>;

export type ExecuteAttemptDependencies = {
  readonly store: AttemptStore;
  readonly bodies: BodyStore;
  readonly infer: InferenceAdapter;
  readonly engine: EngineAdapter;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

type RuntimeLogValue = string | number | boolean;

const THROTTLE_RETRY_DELAY_MS = 60_000;
const THROTTLE_RETRY_CHECK_INTERVAL_MS = 5_000;
const MAX_THROTTLE_RETRIES_PER_DECISION = 2;

const runtimeEvent = (
  stage: string,
  fields: Record<string, RuntimeLogValue | undefined> = {},
): void => {
  console.log(
    JSON.stringify({
      component: 'attempt-runtime',
      stage,
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    }),
  );
};

/** Adapter over the authoritative deterministic game engine. */
export const createGameEngine = (): EngineAdapter => ({
  observe: ({ snapshot, level }) =>
    observe(snapshot as GameSnapshot, level) as unknown as JsonValue,
  apply: ({ snapshot, level, skills, action }) => {
    const current = snapshot as GameSnapshot;
    const selection = skills.map((skill) => ({
      id: skill.id as RobotSkillId,
      opaqueId: skill.opaqueId,
      enabled: true,
    }));
    const normalized = normalizeSelection(action.name, action.input, selection);
    const resolved = resolveAction(current, normalized, level);
    return {
      afterSnapshot: resolved.after,
      beforeStateId: resolved.before.id,
      afterStateId: resolved.after.id,
      resolution: resolved.resolution,
      normalizedAction: resolved.action,
      ...(resolved.after.status === 'running'
        ? {}
        : {
            terminalStatus: resolved.after.status,
            reason:
              resolved.after.status === 'victory'
                ? 'exit_reached'
                : resolved.after.status === 'incomplete'
                  ? 'turn_limit_reached'
                  : 'reason' in resolved.resolution
                    ? resolved.resolution.reason
                    : 'turn_limit_reached',
          }),
      progress: progressFor(resolved.after, level),
      finalSupport: resolved.after.support,
      turnsUsed: resolved.after.turnsUsed,
    };
  },
});

export const initialGameSnapshot = (): GameSnapshot => createInitialState(LEVEL);

export class CallNotAuthorizedError extends Error {
  public constructor() {
    super('La llamada fue cancelada o el ejecutor perdió su claim.');
    this.name = 'CallNotAuthorizedError';
  }
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const usageFrom = (value: DecisionResult['usage']): Usage => {
  const normalized: Partial<Usage> =
    value && typeof value === 'object' && 'normalized' in value
      ? ((value as { normalized?: Partial<Usage> }).normalized ?? {})
      : ((value as Partial<Usage> | undefined) ?? {});
  return {
    inputTokens: typeof normalized?.inputTokens === 'number' ? normalized.inputTokens : null,
    outputTokens: typeof normalized?.outputTokens === 'number' ? normalized.outputTokens : null,
    reasoningTokens:
      typeof normalized?.reasoningTokens === 'number' ? normalized.reasoningTokens : null,
    gameTokens: typeof normalized?.gameTokens === 'number' ? normalized.gameTokens : null,
    cacheReadTokens:
      typeof normalized?.cacheReadTokens === 'number' ? normalized.cacheReadTokens : null,
    cacheWriteTokens:
      typeof normalized?.cacheWriteTokens === 'number' ? normalized.cacheWriteTokens : null,
  };
};

const toolsFor = (record: PersistedAttempt): DecisionTool[] =>
  record.skills.map((skill) => ({
    name: skill.opaqueId,
    ...(skill.description === undefined ? {} : { description: skill.description }),
    inputSchema: skill.inputSchema,
  }));

/** Executes one attempt. All external effects are behind the store/body/inference ports. */
export const executeAttempt = async (
  input: { readonly owner: string; readonly attemptId: string; readonly executorId?: string },
  dependencies: ExecuteAttemptDependencies,
): Promise<void> => {
  const executorId = input.executorId ?? randomUUID();
  let record = await dependencies.store.claim(
    input.owner,
    input.attemptId,
    executorId,
    (dependencies.now ?? (() => new Date()))().toISOString(),
  );
  if (!record) {
    runtimeEvent('claim', { attemptId: input.attemptId, status: 'not_claimed' });
    return;
  }
  runtimeEvent('claimed', {
    attemptId: record.id,
    executorId,
    status: record.status,
  });
  const wait =
    dependencies.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let retryDecisionId: string | undefined;
  let throttledRetries = 0;
  const closeAttempt = async (
    status: Extract<PersistedAttempt['status'], 'cancelled' | 'error'>,
    reason: string,
  ): Promise<PersistedAttempt | undefined> => {
    const closed = await dependencies.store.close(
      input.owner,
      input.attemptId,
      status,
      reason,
      executorId,
    );
    runtimeEvent('terminal', {
      attemptId: input.attemptId,
      status: closed?.status ?? status,
      code: reason,
      calls: closed?.calls,
      turns: closed?.turnsUsed,
    });
    return closed;
  };
  try {
    while (record.status === 'running') {
      const current = await dependencies.store.get(input.owner, input.attemptId);
      if (!current || current.executorId !== executorId) return;
      record = current;
      if (record.cancelRequested) {
        await closeAttempt('cancelled', 'cancelled_by_user');
        return;
      }
      if (
        record.executionDeadline &&
        new Date(record.executionDeadline).getTime() -
          (dependencies.now ?? (() => new Date()))().getTime() <=
          record.config.callTimeoutMs + record.config.saveReserveMs
      ) {
        await closeAttempt('error', 'runtime_deadline_exceeded');
        return;
      }
      const seq = record.nextCall;
      const activeRecord = record;
      const decisionId = `${activeRecord.id}-decision-${activeRecord.sequence + 1}`;
      if (retryDecisionId !== decisionId) {
        retryDecisionId = decisionId;
        throttledRetries = 0;
      }
      const requestKey = `attempt/${activeRecord.id}/decision/${decisionId}/call/${seq}/request.json`;
      const responseKey = `attempt/${activeRecord.id}/decision/${decisionId}/call/${seq}/response.json`;
      let call: CallRecord | undefined;
      let responseError: { name: string; message: string } | undefined;
      const audit: DecisionAudit = {
        beforeSend: async (requestBytes) => {
          const request = await dependencies.bodies.put(requestKey, requestBytes);
          const candidate: CallRecord = {
            attemptId: activeRecord.id,
            seq,
            decisionId,
            modelKey: activeRecord.config.model.key,
            modelId: activeRecord.config.model.modelId,
            region: activeRecord.config.model.region,
            profileVersion: activeRecord.config.model.profileVersion,
            requestKey,
            responseKey,
            requestSha256: request.sha256,
            requestBytes: request.bytes,
            status: 'started',
            usage: {
              inputTokens: null,
              outputTokens: null,
              reasoningTokens: null,
              gameTokens: null,
              cacheReadTokens: null,
              cacheWriteTokens: null,
            },
            createdAt: (dependencies.now ?? (() => new Date()))().toISOString(),
            updatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
          };
          call = await dependencies.store.beginCall(
            input.owner,
            activeRecord.id,
            executorId,
            candidate,
          );
          if (!call) throw new CallNotAuthorizedError();
          runtimeEvent('call_authorized', {
            attemptId: activeRecord.id,
            seq,
            status: call.status,
          });
        },
        afterReceive: async (receipt) => {
          if (receipt.bytes) {
            const response = await dependencies.bodies.put(responseKey, receipt.bytes);
            if (call) {
              call = {
                ...call,
                status: receipt.error || !receipt.complete ? 'unknown' : 'received',
                responseSha256: response.sha256,
                responseBytes: response.bytes,
                responseStatus: receipt.statusCode ?? undefined,
                requestId: receipt.requestId ?? undefined,
                errorCode: receipt.error?.name,
                updatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
              };
              await dependencies.store.finishCall(input.owner, activeRecord.id, executorId, call);
              runtimeEvent('response_recorded', {
                attemptId: activeRecord.id,
                seq,
                status: call.status,
                providerRequestId: call.requestId,
              });
            }
          } else if (call) {
            responseError = receipt.error;
            call = {
              ...call,
              status: 'unknown',
              responseStatus: receipt.statusCode ?? undefined,
              requestId: receipt.requestId ?? undefined,
              errorCode: receipt.error?.name,
              updatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
            };
            await dependencies.store.finishCall(input.owner, activeRecord.id, executorId, call);
            runtimeEvent('response_recorded', {
              attemptId: activeRecord.id,
              seq,
              status: call.status,
              providerRequestId: call.requestId,
            });
          }
        },
      };
      let decision: DecisionResult;
      try {
        decision = await dependencies.infer({
          instructions: activeRecord.instructions,
          tools: toolsFor(activeRecord),
          observation: dependencies.engine.observe({
            snapshot: activeRecord.currentSnapshot,
            level: activeRecord.config.levelDefinition,
            skills: activeRecord.skills,
          }),
          modelConfig: activeRecord.config.model,
          audit,
          timeoutMs: activeRecord.config.callTimeoutMs,
        });
      } catch (error) {
        if (call) {
          const failure = error as { readonly code?: string; readonly usage?: unknown };
          const failureCode = failure.code;
          const completed: CallRecord = {
            ...call,
            status:
              call.status === 'started'
                ? 'unknown'
                : failureCode === 'invalid_response' || failureCode === 'truncated'
                  ? 'invalid'
                  : 'error',
            usage: failure.usage ? usageFrom(failure.usage as DecisionResult['usage']) : call.usage,
            errorCode: failureCode ?? (error instanceof Error ? error.name : 'inference_error'),
            updatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
          };
          await dependencies.store.finishCall(input.owner, activeRecord.id, executorId, completed);
          if (failureCode === 'throttled' && throttledRetries < MAX_THROTTLE_RETRIES_PER_DECISION) {
            const latest = await dependencies.store.get(input.owner, activeRecord.id);
            if (!latest || latest.executorId !== executorId || latest.status !== 'running') {
              return;
            }
            if (latest.cancelRequested) {
              await closeAttempt('cancelled', 'cancelled_during_retry');
              return;
            }
            throttledRetries += 1;
            let retryState = latest;
            let remainingDelay = THROTTLE_RETRY_DELAY_MS;
            while (remainingDelay > 0) {
              const deadlineMs = retryState.executionDeadline
                ? new Date(retryState.executionDeadline).getTime()
                : undefined;
              if (
                deadlineMs !== undefined &&
                deadlineMs - (dependencies.now ?? (() => new Date()))().getTime() <=
                  remainingDelay + retryState.config.callTimeoutMs + retryState.config.saveReserveMs
              ) {
                await closeAttempt('error', 'runtime_deadline_exceeded');
                return;
              }
              const interval = Math.min(remainingDelay, THROTTLE_RETRY_CHECK_INTERVAL_MS);
              await wait(interval);
              remainingDelay -= interval;
              const afterWait = await dependencies.store.get(input.owner, activeRecord.id);
              if (
                !afterWait ||
                afterWait.executorId !== executorId ||
                afterWait.status !== 'running'
              ) {
                return;
              }
              if (afterWait.cancelRequested) {
                await closeAttempt('cancelled', 'cancelled_during_retry');
                return;
              }
              retryState = afterWait;
            }
            continue;
          }
        }
        await dependencies.store.recoverBodies?.(input.owner, activeRecord.id);
        await closeAttempt(
          'error',
          responseError?.name ??
            (error as { code?: string })?.code ??
            (error instanceof Error ? error.name : 'inference_error'),
        );
        return;
      }
      if (!call) {
        await closeAttempt('error', 'request_not_persisted');
        return;
      }
      const usage = usageFrom(decision.usage);
      call = {
        ...call,
        usage,
        rawAction: decision.action,
        status: call.status === 'started' ? 'received' : call.status,
        updatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
      };
      await dependencies.store.finishCall(input.owner, record.id, executorId, call);
      const resolution = dependencies.engine.apply({
        snapshot: activeRecord.currentSnapshot,
        level: activeRecord.config.levelDefinition,
        skills: activeRecord.skills,
        action: decision.action,
        seq: activeRecord.sequence + 1,
        maxTurns: activeRecord.maxTurns,
      });
      const publication: ActionPublication = {
        seq: activeRecord.sequence + 1,
        decisionId,
        action: resolution.normalizedAction,
        resolution: resolution.resolution,
        beforeStateId: resolution.beforeStateId,
        afterStateId: resolution.afterStateId,
        beforeSnapshot: activeRecord.currentSnapshot,
        afterSnapshot: resolution.afterSnapshot,
        terminalStatus: resolution.terminalStatus,
        reason: resolution.reason,
        progress: resolution.progress,
        finalSupport: resolution.finalSupport,
        turnsUsed: resolution.turnsUsed,
      };
      const published = await dependencies.store.publishAction(
        input.owner,
        activeRecord.id,
        executorId,
        publication,
      );
      if (!published) {
        const latest = await dependencies.store.get(input.owner, activeRecord.id);
        if (latest?.cancelRequested && latest.status === 'running')
          await closeAttempt('cancelled', 'cancelled_before_action');
        return;
      }
      runtimeEvent('action_published', {
        attemptId: activeRecord.id,
        seq: publication.seq,
        status: published.status,
        turns: published.turnsUsed,
      });
      if (published.status !== 'running') return;
      record = published;
      await wait(0);
    }
  } catch (error) {
    if (!(error instanceof CallNotAuthorizedError)) {
      await dependencies.store.recoverBodies?.(input.owner, input.attemptId);
      await closeAttempt(
        'error',
        (error as { code?: string })?.code ??
          (error instanceof Error ? error.name : 'runtime_error'),
      );
    }
  }
};

export const sha256Hex = digest;
