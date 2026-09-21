import { randomUUID } from 'node:crypto';
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import type { AttemptStore, BodyStore } from '../../../shared/server/attempt.js';
import { createDynamoAttemptStore, S3BodyStore } from '../../api/src/attempt-store.js';
import {
  createGameEngine,
  executeAttempt,
  type EngineAdapter,
  type InferenceAdapter,
} from './execute.js';

export type RuntimeRequest = { readonly attemptId?: unknown; readonly owner?: unknown };
export type RuntimeDependencies = {
  readonly store?: AttemptStore;
  readonly bodies?: BodyStore;
  readonly infer?: InferenceAdapter;
  readonly engine?: EngineAdapter;
  readonly app?: {
    addAsyncTask(name: string, metadata?: Record<string, unknown>): number;
    completeAsyncTask(taskId: number): boolean;
  };
};

export type RuntimeTaskTracker = {
  addAsyncTask(name: string, metadata?: Record<string, unknown>): number;
  completeAsyncTask(taskId: number): boolean;
};

const runtimeEvent = (
  stage: string,
  fields: Record<string, string | number | boolean | undefined> = {},
): void => {
  console.log(
    JSON.stringify({
      component: 'attempt-runtime',
      stage,
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    }),
  );
};

const parseRequest = (request: RuntimeRequest): { attemptId: string; owner: string } => {
  if (
    typeof request?.attemptId !== 'string' ||
    request.attemptId.length === 0 ||
    typeof request.owner !== 'string' ||
    request.owner.length === 0
  ) {
    throw new Error('La invocación del Runtime no contiene una referencia válida.');
  }
  return { attemptId: request.attemptId, owner: request.owner };
};

/** Build the invocation function separately so its acknowledgement/health contract is testable. */
export const createRuntimeProcessor = (
  dependencies: RuntimeDependencies,
  tracker: RuntimeTaskTracker,
): ((request: unknown, sessionId: string) => Promise<{ accepted: true; attemptId: string }>) => {
  const bodies = dependencies.bodies ?? new S3BodyStore();
  const store = dependencies.store ?? createDynamoAttemptStore({ bodyStore: bodies });
  const engine = dependencies.engine ?? createGameEngine();
  if (!dependencies.infer) throw new Error('Runtime requires the native inference adapter.');
  return async (request, sessionId) => {
    const parsed = parseRequest(request as RuntimeRequest);
    const taskId = tracker.addAsyncTask('attempt-execution', { attemptId: parsed.attemptId });
    // Session IDs route retries to the same AgentCore session, while every
    // invocation gets a fresh claim token. Reusing it would let two duplicate
    // Runtime requests execute the same call concurrently.
    const executorId = `${sessionId}:${randomUUID()}`;
    runtimeEvent('accepted', {
      attemptId: parsed.attemptId,
      sessionId,
      executorId,
      status: 'tracked',
    });
    void executeAttempt(
      { ...parsed, executorId },
      { store, bodies, infer: dependencies.infer!, engine },
    )
      .finally(() => {
        tracker.completeAsyncTask(taskId);
      })
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            component: 'runtime-attempt',
            stage: 'background_error',
            attemptId: parsed.attemptId,
            code:
              (error as { code?: string })?.code ??
              (error instanceof Error ? error.name : 'runtime_error'),
          }),
        );
      });
    return { accepted: true, attemptId: parsed.attemptId };
  };
};

/** Build the AgentCore HTTP app. The handler acknowledges after task tracking is installed. */
export const createRuntimeApp = (dependencies: RuntimeDependencies): BedrockAgentCoreApp => {
  const processRequest = createRuntimeProcessor(dependencies, {
    addAsyncTask: (name, metadata) => (dependencies.app ?? runtimeApp).addAsyncTask(name, metadata),
    completeAsyncTask: (taskId) => (dependencies.app ?? runtimeApp).completeAsyncTask(taskId),
  });
  const runtimeApp = new BedrockAgentCoreApp({
    invocationHandler: {
      process: async (request: unknown, context) => processRequest(request, context.sessionId),
    },
  });
  return runtimeApp;
};

export const run = (dependencies: RuntimeDependencies): void =>
  createRuntimeApp(dependencies).run({ port: 8080, host: '0.0.0.0' });
