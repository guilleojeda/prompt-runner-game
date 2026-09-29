import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultDraft, type SavedRobot, type SavedRobotSummary } from '../../../shared/robot';
import { handleRequest } from './handler';
import {
  SavedRobotConflictError,
  SavedRobotCursorError,
  SavedRobotIncompatibleError,
  type SavedRobotStore,
} from './saved-robots';

const identity = {
  sub: 'user-a',
  token_use: 'access',
  client_id: 'client-1',
  scope: 'openid email prompt-runner/robot',
};

const eventFor = (
  method: 'GET' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  queryStringParameters?: Record<string, string>,
): APIGatewayProxyEventV2 =>
  ({
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: { authorization: 'Bearer access-token' },
    queryStringParameters,
    requestContext: {
      http: { method, path },
      requestId: 'request',
      authorizer: { jwt: { claims: identity } },
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body), isBase64Encoded: false }),
  }) as unknown as APIGatewayProxyEventV2;

const userInfo = vi.fn(
  async () =>
    new Response(JSON.stringify({ sub: 'user-a', email_verified: true }), { status: 200 }),
);

const responseBody = (response: { body?: string }): Record<string, unknown> =>
  JSON.parse(response.body ?? '{}') as Record<string, unknown>;

const robot: SavedRobot = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Robot',
  version: 1,
  createdAt: '2026-09-29T12:00:00.000Z',
  updatedAt: '2026-09-29T12:00:00.000Z',
  modelKey: 'claude-sonnet-4.6',
  draft: createDefaultDraft(),
};
const summary: SavedRobotSummary = {
  id: robot.id,
  name: robot.name,
  version: robot.version,
  createdAt: robot.createdAt,
  updatedAt: robot.updatedAt,
  modelKey: robot.modelKey,
};

const dependencies = (savedRobotStore: SavedRobotStore) => ({
  savedRobotStore,
  fetch: userInfo,
  clientId: 'client-1',
  userInfoUrl: 'https://cognito.example.test/userinfo',
});

