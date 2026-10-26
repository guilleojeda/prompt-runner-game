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

  it('treats a native API Gateway 429 as a definite save rejection without gateway text', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ message: 'Too Many Requests' }), { status: 429 }),
      );
    const client = new DraftApiClient(config, {
      tokenProvider: () => 'access-token',
      fetch: fetchImpl,
    });

    await expect(client.putDraft(0, createDefaultDraft())).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
      message: 'Están llegando muchas solicitudes. Esperá un momento y volvé a intentar.',
      ambiguous: false,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([401, 403])(
    'keeps the sent token context on an auth rejection without exposing the token (%s)',
    async (status) => {
      const tokenProvider = vi.fn().mockResolvedValue({
        accessToken: 'draft-secret-token',
        authContext: 17,
      });
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ message: 'Volvé a ingresar para continuar.' }), { status }),
        );
      const client = new DraftApiClient(config, { tokenProvider, fetch: fetchImpl });

      let failure: unknown;
      try {
        await client.getDraft();
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({
        code: 'authentication',
        status,
        authContext: 17,
        message: 'El acceso fue rechazado para esta operación. Podés reintentar.',
      });
      expect(JSON.stringify(failure)).not.toContain('draft-secret-token');
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
        headers: expect.objectContaining({ Authorization: 'Bearer draft-secret-token' }),
      });
      expect(tokenProvider).toHaveBeenCalledOnce();
    },
  );

  it('uses the token and context from one asynchronously resolved snapshot', async () => {
    let resolveSnapshot!: (snapshot: { accessToken: string; authContext: number }) => void;
    const tokenProvider = vi.fn(
      () =>
        new Promise<{ accessToken: string; authContext: number }>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 }));
    const client = new DraftApiClient(config, { tokenProvider, fetch: fetchImpl });

    const request = client.getDraft();
    resolveSnapshot({ accessToken: 'paired-token', authContext: 29 });
    await expect(request).rejects.toMatchObject({
      code: 'authentication',
      authContext: 29,
    });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer paired-token' }),
    });
  });

  it('keeps a string provider auth rejection untagged for conservative callers', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 }));
    const client = new DraftApiClient(config, {
      tokenProvider: () => 'string-provider-token',
      fetch: fetchImpl,
    });

    await expect(client.getDraft()).rejects.toMatchObject({
      code: 'authentication',
      authContext: undefined,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
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

  it('rejects drafts saved with either older schema version', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ version: 3, draft: { schemaVersion: 1, catalogVersion: 1 } }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ version: 4, draft: { schemaVersion: 2, catalogVersion: 1 } }),
          { status: 200 },
        ),
      );
    const client = new DraftApiClient(config, {
      tokenProvider: () => 'access-token',
      fetch: fetchImpl,
    });

    await expect(client.getDraft()).rejects.toMatchObject({ code: 'server' });
    await expect(client.getDraft()).rejects.toMatchObject({ code: 'server' });
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

  it.each(['GET', 'PUT'] as const)(
    'classifies stored draft incompatibility as definitive on %s without inspecting the message',
    async (method) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'stored_draft_incompatible',
            message: 'No se pudo completar la operación.',
          }),
          { status: 500 },
        ),
      );
      const client = new DraftApiClient(config, {
        tokenProvider: () => 'access-token',
        fetch: fetchImpl,
      });

      const request =
        method === 'GET' ? client.getDraft() : client.putDraft(0, createDefaultDraft());
      await expect(request).rejects.toMatchObject({
        code: 'incompatible',
        message: 'No se pudo completar la operación.',
        ambiguous: false,
      });
    },
  );

  it('keeps a dependency failure transient even when it has the same message as incompatibility', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            code: 'dependency_unavailable',
            message: 'No se pudo completar la operación.',
          }),
          { status: 503 },
        ),
    );
    const client = new DraftApiClient(config, {
      tokenProvider: () => 'access-token',
      fetch: fetchImpl,
    });

    await expect(client.getDraft()).rejects.toMatchObject({ code: 'server', ambiguous: false });
    await expect(client.putDraft(0, createDefaultDraft())).rejects.toMatchObject({
      code: 'server',
      ambiguous: true,
    });
  });
});
