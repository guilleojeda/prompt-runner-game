import { Buffer } from 'node:buffer';
import * as crypto from 'node:crypto';
import * as cdk from 'aws-cdk-lib';
import { aws_cognito as cognito, aws_dynamodb as dynamodb } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { runInNewContext } from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import { DRAFT_TABLE_NAME } from './robot.js';
import { PromptRunnerMonitoringStack } from './monitoring-stack.js';
import { APPLICATION_ACCOUNT, APPLICATION_REGION } from './stack.js';

// Fictitious acceptance credentials only. Never use the operator's key or password here.
const apiKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const apiKeyVerifier = crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');
const password = 'fixture-only-password';
const basicCredentials = `monitor:${password}`;
const basicVerifier = crypto.createHash('sha256').update(basicCredentials, 'utf8').digest('hex');
const basicToken = Buffer.from(basicCredentials, 'utf8').toString('base64');

type EdgeHeaders = Record<string, { value: string; multiValue?: { value: string }[] }>;
type EdgeResult = {
  statusCode?: number;
  headers: EdgeHeaders;
  body?: string | { encoding?: string; data?: string };
  method?: string;
  uri?: string;
};

const invalidApiKeyCases: Array<[string, EdgeHeaders]> = [
  ['wrong but well-formed key', { 'x-api-key': { value: 'f'.repeat(64) } }],
  ['empty key', { 'x-api-key': { value: '' } }],
  [
    'duplicate different key values',
    {
      'x-api-key': {
        value: apiKey,
        multiValue: [{ value: apiKey }, { value: 'f'.repeat(64) }],
      },
    },
  ],
  [
    'duplicate identical key values',
    {
      'x-api-key': {
        value: apiKey,
        multiValue: [{ value: apiKey }, { value: apiKey }],
      },
    },
  ],
  ['malformed key format', { 'x-api-key': { value: 'not a hex key' } }],
  ['uppercase hex key', { 'x-api-key': { value: apiKey.toUpperCase() } }],
  ['whitespace-padded key', { 'x-api-key': { value: ` ${apiKey} ` } }],
];

