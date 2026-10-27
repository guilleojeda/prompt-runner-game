// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App, type AppProps } from './App.js';
import {
  createAttemptApiClient,
  type AttemptApi,
  type AttemptSummary,
  type QuotaSummary,
} from './attempt-api.js';
import type { ApiTokenProvider } from './api-auth.js';
import type { AuthClient, AuthConfig, AuthSession } from './auth.js';
import type { DraftApi } from './draft-api.js';
import type { SavedRobotApi } from './saved-robot-api.js';
import { LEVEL } from '../../../shared/game.js';
import { modelByKey } from '../../../shared/models.js';
import {
  createDefaultDraft,
  ROBOT_CATALOG_VERSION,
  ROBOT_SCHEMA_VERSION,
  validateWritableDraft,
} from '../../../shared/robot.js';

vi.mock('./replay/ReplayScene.js', () => ({
  CoursePreview: () => <div />,
  ReplayScene: () => <div />,
}));

const authConfig: AuthConfig = {
  issuer: 'https://issuer.example.test',
  clientId: 'client',
  domain: 'https://auth.example.test',
  redirectUri: 'https://app.example.test/jugar',
  logoutUri: 'https://app.example.test/',
  apiBaseUrl: 'https://api.example.test/',
  apiScope: 'prompt-runner/robot',
};
const pendingAttemptId = '20261014100000-00000000-0000-4000-8000-000000000001';

function session(): AuthSession {
  return {
    identity: { sub: 'subject-a', email: 'a@example.com' },
    user: new User({
      access_token: 'fixture-token',
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: authConfig.issuer,
        aud: authConfig.clientId,
        iat: 1,
        exp: 9999999999,
        sub: 'subject-a',
        email: 'a@example.com',
      },
      expires_at: Math.floor(Date.now() / 1000) + 600,
    }),
  };
}

function attempt(status: AttemptSummary['status'] = 'pending'): AttemptSummary {
  const model = modelByKey(createDefaultDraft().modelKey)!;
  return {
    id: pendingAttemptId,
    createdAt: '2026-10-14T10:00:00.000Z',
    updatedAt: '2026-10-14T10:00:00.000Z',
    status,
    cancelRequested: false,
    levelId: LEVEL.id,
    modelKey: model.key,
    modelLabel: model.label,
    modelId: model.modelId,
    turnsUsed: 0,
    maxTurns: LEVEL.maxTurns,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    gameTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    score: null,
    collectedObjectIds: [],
    objectPoints: 0,
    progress: 0,
    finalSupport: 0,
    animationEnabled: true,
    presentationComplete: false,
    recordComplete: true,
  };
}

function quota(remaining: number): QuotaSummary {
  return {
    day: '2026-10-14',
    used: 100 - remaining,
    limit: 100,
    remaining,
    resetsAt: '2026-10-15T03:00:00.000Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeAll(async () => {
  const preflightClient = createAttemptApiClient(
    authConfig,
    () => 'preflight-token',
    async (input, init) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      const { pathname } = new URL(requestUrl);
      if (pathname === '/attempts' && init?.method === 'POST') {
        return response({ attempt: attempt(), dispatchConfirmed: true });
      }
      if (pathname === '/quota') return response(quota(100));
      if (/^\/attempts\/[^/]+$/.test(pathname)) return response({ attempt: attempt() });
      return response({ message: 'not found' }, 404);
    },
  );

  const admission = await preflightClient.createAttempt(
    'preflight-request-key',
    7,
    createDefaultDraft(),
    true,
  );
  const summary = await preflightClient.getAttempt(pendingAttemptId);
  const quotaSummary = await preflightClient.getQuota();
  expect(admission).toMatchObject({
    dispatchConfirmed: true,
    attempt: {
      id: pendingAttemptId,
      status: 'pending',
      levelId: LEVEL.id,
      modelLabel: modelByKey(createDefaultDraft().modelKey)?.label,
      modelId: modelByKey(createDefaultDraft().modelKey)?.modelId,
      animationEnabled: true,
      presentationComplete: false,
    },
  });
  expect(summary).toMatchObject({ status: 'pending', presentationComplete: false });
  expect(quotaSummary).toEqual(quota(100));
});