describe('saved robot API handler', () => {
  it('lists and reads only through the saved robot store before creating an attempt store', async () => {
    const savedRobotStore: SavedRobotStore = {
      list: vi.fn().mockResolvedValue({ robots: [summary], nextCursor: 'next' }),
      get: vi.fn().mockResolvedValue(robot),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const listResponse = await handleRequest(
      eventFor('GET', '/robots', undefined, { cursor: 'cursor' }),
      dependencies(savedRobotStore),
    );
    expect(listResponse.statusCode).toBe(200);
    expect(responseBody(listResponse)).toEqual({
      robots: [summary],
      nextCursor: 'next',
    });
    expect(savedRobotStore.list).toHaveBeenCalledWith('user-a', 'cursor', 20);
    expect(listResponse.headers?.['cache-control']).toBe('no-store');

    const getResponse = await handleRequest(
      eventFor('GET', `/robots/${robot.id}`),
      dependencies(savedRobotStore),
    );
    expect(getResponse.statusCode).toBe(200);
    expect(responseBody(getResponse)).toEqual(robot);
    expect(savedRobotStore.get).toHaveBeenCalledWith('user-a', robot.id);
  });

  it('validates and forwards explicit create, update, and delete operations', async () => {
    const savedRobotStore: SavedRobotStore = {
      list: vi.fn(),
      get: vi.fn(),
      put: vi.fn().mockResolvedValue(robot),
      delete: vi.fn().mockResolvedValue({ deleted: true }),
    };
    const draft = createDefaultDraft();
    const putResponse = await handleRequest(
      eventFor('PUT', `/robots/${robot.id}`, { expectedVersion: 0, name: '  Robot  ', draft }),
      dependencies(savedRobotStore),
    );
    expect(putResponse.statusCode).toBe(200);
    expect(savedRobotStore.put).toHaveBeenCalledWith('user-a', robot.id, 0, 'Robot', draft);

    const deleteResponse = await handleRequest(
      eventFor('DELETE', `/robots/${robot.id}`, { expectedVersion: 1 }),
      dependencies(savedRobotStore),
    );
    expect(deleteResponse.statusCode).toBe(200);
    expect(responseBody(deleteResponse)).toEqual({ deleted: true });
    expect(savedRobotStore.delete).toHaveBeenCalledWith('user-a', robot.id, 1);

    const invalid = await handleRequest(
      eventFor('PUT', `/robots/${robot.id}`, { expectedVersion: 0, name: '', draft }),
      dependencies(savedRobotStore),
    );
    expect(invalid.statusCode).toBe(400);
    expect(savedRobotStore.put).toHaveBeenCalledTimes(1);
  });

  it('returns 413 for an oversized draft before attempting a saved-robot write', async () => {
    const savedRobotStore: SavedRobotStore = {
      list: vi.fn(),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const response = await handleRequest(
      eventFor('PUT', `/robots/${robot.id}`, {
        expectedVersion: 0,
        name: 'Robot grande',
        draft: { ...createDefaultDraft(), instructions: 'x'.repeat(70_000) },
      }),
      dependencies(savedRobotStore),
    );
    expect(response.statusCode).toBe(413);
    expect(responseBody(response)).toMatchObject({ code: 'too_large' });
    expect(savedRobotStore.put).not.toHaveBeenCalled();
  });

  it('classifies a malformed or cross-owner cursor as invalid input', async () => {
    const savedRobotStore: SavedRobotStore = {
      list: vi.fn().mockRejectedValue(new SavedRobotCursorError()),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const response = await handleRequest(
      eventFor('GET', '/robots', undefined, { cursor: 'cursor-from-another-account' }),
      dependencies(savedRobotStore),
    );
    expect(response.statusCode).toBe(400);
    expect(responseBody(response)).toEqual({ code: 'invalid', message: 'El cursor no es válido.' });
  });

  it('reports an incompatible full robot read without exposing storage details', async () => {
    const savedRobotStore: SavedRobotStore = {
      list: vi.fn(),
      get: vi.fn().mockRejectedValue(new SavedRobotIncompatibleError('private draft details')),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const response = await handleRequest(
      eventFor('GET', `/robots/${robot.id}`),
      dependencies(savedRobotStore),
    );
    expect(response.statusCode).toBe(500);
    expect(responseBody(response)).toEqual({
      code: 'stored_robot_incompatible',
      message: 'La configuración guardada no es compatible con la versión actual.',
    });
    expect(JSON.stringify(responseBody(response))).not.toContain('private draft details');
  });

  it('returns 404 for missing copies and 409 with the current own record for stale writes', async () => {
    const savedRobotStore: SavedRobotStore = {
      list: vi.fn(),
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockRejectedValue(new SavedRobotConflictError(robot)),
      delete: vi.fn(),
    };
    const missing = await handleRequest(
      eventFor('GET', `/robots/${robot.id}`),
      dependencies(savedRobotStore),
    );
    expect(missing.statusCode).toBe(404);

    const stale = await handleRequest(
      eventFor('PUT', `/robots/${robot.id}`, {
        expectedVersion: 1,
        name: 'Robot cambiado',
        draft: createDefaultDraft(),
      }),
      dependencies(savedRobotStore),
    );
    expect(stale.statusCode).toBe(409);
    expect(responseBody(stale)).toEqual({
      code: 'conflict',
      message: 'La configuración guardada cambió en otra pestaña.',
      current: robot,
    });
  });

  it('requires the authenticated scope and rejects non-UUID path IDs', async () => {
    const savedRobotStore: SavedRobotStore = {
      list: vi.fn(),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const invalidId = await handleRequest(
      eventFor('GET', '/robots/not-a-uuid'),
      dependencies(savedRobotStore),
    );
    expect(invalidId.statusCode).toBe(400);
    expect(savedRobotStore.get).not.toHaveBeenCalled();

    const noScopeEvent = eventFor('GET', '/robots');
    (noScopeEvent.requestContext as unknown as { authorizer: unknown }).authorizer = {
      jwt: { claims: { ...identity, scope: 'openid email' } },
    };
    const noScope = await handleRequest(noScopeEvent, dependencies(savedRobotStore));
    expect(noScope.statusCode).toBe(403);
    expect(savedRobotStore.list).not.toHaveBeenCalled();
  });
});
