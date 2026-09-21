import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('acknowledges HTTP invocation while work remains HealthyBusy and clears health after closure', async () => {
  const child = fork(fileURLToPath(new URL('./runtime-http.fixture.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'],
    silent: true,
  });
  const closed = new Promise((resolve) => child.on('close', resolve));
  const messages: Array<Record<string, unknown>> = [];
  child.on('message', (message) => messages.push(message as Record<string, unknown>));
  let logs = '';
  child.stdout?.on('data', (chunk) => {
    logs += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    logs += chunk;
  });
  try {
    await expect
      .poll(() => logs.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1], {
        timeout: 10_000,
      })
      .toBeTruthy();
    const base = logs.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/)![1];
    await expect.poll(() => messages.find((message) => message.type === 'attempt')).toBeTruthy();
    const id = messages.find((message) => message.type === 'attempt')!.id;
    const ping = () => fetch(`${base}/ping`).then((response) => response.json());
    expect((await ping()).status).toBe('Healthy');
    const response = await fetch(`${base}/invocations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-amzn-bedrock-agentcore-runtime-session-id': 'http-contract-session-000000000000000001',
      },
      body: JSON.stringify({ owner: 'http-test', attemptId: id }),
      signal: AbortSignal.timeout(2000),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true, attemptId: id });
    await expect
      .poll(() => messages.some((message) => message.type === 'inference-started'))
      .toBe(true);
    // The controlled provider has not resolved, but the HTTP request already has.
    expect((await ping()).status).toBe('HealthyBusy');
    child.send('release');
    await expect.poll(async () => (await ping()).status).toBe('Healthy');
    child.send('result');
    await expect.poll(() => messages.find((message) => message.type === 'result')).toBeTruthy();
    expect(messages.find((message) => message.type === 'result')).toMatchObject({
      calls: 1,
      attempt: { status: 'cancelled', turnsUsed: 0, inputTokens: 3, outputTokens: 2 },
    });
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);