function renderApp(fetchFixture: typeof globalThis.fetch) {
  const authClient: AuthClient = {
    initialize: vi.fn().mockResolvedValue(session()),
    beginLogin: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
  };
  const draftApi: DraftApi = {
    getDraft: vi.fn().mockResolvedValue({ version: 7, draft: createDefaultDraft() }),
    putDraft: vi.fn(),
  };
  const savedRobotApi: SavedRobotApi = {
    listRobots: vi.fn().mockResolvedValue({ robots: [] }),
    getRobot: vi.fn(),
    saveRobot: vi.fn(),
    deleteRobot: vi.fn(),
  };
  const attemptApiRef: { current: AttemptApi | null } = { current: null };
  const attemptApiFactory: NonNullable<AppProps['attemptApiFactory']> = (
    config,
    tokenProvider: ApiTokenProvider,
  ) => {
    const attemptApi = createAttemptApiClient(config, tokenProvider, fetchFixture);
    vi.spyOn(attemptApi, 'getQuota');
    vi.spyOn(attemptApi, 'createAttempt');
    attemptApiRef.current = attemptApi;
    return attemptApi;
  };
  render(
    <App
      authClient={authClient}
      draftApi={draftApi}
      savedRobotApi={savedRobotApi}
      configLoader={async () => authConfig}
      attemptApiFactory={attemptApiFactory}
    />,
  );
  return { attemptApiRef, draftApi };
}

interface RaceFixtureOptions {
  readonly oldQuotaResponse: ReturnType<typeof deferred<Response>>;
  readonly currentAdmissionQuotaFails?: boolean;
}