describe('public monitoring API-key gate', { timeout: 15_000 }, () => {
  let template: Template;
  let functionCode: string;

  beforeAll(() => {
    const app = new cdk.App();
    const sources = new cdk.Stack(app, 'MonitoringApiKeySources', {
      env: { account: APPLICATION_ACCOUNT, region: APPLICATION_REGION },
    });
    const userPool = cognito.UserPool.fromUserPoolId(sources, 'Pool', 'us-east-1_existing');
    const draftTable = dynamodb.Table.fromTableArn(
      sources,
      'DraftTable',
      `arn:aws:dynamodb:${APPLICATION_REGION}:${APPLICATION_ACCOUNT}:table/${DRAFT_TABLE_NAME}`,
    );
    const monitoringProps = {
      env: { account: APPLICATION_ACCOUNT, region: APPLICATION_REGION },
      userPool,
      draftTable,
      authVerifier: basicVerifier,
      apiKeyVerifier,
      buildRevision: 'api-key-acceptance-revision',
    } as ConstructorParameters<typeof PromptRunnerMonitoringStack>[2];
    template = Template.fromStack(
      new PromptRunnerMonitoringStack(app, 'MonitoringApiKeyAcceptance', monitoringProps),
    );

    const functions = Object.values(template.findResources('AWS::CloudFront::Function'));
    expect(functions).toHaveLength(1);
    functionCode = functions[0].Properties.FunctionCode as string;
  });

  function invoke(
    options: {
      method?: string;
      uri?: string;
      headers?: EdgeHeaders;
      querystring?: Record<string, { value: string }>;
      cookies?: Record<string, { value: string }>;
    } = {},
  ): EdgeResult {
    const event = {
      request: {
        method: options.method ?? 'GET',
        uri: options.uri ?? '/api/metrics',
        querystring: options.querystring ?? {},
        headers: options.headers ?? {},
        cookies: options.cookies ?? {},
      },
    };
    return runInNewContext(`${functionCode}; handler(event)`, {
      event,
      Buffer,
      require: (name: string) => {
        if (name !== 'crypto') throw new Error(`Unexpected edge dependency ${name}`);
        return crypto;
      },
    }) as EdgeResult;
  }

  function basicHeader(): EdgeHeaders {
    return { authorization: { value: `Basic ${basicToken}` } };
  }

  function expectAccepted(result: EdgeResult) {
    expect(result.statusCode).toBeUndefined();
    expect(result.headers.authorization).toBeUndefined();
    expect(result.headers['x-api-key']).toBeUndefined();
  }

  function expectBasicChallenge(result: EdgeResult) {
    expect(result.statusCode).toBe(401);
    expect(result.headers['www-authenticate']?.value).toMatch(/^Basic /u);
    expect(result.headers['cache-control']?.value).toBe('no-store');
  }

  function responseBodyText(result: EdgeResult): string {
    if (typeof result.body === 'string') return result.body;
    if (result.body && typeof result.body.data === 'string') {
      if (result.body.encoding === 'base64') {
        return Buffer.from(result.body.data, 'base64').toString('utf8');
      }
      return result.body.data;
    }
    throw new Error('Expected the API-key rejection to include a JSON response body.');
  }

  function expectApiKeyRejection(result: EdgeResult) {
    expect(result.statusCode).toBe(401);
    expect(result.headers['cache-control']?.value).toBe('no-store');
    expect(result.headers['content-type']?.value).toMatch(/^application\/json(?:;|$)/iu);
    expect(result.headers['www-authenticate']).toBeUndefined();

    const text = responseBodyText(result);
    const payload = JSON.parse(text) as Record<string, unknown>;
    for (const field of [
      'asOf',
      'generatedAt',
      'registeredUsers',
      'newUsers',
      'activeUsers',
      'bedrockCostUsd',
      'users',
    ]) {
      expect(payload).not.toHaveProperty(field);
    }
    expect(text).not.toContain(apiKey);
    expect(text).not.toContain(password);
  }

  it('synthesizes separate digests without embedding either original credential', () => {
    expect(basicVerifier).not.toBe(apiKeyVerifier);
    expect(functionCode).toContain(basicVerifier);
    expect(functionCode).toContain(apiKeyVerifier);
    expect(functionCode).not.toContain(apiKey);
    expect(functionCode).not.toContain(basicCredentials);
    expect(functionCode).not.toContain(basicToken);
    expect(functionCode).not.toContain(password);
  });

  it('accepts the API key only on exact GET /api/metrics and strips both credential headers', () => {
    const result = invoke({
      headers: { 'x-api-key': { value: apiKey } },
    });
    expectAccepted(result);
    expect(result.method).toBe('GET');
    expect(result.uri).toBe('/api/metrics');
  });

  it('accepts exact GET /api/metrics with both valid credentials and strips both headers', () => {
    const result = invoke({
      headers: {
        ...basicHeader(),
        'x-api-key': { value: apiKey },
      },
    });
    expectAccepted(result);
    expect(result.method).toBe('GET');
    expect(result.uri).toBe('/api/metrics');
  });

  it.each([
    [
      'invalid Basic credentials',
      `Basic ${Buffer.from('monitor:wrong-password', 'utf8').toString('base64')}`,
    ],
    ['malformed Basic token', `Basic ${basicToken}!`],
  ])('accepts exact GET /api/metrics with a valid key and %s', (_label, authorization) => {
    const result = invoke({
      headers: {
        authorization: { value: authorization },
        'x-api-key': { value: apiKey },
      },
    });
    expectAccepted(result);
    expect(result.method).toBe('GET');
    expect(result.uri).toBe('/api/metrics');
  });

  it('preserves canonical Basic access and rejects noncanonical Base64 with the Basic challenge', () => {
    expect(Buffer.from(`${basicToken}!`, 'base64').toString('utf8')).toBe(basicCredentials);

    const accepted = invoke({ headers: basicHeader() });
    expectAccepted(accepted);

    const rejected = invoke({
      headers: { authorization: { value: `Basic ${basicToken}!` } },
    });
    expectBasicChallenge(rejected);
  });

  it.each(invalidApiKeyCases)(
    'rejects %s as JSON with valid Basic credentials',
    (_label, header) => {
      const result = invoke({ headers: { ...basicHeader(), ...header } });
      expectApiKeyRejection(result);
    },
  );

  it.each(invalidApiKeyCases)('rejects %s as JSON without Basic credentials', (_label, header) => {
    const result = invoke({ headers: header });
    expectApiKeyRejection(result);
  });

  it('keeps the Basic challenge when the API-key header is absent', () => {
    expectBasicChallenge(invoke());
  });

  it('does not accept the valid API key in the query string', () => {
    expectBasicChallenge(invoke({ querystring: { 'x-api-key': { value: apiKey } } }));
  });

  it('does not accept the valid API key in a cookie', () => {
    expectBasicChallenge(invoke({ cookies: { 'x-api-key': { value: apiKey } } }));
  });

  it('does not let the API key authorize static assets, other URIs, HEAD or other methods', () => {
    const outsideCanonicalGet = [
      { method: 'GET', uri: '/' },
      { method: 'GET', uri: '/assets/monitor.js' },
      { method: 'GET', uri: '/api/other' },
      { method: 'GET', uri: '/api/metrics/extra' },
      { method: 'GET', uri: '/api/metrics/' },
      { method: 'HEAD', uri: '/api/metrics' },
      { method: 'POST', uri: '/api/metrics' },
    ];

    for (const request of outsideCanonicalGet) {
      expectBasicChallenge(
        invoke({
          ...request,
          headers: { 'x-api-key': { value: apiKey } },
        }),
      );
    }
  });

  it('preserves Basic access with an incidental API-key header outside exact GET /api/metrics', () => {
    const outsideCanonicalGet = [
      { method: 'GET', uri: '/' },
      { method: 'GET', uri: '/assets/monitor.js' },
      { method: 'GET', uri: '/api/other' },
      { method: 'HEAD', uri: '/api/metrics' },
      { method: 'POST', uri: '/api/metrics' },
    ];

    for (const request of outsideCanonicalGet) {
      for (const incidentalKey of [apiKey, 'not a hex key']) {
        const result = invoke({
          ...request,
          headers: {
            ...basicHeader(),
            'x-api-key': { value: incidentalKey },
          },
        });
        expectAccepted(result);
      }
    }
  });
});
