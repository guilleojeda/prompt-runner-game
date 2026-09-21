import { describe, expect, it, vi } from 'vitest';
import { createDefaultDraft } from '../../../shared/robot.js';
import { DraftApiClient, DraftApiFailure } from './draft-api.js';

const config = { apiBaseUrl: 'https://api.example.test/', apiScope: 'prompt-runner/robot' };

describe('DraftApiClient', () => {
  it.each(['https://api.example.test/', 'https://api.example.test'])(
    'uses the current access token and exact route/payload with base %s',
    async (apiBaseUrl) => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
        async () =>
          new Response(JSON.stringify({ version: 0, draft: createDefaultDraft() }), {
            status: 200,
          }),
      );
      const client = new DraftApiClient(
        { ...config, apiBaseUrl },
        {
          tokenProvider: () => 'access-token',
          fetch: fetchImpl,
        },
      );

      await client.getDraft();
      expect(fetchImpl).toHaveBeenCalledWith('https://api.example.test/draft', {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer access-token',
        },
      });

      await client.putDraft(0, createDefaultDraft());
      expect(fetchImpl).toHaveBeenLastCalledWith('https://api.example.test/draft', {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer access-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expectedVersion: 0, draft: createDefaultDraft() }),
      });
    },
  );

  it('preserves the server conflict snapshot and marks lost PUT responses ambiguous', async () => {
    const current = { version: 2, draft: createDefaultDraft() };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'conflict', message: 'conflict', current }), {
          status: 409,
        }),
      )
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const client = new DraftApiClient(config, {
      tokenProvider: () => 'access-token',
      fetch: fetchImpl,
    });

    await expect(client.putDraft(1, createDefaultDraft())).rejects.toMatchObject({
      code: 'conflict',
      current,
    });
    await expect(client.putDraft(1, createDefaultDraft())).rejects.toMatchObject({
      code: 'network',
      ambiguous: true,
    });
  });

  it('does not turn an aborted request into an ambiguous save', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    const client = new DraftApiClient(config, {
      tokenProvider: () => 'access-token',
      fetch: fetchImpl,
    });

    await expect(
      client.putDraft(0, createDefaultDraft(), controller.signal),
    ).rejects.not.toBeInstanceOf(DraftApiFailure);
  });

  it('rejects successful responses and conflict snapshots that do not match the shared draft contract', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: 0, draft: { instructions: 'missing fields' } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 'conflict',
            message: 'conflict',
            current: { version: 3, draft: { schemaVersion: 999 } },
          }),
          { status: 409 },
        ),
      );
    const client = new DraftApiClient(config, {
      tokenProvider: () => 'access-token',
      fetch: fetchImpl,
    });

    await expect(client.getDraft()).rejects.toMatchObject({ code: 'server' });
    await expect(client.putDraft(2, createDefaultDraft())).rejects.toMatchObject({
      code: 'conflict',
      current: undefined,
    });
  });

  it('treats a successful PUT with an unreadable or invalid body as ambiguous', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{broken', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: 0, draft: { instructions: 'invalid' } }), {
          status: 200,
        }),
      );
    const client = new DraftApiClient(config, {
      tokenProvider: () => 'access-token',
      fetch: fetchImpl,
    });

    await expect(client.putDraft(0, createDefaultDraft())).rejects.toMatchObject({
      code: 'server',
      ambiguous: true,
    });
    await expect(client.putDraft(0, createDefaultDraft())).rejects.toMatchObject({
      code: 'server',
      ambiguous: true,
    });
  });

  it('preserves a stored draft incompatibility message on GET', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 'stored_draft_incompatible',
          message: 'La versión guardada no es compatible.',
        }),
        { status: 500 },
      ),
    );
    const client = new DraftApiClient(config, {
      tokenProvider: () => 'access-token',
      fetch: fetchImpl,
    });

    await expect(client.getDraft()).rejects.toMatchObject({
      code: 'server',
      message: 'La versión guardada no es compatible.',
    });
  });
});