async function createRaceFixture({
  oldQuotaResponse,
  currentAdmissionQuotaFails = false,
}: RaceFixtureOptions) {
  const ledger = { remaining: 100 };
  let quotaReadCount = 0;
  let startTransitionCount = 0;
  let capturedOldQuota!: QuotaSummary;
  let admissionRequest: Record<string, unknown> | null = null;
  const fetchFixture: typeof globalThis.fetch = async (input, init) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    const { pathname } = new URL(requestUrl);
    const method = init?.method ?? 'GET';

    if (pathname === '/quota' && method === 'GET') {
      quotaReadCount += 1;
      if (quotaReadCount === 1) return response({ message: 'Error inicial de cuota.' }, 503);
      if (quotaReadCount === 2) {
        capturedOldQuota = quota(ledger.remaining);
        return oldQuotaResponse.promise;
      }
      if (quotaReadCount === 3 && currentAdmissionQuotaFails) {
        return response({ message: 'Error actual de admisión.' }, 503);
      }
      return response(quota(ledger.remaining));
    }

    if (pathname === '/attempts' && method === 'POST') {
      admissionRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
      ledger.remaining -= 1;
      return response({ attempt: attempt(), dispatchConfirmed: true });
    }

    if (pathname === '/animation-preference' && method === 'GET') {
      return response({ animationEnabled: true, version: 0 });
    }
    if (pathname === '/attempts' && method === 'GET') return response({ attempts: [] });
    if (pathname.startsWith('/attempt-requests/')) {
      return response({ message: 'not found' }, 404);
    }
    if (/^\/attempts\/[^/]+\/start$/.test(pathname) && method === 'POST') {
      startTransitionCount += 1;
      return response(
        { message: 'No se suministra una transición de inicio en este fixture.' },
        404,
      );
    }
    if (/^\/attempts\/[^/]+$/.test(pathname) && method === 'GET') {
      return response({ attempt: attempt() });
    }
    return response({ message: 'not found' }, 404);
  };

  const { attemptApiRef, draftApi } = renderApp(fetchFixture);

  const retry = await screen.findByRole('button', { name: 'Reintentar consultas' });
  await waitFor(() => expect(attemptApiRef.current).not.toBeNull());
  const attemptApi = attemptApiRef.current!;
  const getQuota = vi.mocked(attemptApi.getQuota);
  const createAttempt = vi.mocked(attemptApi.createAttempt);
  expect(screen.getByRole('alert').textContent).toContain('Error inicial de cuota.');
  const controls = document.querySelector('#attempt-controls-slot') as HTMLElement;
  const tryButton = within(controls).getByRole('button', { name: 'Probar' }) as HTMLButtonElement;
  await waitFor(() => {
    const animation = within(controls).getByRole('checkbox', {
      name: 'Animación',
    }) as HTMLInputElement;
    expect(animation.disabled).toBe(false);
    expect(animation.checked).toBe(true);
  });
  await waitFor(() => expect(tryButton.disabled).toBe(false));
  fireEvent.click(retry);
  await waitFor(() => expect(getQuota).toHaveBeenCalledTimes(2));
  expect(tryButton.disabled).toBe(false);

  fireEvent.click(tryButton);
  await waitFor(() => expect(createAttempt).toHaveBeenCalledTimes(1));
  expect(ledger.remaining).toBe(99);
  expect(admissionRequest).not.toBeNull();
  await waitFor(() => expect(getQuota).toHaveBeenCalledTimes(3));
  if (!currentAdmissionQuotaFails) {
    await screen.findByLabelText('Cuota: 99 de 100 intentos disponibles');
  }

  const [requestKey, expectedVersion, draft] = createAttempt.mock.calls[0]!;
  expect(admissionRequest).toMatchObject({ requestKey, expectedVersion, draft });
  expect(requestKey).toMatch(/^[0-9a-f-]{36}$/i);
  expect(expectedVersion).toBe(7);
  expect(draft.schemaVersion).toBe(ROBOT_SCHEMA_VERSION);
  expect(draft.catalogVersion).toBe(ROBOT_CATALOG_VERSION);
  expect(draft.skills.some((skill: { enabled: boolean }) => skill.enabled)).toBe(true);
  expect(validateWritableDraft(draft)).toEqual(createDefaultDraft());
  expect(draftApi.getDraft).toHaveBeenCalledTimes(1);
  expect(startTransitionCount).toBe(0);
  expect(attempt()).toMatchObject({
    status: 'pending',
    levelId: LEVEL.id,
    modelLabel: modelByKey(createDefaultDraft().modelKey)?.label,
    modelId: modelByKey(createDefaultDraft().modelKey)?.modelId,
    presentationComplete: false,
  });
  expect(
    await screen.findByRole('heading', { name: 'Intento recibido, esperando inicio' }),
  ).toBeTruthy();

  return {
    getQuota,
    createAttempt,
    tryButton,
    capturedOldQuota,
    startTransitionCount,
    attemptApi,
  };
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('quota refresh ordering', () => {
  it('ignores an older retry success after the post-admission quota read', async () => {
    const oldQuotaRead = deferred<Response>();
    const { getQuota, createAttempt, capturedOldQuota } = await createRaceFixture({
      oldQuotaResponse: oldQuotaRead,
    });

    const oldRequest = getQuota.mock.results[1]!.value;
    await act(async () => {
      oldQuotaRead.resolve(response(capturedOldQuota));
      await oldRequest;
    });
    expect(screen.getByLabelText('Cuota: 99 de 100 intentos disponibles')).toBeTruthy();

    expect(createAttempt).toHaveBeenCalledTimes(1);
    expect(getQuota).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ignores an older retry failure after the post-admission quota read', async () => {
    const oldQuotaRead = deferred<Response>();
    const { getQuota, createAttempt } = await createRaceFixture({
      oldQuotaResponse: oldQuotaRead,
    });
    const oldRequest = getQuota.mock.results[1]!.value;
    await act(async () => {
      oldQuotaRead.resolve(response({ message: 'Error de cuota anterior.' }, 503));
      await oldRequest.catch(() => undefined);
    });
    expect(screen.queryByText('Error de cuota anterior.')).toBeNull();

    expect(screen.getByLabelText('Cuota: 99 de 100 intentos disponibles')).toBeTruthy();
    expect(createAttempt).toHaveBeenCalledTimes(1);
  });

  it('keeps the current admission refresh failure and ignores an older success', async () => {
    const oldQuotaRead = deferred<Response>();
    const { getQuota, capturedOldQuota } = await createRaceFixture({
      oldQuotaResponse: oldQuotaRead,
      currentAdmissionQuotaFails: true,
    });
    await waitFor(() => expect(getQuota).toHaveBeenCalledTimes(3));
    expect(await screen.findByText('Error actual de admisión.')).toBeTruthy();

    const oldRequest = getQuota.mock.results[1]!.value;
    await act(async () => {
      oldQuotaRead.resolve(response(capturedOldQuota));
      await oldRequest;
    });
    expect(screen.queryByLabelText('Cuota: 100 de 100 intentos disponibles')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Error actual de admisión.');
  });

  it('forwards a current-account auth rejection from a superseded quota read', async () => {
    const oldQuotaRead = deferred<Response>();
    const { getQuota, capturedOldQuota } = await createRaceFixture({
      oldQuotaResponse: oldQuotaRead,
    });
    expect(screen.getByLabelText('Cuota: 99 de 100 intentos disponibles')).toBeTruthy();

    const oldRequest = getQuota.mock.results[1]!.value;
    await act(async () => {
      oldQuotaRead.resolve(response({ message: 'La sesión venció.' }, 401));
      await oldRequest.catch(() => undefined);
    });

    expect(capturedOldQuota.remaining).toBe(100);
    expect(
      await screen.findByText(
        'La sesión dejó de tener acceso a esta cuenta. Volvé a ingresar para continuar.',
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText('Cuota: 99 de 100 intentos disponibles')).toBeTruthy();
    expect(screen.queryByText('La sesión venció.')).toBeNull();
  });
});
