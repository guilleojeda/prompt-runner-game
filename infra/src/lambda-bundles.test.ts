import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'prompt-runner-lambda-bundles-'));

afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

describe('deployed Lambda handler compatibility with ADOT', () => {
  it.each([
    ['game API', 'apps/api/dist/index.js'],
    ['attempt starter', 'apps/api/dist-start/index.js'],
    ['monitoring API', 'apps/monitoring-api/dist/index.js'],
  ])('allows the layer to wrap the %s handler', (_name, artifact) => {
    // Lambda's asset contains this CommonJS bundle without the source workspace's
    // type=module package.json. Load the same bytes in that module context.
    const bundle = path.join(
      temporaryDirectory,
      `${path.dirname(artifact).replaceAll('/', '-')}.cjs`,
    );
    copyFileSync(path.join(repository, artifact), bundle);
    const exported = require(bundle) as { handler: (...args: unknown[]) => unknown };
    const original = exported.handler;
    expect(original).toBeTypeOf('function');

    const wrapped = (...args: unknown[]) => original(...args);
    try {
      expect(Reflect.set(exported, 'handler', wrapped)).toBe(true);
      expect(exported.handler).toBe(wrapped);
    } finally {
      Reflect.set(exported, 'handler', original);
    }
  });
});
