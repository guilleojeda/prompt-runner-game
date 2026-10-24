import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { aws_cognito as cognito, aws_dynamodb as dynamodb } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { PromptRunnerMonitoringStack } from './monitoring-stack.js';
import { APPLICATION_ACCOUNT, APPLICATION_REGION } from './stack.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const basicVerifier = 'a8b72980f5f7bd9fa1ac542c5608252885ff846c0bfdda2e07750608c55ac64f';
const apiKeyVerifier = 'b7c9d143f3da3e38793d79c2088ae9fb58e5ce752d8b7c4ca1c432d4fa6e0b79';
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const invalidApiKeyVerifiers: Array<[string, unknown, boolean]> = [
  ['absent', undefined, false],
  ['empty', '', true],
  ['malformed', 'not-a-sha256-digest', true],
  ['uppercase', apiKeyVerifier.toUpperCase(), true],
];

type SynthResource = {
  Type: string;
  Properties: {
    FunctionCode?: string;
    FunctionName?: string;
    Environment?: { Variables?: Record<string, unknown> };
  };
};

function makeMonitoringStackProps(apiKeyVerifier: unknown, includeApiKeyVerifier = true) {
  const app = new cdk.App();
  const sources = new cdk.Stack(app, 'ExistingSources', {
    env: { account: APPLICATION_ACCOUNT, region: APPLICATION_REGION },
  });
  const userPool = cognito.UserPool.fromUserPoolId(sources, 'Pool', 'us-east-1_existing');
  const draftTable = dynamodb.Table.fromTableArn(
    sources,
    'DraftTable',
    `arn:aws:dynamodb:${APPLICATION_REGION}:${APPLICATION_ACCOUNT}:table/prompt-runner-game-drafts`,
  );
  const props: Record<string, unknown> = {
    env: { account: APPLICATION_ACCOUNT, region: APPLICATION_REGION },
    userPool,
    draftTable,
    authVerifier: basicVerifier,
    buildRevision: 'api-key-config-acceptance',
  };
  if (includeApiKeyVerifier) props.apiKeyVerifier = apiKeyVerifier;
  return { app, props };
}

function runInfraEntry(environment: Record<string, string | undefined>) {
  const outdir = mkdtempSync(path.join(os.tmpdir(), 'monitoring-api-key-synth-'));
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'infra/bin/infra.ts'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      CDK_OUTDIR: outdir,
      ...environment,
    },
  });
  return { outdir, result };
}

function listFilesRecursively(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFilesRecursively(entryPath) : [entryPath];
  });
}

function workflowCheckScript(): string {
  const workflow = readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
  const stepMarker = '      - name: Run repository checks\n';
  const marker = '        run: |\n';
  const stepStart = workflow.indexOf(stepMarker);
  const start = stepStart < 0 ? -1 : workflow.indexOf(marker, stepStart + stepMarker.length);
  if (start < 0) throw new Error('Could not find the repository-check step in ci.yml.');
  const body = workflow.slice(start + marker.length).split('\n      - name:')[0];
  return body
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n')
    .replace(/\n+$/u, '');
}

function runWorkflowCheck(
  eventName: string,
  ref: string,
  secrets: { basic?: string; apiKey?: string },
) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'monitoring-api-key-ci-'));
  const callsPath = path.join(temp, 'npm-calls.txt');
  const capturedEnvPath = path.join(temp, 'npm-env.txt');
  const githubEnvPath = path.join(temp, 'github-env.txt');
  const npmStubPath = path.join(temp, 'npm');
  writeFileSync(
    npmStubPath,
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$NPM_CALLS_PATH"\nprintf \'%s\\n%s\\n\' "$MONITORING_BASIC_AUTH_SHA256" "$MONITORING_API_KEY_SHA256" > "$NPM_ENV_PATH"\n',
    { mode: 0o755 },
  );
  const script = workflowCheckScript();
  const result = spawnSync('bash', ['-e', '-c', script], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      PATH: `${temp}:${process.env.PATH ?? ''}`,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_REF: ref,
      GITHUB_ENV: githubEnvPath,
      NPM_CALLS_PATH: callsPath,
      NPM_ENV_PATH: capturedEnvPath,
      ...(secrets.basic === undefined ? {} : { MONITORING_BASIC_AUTH_SHA256: secrets.basic }),
      ...(secrets.apiKey === undefined ? {} : { MONITORING_API_KEY_SHA256: secrets.apiKey }),
    },
  });
  const readOptional = (file: string) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };
  return {
    temp,
    result,
    calls: readOptional(callsPath),
    npmEnvironment: readOptional(capturedEnvPath),
    githubEnvironment: readOptional(githubEnvPath),
  };
}

