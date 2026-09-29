import { describe, expect, it, vi } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot.js';
import { SavedRobotApiClient, SavedRobotApiFailure } from './saved-robot-api.js';

const config = { apiBaseUrl: 'https://api.example.test/' };

function robot(id = 'robot-a', version = 1) {
  return {
    id,
    name: 'Explorador',
    version,
    createdAt: '2026-09-29T12:00:00.000Z',
    updatedAt: '2026-09-29T12:00:00.000Z',
    modelKey: 'claude-sonnet-4.6' as const,
    draft: createDefaultDraft(),
  };
}

describe('SavedRobotApiClient', () => {
  it('uses the current token and exact paginated routes and payloads', async () => {
    const saved = robot();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ robots: [saved], nextCursor: 'next page' }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(saved), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...saved, version: 2 }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true }), { status: 200 }));
    const client = new SavedRobotApiClient(config, {
      tokenProvider: () => 'access-token',
      fetch: fetchImpl,
    });

    await expect(client.listRobots()).resolves.toMatchObject({ nextCursor: 'next page' });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://api.example.test/robots', {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: 'Bearer access-token' },
    });
    await client.getRobot('robot/a');
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://api.example.test/robots/robot%2Fa', {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: 'Bearer access-token' },
    });
    await client.saveRobot('robot-a', 1, 'Explorador', saved.draft);
    expect(fetchImpl).toHaveBeenNthCalledWith(3, 'https://api.example.test/robots/robot-a', {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedVersion: 1,
        name: 'Explorador',
        draft: saved.draft,
      }),
    });
    await client.deleteRobot('robot-a', 2);
    expect(fetchImpl).toHaveBeenNthCalledWith(4, 'https://api.example.test/robots/robot-a', {
      method: 'DELETE',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 2 }),
    });
  });

  it('preserves stale conflicts and marks lost writes ambiguous', async () => {
    const current = robot('robot-a', 3);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'conflict', message: 'stale', current }), {
          status: 409,
        }),
      )
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const client = new SavedRobotApiClient(config, {
      tokenProvider: () => 'access-token',
      fetch: fetchImpl,
    });

    await expect(client.saveRobot('robot-a', 1, current.name, current.draft)).rejects.toMatchObject(
      {
        code: 'conflict',
        current,
      },
    );
    await expect(client.deleteRobot('robot-a', 1)).rejects.toMatchObject({
      code: 'network',
      ambiguous: true,
    });
  });

  it('rejects invalid names locally before making a write request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new SavedRobotApiClient(config, {
      tokenProvider: () => 'access-token',
      fetch: fetchImpl,
    });

    await expect(client.saveRobot('robot-a', 0, '   ', createDefaultDraft())).rejects.toMatchObject(
      {
        code: 'invalid',
      },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not convert an aborted write into an ambiguous failure', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    const client = new SavedRobotApiClient(config, {
      tokenProvider: () => 'access-token',
      fetch: fetchImpl,
    });

    await expect(
      client.saveRobot('robot-a', 0, 'Explorador', createDefaultDraft(), controller.signal),
    ).rejects.not.toBeInstanceOf(SavedRobotApiFailure);
  });
});
