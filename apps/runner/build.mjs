import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const runtimeRequire = createRequire(import.meta.resolve('bedrock-agentcore/runtime'));
await rm('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: {
    js: "import { createRequire as __promptRunnerCreateRequire } from 'node:module'; const require = __promptRunnerCreateRequire(import.meta.url);",
  },
  outfile: 'dist/index.js',
  sourcemap: 'external',
});

// AgentCore loads these plugins with a locally bound createRequire, which esbuild
// cannot follow. Bundle its installed dependencies at their normal module paths
// so CodeZip runs independently of the repository's node_modules directory.
for (const plugin of ['@fastify/sse', '@fastify/websocket']) {
  await build({
    entryPoints: [runtimeRequire.resolve(plugin)],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: `dist/node_modules/${plugin}/index.js`,
  });
}
await writeFile('dist/package.json', JSON.stringify({ type: 'module' }) + '\n');
execFileSync(process.execPath, ['--check', 'dist/index.js'], { stdio: 'inherit' });

// A build in this checkout can accidentally resolve an omitted dependency from
// the root node_modules. Start the exact asset outside the repository as well.
const isolated = await mkdtemp(join(tmpdir(), 'prompt-runner-codezip-'));
try {
  await cp('dist', isolated, { recursive: true });
  const child = spawn(process.execPath, ['index.js'], {
    cwd: isolated,
    env: {
      ...process.env,
      NODE_PATH: '',
      AWS_REGION: 'us-east-1',
      AWS_EC2_METADATA_DISABLED: 'true',
      DRAFT_TABLE_NAME: 'bundle-smoke-no-aws-requests',
      ATTEMPT_BODIES_BUCKET: 'bundle-smoke-no-aws-requests',
    },
  });
  const closed = new Promise((resolve) => child.on('close', resolve));
  let output = '';
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('CodeZip did not start within 10 seconds.')),
        10_000,
      );
      child.on('error', reject);
      child.on('exit', (code) =>
        reject(new Error(`CodeZip exited during startup: ${code}\n${output}`)),
      );
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('Server listening')) resolve();
      });
    });
    const response = await fetch('http://127.0.0.1:8080/ping', {
      signal: AbortSignal.timeout(5000),
    });
    const health = await response.json();
    if (!response.ok || health.status !== 'Healthy')
      throw new Error('CodeZip health check failed.');
    console.log('Isolated CodeZip startup and /ping passed.');
  } finally {
    clearTimeout(timer);
    child.kill('SIGTERM');
    await closed;
  }
} finally {
  await rm(isolated, { recursive: true, force: true });
}
