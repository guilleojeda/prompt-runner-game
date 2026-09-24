/** Child process for the HTTP contract test; never imported by the runner. */
import { createDefaultDraft } from '../../../shared/robot.js';
import { MemoryAttemptStore, MemoryBodyStore } from '../../api/src/attempt-store.js';
import { createRuntimeApp } from './runtime.js';

const draft = createDefaultDraft();
const store = new MemoryAttemptStore({ draft: { version: 1, draft } });
const { attempt } = await store.admit({
  owner: 'http-test',
  requestKey: 'http-test',
  expectedVersion: 1,
  draft,
  animationEnabled: false,
});
let release!: () => void;
const held = new Promise<void>((resolve) => {
  release = resolve;
});
let calls = 0;
const app = createRuntimeApp({
  store,
  bodies: new MemoryBodyStore(),
  infer: async ({ audit }) => {
    calls += 1;
    await audit.beforeSend(Buffer.from('{}'));
    process.send?.({ type: 'inference-started' });
    await held;
    await audit.afterReceive({
      bytes: Buffer.from('{"usage":{"inputTokens":3,"outputTokens":2}}'),
      statusCode: 200,
      requestId: 'http-test',
      complete: true,
    });
    return {
      action: { name: 'tool_1', input: {} },
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        gameTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  },
});
process.on('message', async (message) => {
  if (message === 'release') {
    await store.requestCancel('http-test', attempt.id);
    release();
  }
  if (message === 'result') {
    process.send?.({ type: 'result', calls, attempt: await store.get('http-test', attempt.id) });
  }
});
process.send?.({ type: 'attempt', id: attempt.id });
app.run({ port: 0, host: '127.0.0.1' });