describe('monitoring API key synthesis configuration', { timeout: 30_000 }, () => {
  it.each(invalidApiKeyVerifiers)(
    'rejects %s API key digest at stack construction',
    (label, value, includeValue) => {
      const { app, props } = makeMonitoringStackProps(value, includeValue ?? true);
      expect(
        () =>
          new PromptRunnerMonitoringStack(
            app,
            `InvalidApiKeyVerifier${label}`,
            props as unknown as ConstructorParameters<typeof PromptRunnerMonitoringStack>[2],
          ),
      ).toThrow(/MONITORING_API_KEY_SHA256/u);
    },
  );

  it('uses the explicit CLI digest in the edge gate and keeps it out of Lambda and web assets', () => {
    const { outdir, result } = runInfraEntry({
      MONITORING_BASIC_AUTH_SHA256: basicVerifier,
      MONITORING_API_KEY_SHA256: apiKeyVerifier,
      BUILD_REVISION: 'api-key-cli-acceptance',
    });
    try {
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const template = JSON.parse(
        readFileSync(path.join(outdir, 'PromptRunnerMonitoring.template.json'), 'utf8'),
      ) as { Resources: Record<string, SynthResource> };
      const edgeFunction = Object.values(template.Resources).find(
        (resource) => resource.Type === 'AWS::CloudFront::Function',
      );
      expect(edgeFunction?.Properties.FunctionCode).toContain(basicVerifier);
      expect(edgeFunction?.Properties.FunctionCode).toContain(apiKeyVerifier);

      const metricsFunction = Object.values(template.Resources).find(
        (resource) =>
          resource.Type === 'AWS::Lambda::Function' &&
          resource.Properties.FunctionName === 'prompt-runner-game-monitoring-metrics',
      );
      expect(metricsFunction).toBeDefined();
      expect(
        JSON.stringify(metricsFunction?.Properties.Environment?.Variables ?? {}),
      ).not.toContain(apiKeyVerifier);

      const webFiles = listFilesRecursively(path.join(repositoryRoot, 'apps/monitoring-web/dist'));
      for (const file of webFiles) {
        expect(readFileSync(file, 'utf8'), path.relative(repositoryRoot, file)).not.toContain(
          apiKeyVerifier,
        );
      }
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });

  it.each([
    ['missing', undefined],
    ['malformed', apiKeyVerifier.toUpperCase()],
  ])('does not synthesize with a %s CLI API key digest or fallback', (_label, invalid) => {
    const { outdir, result } = runInfraEntry({
      MONITORING_BASIC_AUTH_SHA256: basicVerifier,
      ...(invalid === undefined ? {} : { MONITORING_API_KEY_SHA256: invalid }),
    });
    try {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('MONITORING_API_KEY_SHA256');
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });
});

describe('monitoring API key CI configuration', () => {
  it('passes both repository secrets only to the main check job', () => {
    const workflow = readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
    const checkJob = workflow.split('\n  deploy:\n')[0];
    const checkEnvironment = checkJob.split('    env:\n')[1]?.split('\n    steps:\n')[0] ?? '';
    expect(checkEnvironment).toContain(
      "MONITORING_BASIC_AUTH_SHA256: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && secrets.MONITORING_BASIC_AUTH_SHA256 || '' }}",
    );
    expect(checkEnvironment).toContain(
      "MONITORING_API_KEY_SHA256: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && secrets.MONITORING_API_KEY_SHA256 || '' }}",
    );
  });

  it('uses fake explicit digests for pull requests and exports them before the check', () => {
    const outcome = runWorkflowCheck('pull_request', 'refs/pull/17/merge', {});
    try {
      expect(outcome.result.status, `${outcome.result.stdout}\n${outcome.result.stderr}`).toBe(0);
      expect(outcome.calls).toContain('run check');
      const digests = outcome.npmEnvironment.trimEnd().split('\n');
      expect(digests).toHaveLength(2);
      const [basic, apiKey] = digests;
      expect(basic).toMatch(SHA256_HEX);
      expect(apiKey).toMatch(SHA256_HEX);
      expect(outcome.githubEnvironment).toContain('MONITORING_BASIC_AUTH_SHA256=');
      expect(outcome.githubEnvironment).toContain('MONITORING_API_KEY_SHA256=');
    } finally {
      rmSync(outcome.temp, { recursive: true, force: true });
    }
  });

  it('passes valid main secrets to the check without replacing them with fixtures', () => {
    const mainBasicVerifier = '1'.repeat(64);
    const mainApiKeyVerifier = '2'.repeat(64);
    const outcome = runWorkflowCheck('push', 'refs/heads/main', {
      basic: mainBasicVerifier,
      apiKey: mainApiKeyVerifier,
    });
    try {
      expect(outcome.result.status, `${outcome.result.stdout}\n${outcome.result.stderr}`).toBe(0);
      expect(outcome.calls).toContain('run check');
      expect(outcome.npmEnvironment.trim().split('\n')).toEqual([
        mainBasicVerifier,
        mainApiKeyVerifier,
      ]);
      expect(outcome.githubEnvironment).toBe('');
    } finally {
      rmSync(outcome.temp, { recursive: true, force: true });
    }
  });

  it.each([
    ['missing Basic verifier', undefined, '3'.repeat(64)],
    ['invalid Basic verifier', 'A'.repeat(64), '3'.repeat(64)],
    ['missing API key verifier', '4'.repeat(64), undefined],
    ['invalid API key verifier', '4'.repeat(64), 'A'.repeat(64)],
  ])('fails before invoking the check for a %s on main', (_label, basic, apiKey) => {
    const outcome = runWorkflowCheck('push', 'refs/heads/main', { basic, apiKey });
    try {
      expect(outcome.result.status).not.toBe(0);
      expect(outcome.calls).toBe('');
      expect(outcome.result.stderr).toMatch(/MONITORING_(?:BASIC_AUTH|API_KEY)_SHA256/u);
    } finally {
      rmSync(outcome.temp, { recursive: true, force: true });
    }
  });
});
