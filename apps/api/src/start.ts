import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type { AttemptStore } from '../../../shared/server/attempt.js';
import { createDynamoAttemptStore } from './attempt-store.js';

export type StarterEvent = { readonly attemptId?: unknown; readonly owner?: unknown };
export type StarterDependencies = {
  readonly store?: AttemptStore;
  readonly invokeRuntime?: (input: {
    attemptId: string;
    owner: string;
    sessionId: string;
  }) => Promise<void>;
  readonly now?: () => Date;
};

const starterEvent = (
  stage: string,
  fields: Record<string, string | number | boolean | undefined> = {},
): void => {
  console.log(
    JSON.stringify({
      component: 'attempt-starter',
      stage,
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    }),
  );
};

const runtimeInvoker = async (input: {
  attemptId: string;
  owner: string;
  sessionId: string;
}): Promise<void> => {
  const runtimeArn = process.env.AGENT_RUNTIME_ARN;
  if (!runtimeArn) throw new Error('Falta AGENT_RUNTIME_ARN.');
  const client = new BedrockAgentCoreClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    maxAttempts: 1,
  });
  const response = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArn,
      runtimeSessionId: input.sessionId,
      contentType: 'application/json',
      accept: 'application/json',
      payload: Buffer.from(
        JSON.stringify({ attemptId: input.attemptId, owner: input.owner }),
        'utf8',
      ),
    }),
  );
  // The Runtime handler acknowledges after registering the background task. Drain the
  // stream so the SDK can release its connection; it does not wait for the game loop.
  if (response.response) await response.response.transformToByteArray();
  starterEvent('runtime_acknowledged', {
    attemptId: input.attemptId,
    sessionId: input.sessionId,
    requestId: response.$metadata?.requestId,
    status: 'accepted',
  });
};

export const starterHandler = async (
  event: StarterEvent,
  dependencies: StarterDependencies = {},
): Promise<void> => {
  if (
    typeof event.attemptId !== 'string' ||
    typeof event.owner !== 'string' ||
    event.attemptId.length === 0 ||
    event.owner.length === 0
  ) {
    throw new Error('La tarea de arranque no contiene una referencia válida.');
  }
  const store = dependencies.store ?? createDynamoAttemptStore();
  const attempt = await store.closeExpired(
    event.owner,
    event.attemptId,
    (dependencies.now ?? (() => new Date()))().toISOString(),
  );
  if (!attempt || attempt.status !== 'pending' || attempt.cancelRequested) {
    starterEvent('dispatch_skipped', {
      attemptId: event.attemptId,
      status: attempt?.status ?? 'missing',
      code: attempt?.cancelRequested ? 'cancel_requested' : 'not_pending',
    });
    return;
  }
  await (dependencies.invokeRuntime ?? runtimeInvoker)({
    attemptId: event.attemptId,
    owner: event.owner,
    sessionId: attempt.sessionId,
  });
  starterEvent('runtime_invoked', {
    attemptId: attempt.id,
    sessionId: attempt.sessionId,
    status: 'requested',
  });
};

export const handler = (event: StarterEvent): Promise<void> => starterHandler(event);
