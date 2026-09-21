import { createRuntimeApp } from './runtime.js';
import { executeDecision } from './inference.js';
import type { InferenceAdapter } from './execute.js';

export { createRuntimeApp, run } from './runtime.js';
export { executeAttempt, createGameEngine, initialGameSnapshot } from './execute.js';
export type { InferenceAdapter } from './execute.js';

export const startRuntime = async (
  infer: InferenceAdapter = async (input) =>
    executeDecision(
      {
        instructions: input.instructions,
        tools: input.tools,
        observation: input.observation,
        modelConfig: input.modelConfig,
      },
      input.audit,
      { timeoutMs: input.timeoutMs },
    ) as unknown as Awaited<ReturnType<InferenceAdapter>>,
): Promise<void> => {
  createRuntimeApp({ infer }).run({ port: 8080, host: '0.0.0.0' });
};

await startRuntime();
