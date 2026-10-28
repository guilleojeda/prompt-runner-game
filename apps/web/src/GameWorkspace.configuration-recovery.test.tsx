// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDraft, type RobotDraft } from '../../../shared/robot.js';
import { LEVEL } from '../../../shared/game.js';
import type { DecisionIndex } from '../../../shared/attempt.js';
import type { ApiAuthRequired } from './api-auth.js';
import type { AuthSession } from './auth.js';
import {
  AttemptApiFailure,
  createAttemptApiClient,
  type AttemptApi,
  type AttemptConfiguration,
  type AttemptSummary,
} from './attempt-api.js';
import type { DraftApi } from './draft-api.js';
import { GameWorkspace, type GameWorkspaceProps } from './GameWorkspace.js';
import type { RobotEditorHandle } from './RobotEditor.js';
import {
  historyAction,
  historyActionForRow,
  historySection,
  selectHistoryView,
  settle,
} from './History.test-support.js';
import { formatDateTime } from './attempt-display.js';

const MINUTE = 60_000;
const TEST_NOW = new Date('2026-10-28T12:00:00.000Z');
const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');
const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');

function session(sub = 'subject-a', accessToken = `token-${sub}`): AuthSession {
  const now = Math.floor(Date.now() / 1000);
  return {
    identity: { sub, email: `${sub}@example.test` },
    user: new User({
      access_token: accessToken,
      token_type: 'Bearer',
      scope: 'openid email prompt-runner/robot',
      profile: {
        iss: 'https://issuer.example.test',
        aud: 'client',
        iat: now,
        exp: now + 600,
        sub,
        email: `${sub}@example.test`,
      },
      expires_at: now + 600,
    }),
  };
}

function summary(
  id: string,
  status: AttemptSummary['status'] = 'victory',
  overrides: Partial<AttemptSummary> = {},
): AttemptSummary {
  const active = status === 'pending' || status === 'running';
  return {
    id,
    createdAt: '2026-10-27T12:00:00.000Z',
    updatedAt: '2026-10-27T12:00:01.000Z',
    status,
    cancelRequested: false,
    levelId: LEVEL.id,
    modelKey: 'claude-sonnet-4.6',
    modelLabel: 'Claude Sonnet 4.6',
    modelId: 'global.anthropic.claude-sonnet-4-6',
    turnsUsed: active ? 0 : 1,
    maxTurns: LEVEL.maxTurns,
    calls: active ? 0 : 1,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    gameTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    score: status === 'victory' ? 100 : null,
    collectedObjectIds: [],
    objectPoints: 0,
    progress: active ? 0 : 1,
    finalSupport: LEVEL.exit.support,
    animationEnabled: false,
    presentationComplete: true,
    recordComplete: true,
    ...overrides,
  };
}

function configuration(attemptId: string, instructions: string): AttemptConfiguration {
  return {
    attemptId,
    draft: { ...createDefaultDraft(), instructions },
  };
}

function attemptApi(overrides: Partial<AttemptApi> = {}): AttemptApi {
  return {
    createAttempt: vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('invalid', 'Unexpected create.')),
    getAttemptRequest: vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'Request not found.', 404)),
    getAttempt: vi
      .fn()
      .mockRejectedValue(new AttemptApiFailure('not_found', 'Attempt not found.', 404)),
    getConfiguration: vi.fn().mockResolvedValue({
      attemptId: 'unexpected-configuration',
      draft: createDefaultDraft(),
    }),
    listAttempts: vi.fn().mockResolvedValue({ attempts: [] }),
    startAttempt: vi.fn(async (id: string) => ({
      attempt: summary(id, 'running'),
      dispatchConfirmed: true,
    })),
    cancelAttempt: vi.fn(),
    getReplay: vi.fn(),
    getDecisionIndex: vi.fn(async (id: string): Promise<DecisionIndex> => ({
      attemptId: id,
      levelId: LEVEL.id,
      decisions: [],
    })),
    getDecision: vi.fn(),
    completePresentation: vi.fn(),
    getAnimationPreference: vi.fn().mockResolvedValue({ animationEnabled: false, version: 0 }),
    putAnimationPreference: vi.fn(),
    getQuota: vi.fn().mockResolvedValue({
      day: '2026-10-28',
      used: 0,
      limit: 100,
      remaining: 100,
      resetsAt: new Date(Date.now() + 30 * 24 * 60 * MINUTE).toISOString(),
    }),
    ...overrides,
  };
}

function draftApi(initialDraft: RobotDraft = createDefaultDraft()): DraftApi {
  return {
    getDraft: vi.fn().mockResolvedValue({ version: 4, draft: initialDraft }),
    putDraft: vi.fn(async (version: number, draft: RobotDraft) => ({
      version: version + 1,
      draft,
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
  await settle();
}

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: hidden ? 'hidden' : 'visible',
  });
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  fireEvent(document, new Event('visibilitychange'));
}

function mountWorkspace(
  runnerOverrides: Partial<AttemptApi> = {},
  props: Partial<
    Pick<GameWorkspaceProps, 'session' | 'authPaused' | 'onAuthRequired' | 'configurationAvailable'>
  > = {},
  initialDraft: RobotDraft = createDefaultDraft(),
) {
  const runner = attemptApi(runnerOverrides);
  const drafts = draftApi(initialDraft);
  const editor = { current: null } as unknown as GameWorkspaceProps['editor'];
  let currentProps: GameWorkspaceProps = {
    attemptApi: runner,
    draftApi: drafts,
    session: props.session ?? session(),
    editor,
    accessState: 'ready',
    authPaused: props.authPaused ?? false,
    configurationAvailable: props.configurationAvailable ?? true,
    ...(props.onAuthRequired ? { onAuthRequired: props.onAuthRequired } : {}),
  };
  const element = () => <GameWorkspace {...currentProps} />;
  const view = render(element());
  return {
    ...view,
    runner,
    drafts,
    editor,
    update(nextProps: Partial<GameWorkspaceProps>): void {
      currentProps = { ...currentProps, ...nextProps };
      view.rerender(element());
    },
  };
}

function selectSurface(name: 'Preparar' | 'Historial' | 'Mis robots'): void {
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Navegación principal' })).getByRole('button', {
      name,
    }),
  );
}

async function showHistory(): Promise<HTMLElement> {
  await settle();
  selectSurface('Historial');
  await settle();
  return historySection();
}

async function openHistoryConfiguration(rowText?: string): Promise<HTMLButtonElement> {
  const trigger = rowText
    ? await historyActionForRow('Ver configuración', rowText)
    : await historyAction('Ver configuración');
  trigger.focus();
  fireEvent.click(trigger);
  await settle();
  expect(screen.getByRole('heading', { name: 'Configuración del intento' })).toBeTruthy();
  return trigger;
}

async function openCurrentResultConfiguration(attempt: AttemptSummary): Promise<HTMLButtonElement> {
  await settle();
  const tryButton = screen.getByRole('button', { name: 'Probar' }) as HTMLButtonElement;
  expect(tryButton.disabled).toBe(false);
  fireEvent.click(tryButton);
  await settle();
  expect(
    screen.getByRole('heading', { name: attempt.status === 'victory' ? 'Victoria' : 'Derrota' }),
  ).toBeTruthy();
  const trigger = screen.getByRole('button', { name: 'Ver configuración' }) as HTMLButtonElement;
  trigger.focus();
  fireEvent.click(trigger);
  await settle();
  expect(screen.getByRole('heading', { name: 'Configuración del intento' })).toBeTruthy();
  return trigger;
}

async function openQueriedHistoryResultConfiguration(): Promise<HTMLButtonElement> {
  fireEvent.click(await historyAction('Abrir'));
  await settle();
  expect(screen.getByRole('heading', { name: 'Victoria' })).toBeTruthy();
  const trigger = screen.getByRole('button', { name: 'Ver configuración' }) as HTMLButtonElement;
  trigger.focus();
  fireEvent.click(trigger);
  await settle();
  expect(screen.getByRole('heading', { name: 'Configuración del intento' })).toBeTruthy();
  return trigger;
}

function configurationPanel(): HTMLElement {
  return screen.getByRole('region', { name: 'Configuración consultada' });
}

function expectRecoveringConfiguration(): void {
  const panel = configurationPanel();
  expect.soft(within(panel).queryByRole('alert')).toBeNull();
  expect.soft(within(panel).queryByRole('status')).not.toBeNull();
  expect.soft(within(panel).queryByRole('button', { name: /Reintentar carga/i })).toBeNull();
}

function readSideEffectCounts(runner: AttemptApi, drafts: DraftApi) {
  return {
    create: vi.mocked(runner.createAttempt).mock.calls.length,
    start: vi.mocked(runner.startAttempt).mock.calls.length,
    cancel: vi.mocked(runner.cancelAttempt).mock.calls.length,
    ack: vi.mocked(runner.completePresentation).mock.calls.length,
    attemptRead: vi.mocked(runner.getAttempt).mock.calls.length,
    replayRead: vi.mocked(runner.getReplay).mock.calls.length,
    quota: vi.mocked(runner.getQuota).mock.calls.length,
    list: vi.mocked(runner.listAttempts).mock.calls.length,
    draftRead: vi.mocked(drafts.getDraft).mock.calls.length,
    draftWrite: vi.mocked(drafts.putDraft).mock.calls.length,
  };
}

function expectSideEffectCounts(
  runner: AttemptApi,
  drafts: DraftApi,
  before: ReturnType<typeof readSideEffectCounts>,
): void {
  expect(readSideEffectCounts(runner, drafts)).toEqual(before);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function httpConfigurationApi(responses: readonly (Response | Promise<Response>)[]) {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const response of responses) {
    fetchImpl.mockImplementationOnce(() => Promise.resolve(response));
  }
  const client = createAttemptApiClient(
    { apiBaseUrl: 'https://api.example.test/' },
    async () => 'access-token',
    fetchImpl,
  );
  const codes: string[] = [];
  const messages: string[] = [];
  const getConfiguration = vi.fn<AttemptApi['getConfiguration']>(async (id, signal) => {
    try {
      return await client.getConfiguration(id, signal);
    } catch (error) {
      if (error instanceof AttemptApiFailure) {
        codes.push(error.code);
        messages.push(error.message);
      }
      throw error;
    }
  });
  return { fetchImpl, getConfiguration, codes, messages };
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  if (originalVisibilityState) {
    Object.defineProperty(document, 'visibilityState', originalVisibilityState);
  } else {
    Reflect.deleteProperty(document, 'visibilityState');
  }
  if (originalHidden) {
    Object.defineProperty(document, 'hidden', originalHidden);
  } else {
    Reflect.deleteProperty(document, 'hidden');
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_NOW);
});

describe('GameWorkspace configuration query recovery', () => {
  it('recovers the same history configuration at one minute and preserves Mejores pages, context, and focus', async () => {
    const firstPage = [
      summary('history-best-first', 'victory', { score: 90 }),
      ...Array.from({ length: 19 }, (_, index) => summary(`history-defeat-${index}`, 'defeat')),
    ];
    const target = summary('history-best-second-page', 'victory', {
      createdAt: '2026-10-21T11:12:13.000Z',
      score: 160,
    });
    const listAttempts = vi.fn<AttemptApi['listAttempts']>((cursor) =>
      Promise.resolve(
        cursor === 'cursor-second-page'
          ? { attempts: [target] }
          : { attempts: firstPage, nextCursor: 'cursor-second-page' },
      ),
    );
    const getConfiguration = vi
      .fn<AttemptApi['getConfiguration']>()
      .mockRejectedValueOnce(new AttemptApiFailure('server', 'Configuration service down.', 503))
      .mockResolvedValueOnce(configuration(target.id, 'Configuración recuperada.'));
    const mounted = mountWorkspace({ listAttempts, getConfiguration });
    const history = await showHistory();
    expect(history.querySelectorAll('[data-history-row-id]')).toHaveLength(20);
    fireEvent.click(within(history).getByRole('button', { name: 'Cargar 20 más' }));
    await settle();
    expect(history.querySelectorAll('[data-history-row-id]')).toHaveLength(21);
    selectHistoryView('Mejores');
    await openHistoryConfiguration(formatDateTime(target.createdAt));
    await settle();

    expect(getConfiguration).toHaveBeenCalledTimes(1);
    expect(getConfiguration.mock.calls[0]?.[0]).toBe(target.id);
    expect(configurationPanel().textContent).toContain(
      `Historial, ${formatDateTime(target.createdAt)}`,
    );
    expectRecoveringConfiguration();
    const effectsBeforeRetry = readSideEffectCounts(mounted.runner, mounted.drafts);
    const historyReadsBeforeRetry = listAttempts.mock.calls.length;
    const close = within(configurationPanel()).getByRole('button', { name: 'Cerrar' });
    close.focus();

    await advance(MINUTE - 1);
    expect(getConfiguration).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(close);
    await advance(1);
    expect(getConfiguration.mock.calls.map(([id]) => id)).toEqual([target.id, target.id]);
    expect(screen.getByText('Configuración recuperada.')).toBeTruthy();
    expect(configurationPanel().textContent).toContain(
      `Historial, ${formatDateTime(target.createdAt)}`,
    );
    expect(document.activeElement).toBe(close);
    expectSideEffectCounts(mounted.runner, mounted.drafts, effectsBeforeRetry);

    fireEvent.click(close);
    await settle();
    const returnedHistory = historySection();
    expect(
      within(returnedHistory).getByRole('button', { name: 'Mejores' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(returnedHistory.querySelectorAll('[data-history-row-id]')).toHaveLength(2);
    expect(returnedHistory.querySelector('.history-count')?.textContent).toContain(
      '21 cargados, no hay más páginas',
    );
    expect(returnedHistory.querySelector(`[data-history-row-id="${target.id}"]`)).toBeTruthy();
    expect(listAttempts).toHaveBeenCalledTimes(historyReadsBeforeRetry);
    const returnedRow = returnedHistory.querySelector<HTMLElement>(
      `[data-history-row-id="${target.id}"]`,
    );
    expect(returnedRow).not.toBeNull();
    const visibleConfigurationAction = returnedRow?.querySelector<HTMLElement>(
      '[data-history-action="configuration"]',
    );
    expect(visibleConfigurationAction).not.toBeNull();
    const visibleReturnControl = visibleConfigurationAction?.closest('details')?.open
      ? within(returnedRow!).getByRole('button', { name: 'Ver configuración' })
      : within(returnedRow!).getByRole('button', { name: 'Abrir' });
    expect(document.activeElement).toBe(visibleReturnControl);
  });

  it('continues the read while the editor is unavailable and keeps only Usar disabled', async () => {
    const target = summary('configuration-editor-unavailable');
    const getConfiguration = vi
      .fn<AttemptApi['getConfiguration']>()
      .mockRejectedValueOnce(new AttemptApiFailure('server', 'Configuration service down.', 503))
      .mockResolvedValueOnce(configuration(target.id, 'Available when editor returns.'));
    const mounted = mountWorkspace(
      {
        listAttempts: vi.fn().mockResolvedValue({ attempts: [target] }),
        getConfiguration,
      },
      { configurationAvailable: false },
    );
    await showHistory();
    await openHistoryConfiguration();
    await settle();
    expect(getConfiguration).toHaveBeenCalledOnce();
    expectRecoveringConfiguration();
    const effectsBeforeRetry = readSideEffectCounts(mounted.runner, mounted.drafts);

    await advance(MINUTE - 1);
    expect(getConfiguration).toHaveBeenCalledOnce();
    await advance(1);
    expect(getConfiguration.mock.calls.map(([id]) => id)).toEqual([target.id, target.id]);
    expect(screen.getByText('Available when editor returns.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Usar esta configuración' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expectSideEffectCounts(mounted.runner, mounted.drafts, effectsBeforeRetry);
  });

  it('recovers a configuration opened from a history result without changing its origin or date', async () => {
    const target = summary('history-result-config', 'victory', {
      createdAt: '2026-10-22T10:11:12.000Z',
    });
    const getAttempt = vi.fn<AttemptApi['getAttempt']>().mockResolvedValue(target);
    const getConfiguration = vi
      .fn<AttemptApi['getConfiguration']>()
      .mockRejectedValueOnce(new AttemptApiFailure('server', 'Configuration service down.', 503))
      .mockResolvedValueOnce(configuration(target.id, 'Configuración de resultado recuperada.'));
    const mounted = mountWorkspace({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [target] }),
      getAttempt,
      getConfiguration,
    });
    await showHistory();
    const trigger = await openQueriedHistoryResultConfiguration();
    const effectsBeforeRetry = readSideEffectCounts(mounted.runner, mounted.drafts);
    const close = within(configurationPanel()).getByRole('button', { name: 'Cerrar' });
    close.focus();
    expect(configurationPanel().textContent).toContain(
      `Historial, ${formatDateTime(target.createdAt)}`,
    );
    expectRecoveringConfiguration();

    await advance(MINUTE);
    expect(getConfiguration.mock.calls.map(([id]) => id)).toEqual([target.id, target.id]);
    expect(screen.getByText('Configuración de resultado recuperada.')).toBeTruthy();
    expect(configurationPanel().textContent).toContain(
      `Historial, ${formatDateTime(target.createdAt)}`,
    );
    expect(document.activeElement).toBe(close);
    expectSideEffectCounts(mounted.runner, mounted.drafts, effectsBeforeRetry);
    expect(getAttempt).toHaveBeenCalledOnce();
    expect(trigger.isConnected).toBe(true);
  });

  it('recovers a current-result configuration from Preparar without applying or admitting again', async () => {
    const target = summary('preparation-current-result', 'defeat', {
      createdAt: '2026-10-23T08:09:10.000Z',
    });
    const currentDraft = { ...createDefaultDraft(), instructions: 'Editor literal conservado.' };
    const getConfiguration = vi
      .fn<AttemptApi['getConfiguration']>()
      .mockRejectedValueOnce(new AttemptApiFailure('server', 'Configuration service down.', 503))
      .mockResolvedValueOnce(configuration(target.id, 'Literal histórico recuperado.'));
    const mounted = mountWorkspace(
      {
        createAttempt: vi.fn().mockResolvedValue({ attempt: target, dispatchConfirmed: true }),
        getConfiguration,
      },
      {},
      currentDraft,
    );
    await settle();
    const trigger = await openCurrentResultConfiguration(target);
    const effectsBeforeRetry = readSideEffectCounts(mounted.runner, mounted.drafts);
    expect(configurationPanel().textContent).toContain(
      `Esta partida, ${formatDateTime(target.createdAt)}`,
    );
    expectRecoveringConfiguration();
    const close = within(configurationPanel()).getByRole('button', { name: 'Cerrar' });
    close.focus();

    await advance(MINUTE);
    expect(getConfiguration.mock.calls.map(([id]) => id)).toEqual([target.id, target.id]);
    expect(screen.getByText('Literal histórico recuperado.')).toBeTruthy();
    expect(configurationPanel().textContent).toContain(
      `Esta partida, ${formatDateTime(target.createdAt)}`,
    );
    expect(document.activeElement).toBe(close);
    expect((document.getElementById('robot-instructions') as HTMLTextAreaElement).value).toBe(
      currentDraft.instructions,
    );
    expectSideEffectCounts(mounted.runner, mounted.drafts, effectsBeforeRetry);
    expect(trigger.isConnected).toBe(true);
  });

  it('starts deadlines after a deferred GET ends, retries 503 and 429, then stops on a wrong-ID 200', async () => {
    const target = summary('deferred-configuration-get');
    const firstResponse = deferred<Response>();
    const http = httpConfigurationApi([
      firstResponse.promise,
      jsonResponse(503, { message: 'Configuration service down.' }),
      jsonResponse(429, { message: 'Gateway is busy.' }),
      jsonResponse(200, configuration('different-attempt-id', 'Wrong target payload.')),
    ]);
    const listAttempts = vi.fn().mockResolvedValue({ attempts: [target] });
    const mounted = mountWorkspace({ listAttempts, getConfiguration: http.getConfiguration });
    await showHistory();
    await openHistoryConfiguration();
    await settle();
    expect(http.fetchImpl).toHaveBeenCalledOnce();
    const effectsBeforeRetry = readSideEffectCounts(mounted.runner, mounted.drafts);

    await advance(2 * MINUTE);
    expect(http.fetchImpl).toHaveBeenCalledOnce();
    await act(async () => {
      firstResponse.resolve(jsonResponse(503, { message: 'First response was late.' }));
    });
    await settle();
    expect(http.codes).toEqual(['server']);
    expectRecoveringConfiguration();
    await advance(MINUTE - 1);
    expect(http.fetchImpl).toHaveBeenCalledOnce();
    await advance(1);
    expect(http.fetchImpl).toHaveBeenCalledTimes(2);
    expect(http.codes).toEqual(['server', 'server']);
    expectRecoveringConfiguration();
    await advance(MINUTE);
    expect(http.fetchImpl).toHaveBeenCalledTimes(3);
    expect(http.codes).toEqual(['server', 'server', 'attempt_unavailable']);
    expectRecoveringConfiguration();
    await advance(MINUTE);
    expect(http.fetchImpl).toHaveBeenCalledTimes(4);
    expect(http.codes).toHaveLength(3);
    expect(http.fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(
      Array(4).fill(`https://api.example.test/attempts/${target.id}/configuration`),
    );
    expect.soft(within(configurationPanel()).queryByRole('alert')).not.toBeNull();
    expect
      .soft(within(configurationPanel()).queryByRole('button', { name: 'Reintentar carga' }))
      .toBeNull();
    expect(screen.queryByText('Wrong target payload.')).toBeNull();
    await advance(2 * MINUTE);
    expect(http.fetchImpl).toHaveBeenCalledTimes(4);
    expectSideEffectCounts(mounted.runner, mounted.drafts, effectsBeforeRetry);
    expect(listAttempts).toHaveBeenCalledTimes(effectsBeforeRetry.list);
  });

  it('preserves the real 409 configuration_pending code and message and checks it every minute', async () => {
    const target = summary('pending-configuration-get');
    const pendingBody = {
      code: 'configuration_pending',
      message: 'La configuración solo está disponible para un intento cerrado.',
    };
    const http = httpConfigurationApi([
      jsonResponse(409, pendingBody),
      jsonResponse(409, pendingBody),
      jsonResponse(200, configuration(target.id, 'Configuración que quedó lista.')),
    ]);
    const mounted = mountWorkspace({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [target] }),
      getConfiguration: http.getConfiguration,
    });
    await showHistory();
    await openHistoryConfiguration();
    await settle();

    expect(http.fetchImpl).toHaveBeenCalledOnce();
    expect.soft(http.codes).toEqual(['pending']);
    expect(http.messages).toEqual([pendingBody.message]);
    expectRecoveringConfiguration();
    const effectsBeforeRetry = readSideEffectCounts(mounted.runner, mounted.drafts);
    await advance(MINUTE - 1);
    expect(http.fetchImpl).toHaveBeenCalledOnce();
    await advance(1);
    expect(http.fetchImpl).toHaveBeenCalledTimes(2);
    expect.soft(http.codes).toEqual(['pending', 'pending']);
    expect(http.messages).toEqual([pendingBody.message, pendingBody.message]);
    expectRecoveringConfiguration();
    await advance(MINUTE);
    expect(http.fetchImpl).toHaveBeenCalledTimes(3);
    expect(screen.getByText('Configuración que quedó lista.')).toBeTruthy();
    expectSideEffectCounts(mounted.runner, mounted.drafts, effectsBeforeRetry);
  });

  it('pauses a current authentication rejection until access is ready, then reads the same target once', async () => {
    const target = summary('configuration-current-auth');
    const getConfiguration = vi
      .fn<AttemptApi['getConfiguration']>()
      .mockRejectedValueOnce(
        new AttemptApiFailure('authentication', 'Access denied.', 401, false, { authContext: 1 }),
      )
      .mockResolvedValueOnce(configuration(target.id, 'Access is ready.'));
    const mounted = mountWorkspace({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [target] }),
      getConfiguration,
    });
    const onAuthRequired = vi.fn<ApiAuthRequired>((context) => {
      mounted.update({ authPaused: true });
      return context === 1;
    });
    mounted.update({ onAuthRequired });
    await showHistory();
    await openHistoryConfiguration();
    await settle();

    expect(onAuthRequired).toHaveBeenCalledWith(1);
    expect(getConfiguration).toHaveBeenCalledOnce();
    await advance(2 * MINUTE);
    expect(getConfiguration).toHaveBeenCalledOnce();
    mounted.update({ authPaused: false });
    await settle();
    expect(getConfiguration.mock.calls.map(([id]) => id)).toEqual([target.id, target.id]);
    expect(screen.getByText('Access is ready.')).toBeTruthy();
  });

  it('uses the current API after App declines a stale auth context, at the original minute deadline', async () => {
    const target = summary('configuration-stale-auth');
    const oldGet = vi.fn<AttemptApi['getConfiguration']>().mockRejectedValue(
      new AttemptApiFailure('authentication', 'Old access rejected.', 401, false, {
        authContext: 42,
      }),
    );
    const currentApi = attemptApi({
      getConfiguration: vi
        .fn<AttemptApi['getConfiguration']>()
        .mockResolvedValue(configuration(target.id, 'Recovered with current API.')),
    });
    const oldApi = attemptApi({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [target] }),
      getConfiguration: oldGet,
    });
    const onAuthRequired = vi.fn<ApiAuthRequired>().mockReturnValue(false);
    const mounted = mountWorkspace({}, { onAuthRequired });
    mounted.update({ attemptApi: oldApi });
    await showHistory();
    await openHistoryConfiguration();
    await settle();

    expect(onAuthRequired).toHaveBeenCalledWith(42);
    expectRecoveringConfiguration();
    await advance(MINUTE - 1);
    expect(vi.mocked(currentApi.getConfiguration)).not.toHaveBeenCalled();
    mounted.update({ attemptApi: currentApi });
    await advance(1);
    await settle();
    expect(oldGet).toHaveBeenCalledOnce();
    expect(vi.mocked(currentApi.getConfiguration).mock.calls.map(([id]) => id)).toEqual([
      target.id,
    ]);
    expect(screen.getByText('Recovered with current API.')).toBeTruthy();
  });

  it('keeps the failed configuration deadline while hidden and performs one read on wake', async () => {
    const target = summary('configuration-hidden-deadline');
    const getConfiguration = vi
      .fn<AttemptApi['getConfiguration']>()
      .mockRejectedValueOnce(new AttemptApiFailure('server', 'Temporary failure.', 503))
      .mockResolvedValueOnce(configuration(target.id, 'Woke once.'));
    mountWorkspace({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [target] }),
      getConfiguration,
    });
    await showHistory();
    await openHistoryConfiguration();
    await settle();
    expectRecoveringConfiguration();
    setDocumentHidden(true);
    await advance(MINUTE + 5_000);
    expect(getConfiguration).toHaveBeenCalledOnce();
    setDocumentHidden(false);
    fireEvent.focus(window);
    fireEvent(document, new Event('visibilitychange'));
    fireEvent.focus(window);
    await settle();
    expect(getConfiguration).toHaveBeenCalledTimes(2);
    expect(getConfiguration.mock.calls.map(([id]) => id)).toEqual([target.id, target.id]);
    expect(screen.getByText('Woke once.')).toBeTruthy();
    await advance(MINUTE);
    expect(getConfiguration).toHaveBeenCalledTimes(2);
  });

  it.each(['access', 'document visibility'] as const)(
    'aborts a deferred configuration read on %s pause and starts one fresh read on resume',
    async (pauseKind) => {
      const target = summary(`configuration-deferred-${pauseKind.replaceAll(' ', '-')}`);
      const staleRead = deferred<AttemptConfiguration>();
      let staleSignal: AbortSignal | undefined;
      const getConfiguration = vi
        .fn<AttemptApi['getConfiguration']>()
        .mockImplementationOnce((_id, signal) => {
          staleSignal = signal;
          return staleRead.promise;
        })
        .mockResolvedValueOnce(configuration(target.id, 'Fresh read after pause.'));
      const mounted = mountWorkspace({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [target] }),
        getConfiguration,
      });
      await showHistory();
      await openHistoryConfiguration();
      await settle();
      expect(getConfiguration).toHaveBeenCalledOnce();

      if (pauseKind === 'access') mounted.update({ authPaused: true });
      else setDocumentHidden(true);
      await settle();
      expect.soft(staleSignal?.aborted).toBe(true);
      await act(async () => {
        staleRead.resolve(configuration(target.id, 'Stale response must be ignored.'));
      });
      await settle();
      expect.soft(screen.queryByText('Stale response must be ignored.')).toBeNull();
      await advance(2 * MINUTE);
      expect(getConfiguration).toHaveBeenCalledOnce();

      if (pauseKind === 'access') mounted.update({ authPaused: false });
      else setDocumentHidden(false);
      await settle();
      expect(getConfiguration.mock.calls.map(([id]) => id)).toEqual([target.id, target.id]);
      expect(screen.getByText('Fresh read after pause.')).toBeTruthy();
    },
  );

  it('does not advance or restart the configuration deadline when visibility pauses before expiry', async () => {
    const target = summary('configuration-visibility-before-deadline');
    const getConfiguration = vi
      .fn<AttemptApi['getConfiguration']>()
      .mockRejectedValueOnce(new AttemptApiFailure('server', 'Temporary failure.', 503))
      .mockResolvedValueOnce(configuration(target.id, 'Deadline preserved.'));
    mountWorkspace({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [target] }),
      getConfiguration,
    });
    await showHistory();
    await openHistoryConfiguration();
    await settle();

    await advance(30_000);
    setDocumentHidden(true);
    await advance(10_000);
    setDocumentHidden(false);
    await settle();
    await advance(MINUTE - 40_001);
    expect(getConfiguration).toHaveBeenCalledOnce();
    await advance(1);
    expect(getConfiguration).toHaveBeenCalledTimes(2);
    expect(getConfiguration.mock.calls.map(([id]) => id)).toEqual([target.id, target.id]);
  });

  it.each(['close', 'surface change', 'identity change', 'unmount'] as const)(
    'aborts and invalidates a deferred configuration request after %s',
    async (change) => {
      const target = summary(`configuration-cancel-${change.replaceAll(' ', '-')}`);
      const oldRead = deferred<AttemptConfiguration>();
      let oldSignal: AbortSignal | undefined;
      const getConfiguration = vi
        .fn<AttemptApi['getConfiguration']>()
        .mockImplementationOnce((_id, signal) => {
          oldSignal = signal;
          return oldRead.promise;
        });
      const mounted = mountWorkspace({
        listAttempts: vi.fn().mockResolvedValue({ attempts: [target] }),
        getConfiguration,
      });
      await showHistory();
      await openHistoryConfiguration();
      await settle();
      expect(getConfiguration).toHaveBeenCalledOnce();

      if (change === 'close') {
        fireEvent.click(within(configurationPanel()).getByRole('button', { name: 'Cerrar' }));
      } else if (change === 'surface change') {
        selectSurface('Mis robots');
      } else if (change === 'identity change') {
        mounted.update({ session: session('subject-b') });
      } else {
        mounted.unmount();
      }
      await settle();
      expect(oldSignal?.aborted).toBe(true);
      await act(async () => {
        oldRead.resolve(configuration(target.id, 'Late config must not display.'));
      });
      await settle();
      await advance(2 * MINUTE);
      expect(getConfiguration).toHaveBeenCalledOnce();
      expect(screen.queryByText('Late config must not display.')).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Configuración del intento' })).toBeNull();
    },
  );

  it.each(['success', 'authentication rejection'] as const)(
    'does not let an old %s or its finalizer affect a newly selected configuration',
    async (lateOutcome) => {
      const first = summary('configuration-old-target', 'defeat');
      const second = summary('configuration-new-target', 'victory', {
        createdAt: '2026-10-25T12:34:56.000Z',
      });
      const oldRead = deferred<AttemptConfiguration>();
      const currentRead = deferred<AttemptConfiguration>();
      const nextRead = deferred<AttemptConfiguration>();
      const signals = new Map<string, AbortSignal>();
      const getConfiguration = vi
        .fn<AttemptApi['getConfiguration']>()
        .mockImplementationOnce((_id, signal) => {
          signals.set(first.id, signal!);
          return oldRead.promise;
        })
        .mockImplementationOnce((_id, signal) => {
          signals.set(second.id, signal!);
          return currentRead.promise;
        })
        .mockImplementationOnce((_id, signal) => {
          signals.set(`${second.id}-fresh`, signal!);
          return nextRead.promise;
        });
      const onAuthRequired = vi.fn<ApiAuthRequired>().mockReturnValue(true);
      mountWorkspace(
        {
          listAttempts: vi.fn().mockResolvedValue({ attempts: [first, second] }),
          getConfiguration,
        },
        { onAuthRequired },
      );
      await showHistory();
      await openHistoryConfiguration('Derrota');
      fireEvent.click(within(configurationPanel()).getByRole('button', { name: 'Cerrar' }));
      await settle();
      await openHistoryConfiguration(formatDateTime(second.createdAt));
      expect(getConfiguration).toHaveBeenCalledTimes(2);
      expect(signals.get(first.id)?.aborted).toBe(true);

      if (lateOutcome === 'success') {
        await act(async () => {
          oldRead.resolve(configuration(first.id, 'Old target response.'));
        });
      } else {
        await act(async () => {
          oldRead.reject(
            new AttemptApiFailure('authentication', 'Old target rejected.', 401, false, {
              authContext: 42,
            }),
          );
        });
      }
      await settle();
      expect(onAuthRequired).not.toHaveBeenCalled();
      expect(within(configurationPanel()).getByText(`Intento: ${second.id}`)).toBeTruthy();
      expect(within(configurationPanel()).queryByRole('alert')).toBeNull();
      expect(signals.get(second.id)?.aborted).toBe(false);

      fireEvent.click(within(configurationPanel()).getByRole('button', { name: 'Cerrar' }));
      await settle();
      expect(signals.get(second.id)?.aborted).toBe(true);
      await act(async () => {
        currentRead.resolve(configuration(second.id, 'Closed second response.'));
      });
      await settle();
      expect(screen.queryByText('Closed second response.')).toBeNull();

      await openHistoryConfiguration(formatDateTime(second.createdAt));
      expect(getConfiguration).toHaveBeenCalledTimes(3);
      await act(async () => {
        nextRead.resolve(configuration(second.id, 'Fresh selected config.'));
      });
      await settle();
      expect(screen.getByText('Fresh selected config.')).toBeTruthy();
    },
  );

  it.each([
    {
      name: 'HTTP 404 not found',
      response: jsonResponse(404, { code: 'not_found', message: 'Missing configuration.' }),
      expectedCode: 'not_found',
    },
    {
      name: 'HTTP 400 invalid',
      response: jsonResponse(400, { code: 'invalid', message: 'Invalid configuration query.' }),
      expectedCode: 'invalid',
    },
    {
      name: 'HTTP 409 conflict',
      response: jsonResponse(409, { code: 'conflict', message: 'Configuration changed.' }),
      expectedCode: 'conflict',
    },
    {
      name: 'HTTP 409 configuration incompatible',
      response: jsonResponse(409, {
        code: 'configuration_incompatible',
        message: 'Stored configuration is incompatible.',
      }),
      expectedCode: 'incompatible',
    },
    {
      name: 'HTTP 500 stored attempt incompatible',
      response: jsonResponse(500, {
        code: 'stored_attempt_incompatible',
        message: 'Stored attempt is incompatible.',
      }),
      expectedCode: 'incompatible',
    },
    {
      name: 'malformed HTTP 200 body',
      response: jsonResponse(200, {}),
      expectedCode: 'server',
    },
  ])('does not retry a definitive $name response', async ({ response, expectedCode }) => {
    const target = summary(`configuration-definitive-${expectedCode}-${response.status}`);
    const http = httpConfigurationApi([response]);
    mountWorkspace({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [target] }),
      getConfiguration: http.getConfiguration,
    });
    await showHistory();
    await openHistoryConfiguration();
    await settle();
    expect.soft(within(configurationPanel()).queryByRole('alert')).not.toBeNull();
    expect
      .soft(within(configurationPanel()).queryByRole('button', { name: 'Reintentar carga' }))
      .toBeNull();
    expect.soft(http.codes).toEqual([expectedCode]);
    expect(configurationPanel().textContent).toContain(
      `Historial, ${formatDateTime(target.createdAt)}`,
    );
    expect(within(configurationPanel()).getByRole('button', { name: 'Cerrar' })).toBeTruthy();
    await advance(2 * MINUTE);
    expect(http.fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not restart configuration GET recovery after an explicit D2 application error', async () => {
    const target = summary('configuration-d2-error');
    const getConfiguration = vi
      .fn<AttemptApi['getConfiguration']>()
      .mockResolvedValue(configuration(target.id, 'Explicit candidate.'));
    const mounted = mountWorkspace({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [target] }),
      getConfiguration,
    });
    await showHistory();
    await openHistoryConfiguration();
    await settle();
    expect(getConfiguration).toHaveBeenCalledOnce();
    expect(screen.getByText('Explicit candidate.')).toBeTruthy();
    const applyDraft = vi.fn().mockRejectedValue(new Error('D2 application failed.'));
    mounted.editor.current!.applyDraft = applyDraft;
    fireEvent.click(screen.getByRole('button', { name: 'Usar esta configuración' }));
    await settle();
    expect(within(configurationPanel()).getByRole('alert').textContent).toContain(
      'D2 application failed.',
    );
    expect(applyDraft).toHaveBeenCalledOnce();

    await advance(MINUTE);
    expect(getConfiguration).toHaveBeenCalledOnce();
    expect(applyDraft).toHaveBeenCalledOnce();
    expect(mounted.drafts.putDraft).not.toHaveBeenCalled();
    expect(mounted.runner.createAttempt).not.toHaveBeenCalled();
  });

  it('does not restart configuration GET recovery after an explicit D2 application is canceled', async () => {
    const target = summary('configuration-d2-cancel');
    const getConfiguration = vi
      .fn<AttemptApi['getConfiguration']>()
      .mockResolvedValue(configuration(target.id, 'Candidate canceled by the user.'));
    const mounted = mountWorkspace({
      listAttempts: vi.fn().mockResolvedValue({ attempts: [target] }),
      getConfiguration,
    });
    await showHistory();
    await openHistoryConfiguration();
    await settle();
    const application = deferred<boolean>();
    let applicationSignal: AbortSignal | undefined;
    const applyDraft = vi.fn<RobotEditorHandle['applyDraft']>((_draft, options) => {
      applicationSignal = options?.signal;
      return application.promise;
    });
    mounted.editor.current!.applyDraft = applyDraft;

    fireEvent.click(screen.getByRole('button', { name: 'Usar esta configuración' }));
    await settle();
    expect(screen.getByText('Aplicando configuración…')).toBeTruthy();
    expect(applicationSignal).toBeInstanceOf(AbortSignal);
    fireEvent.click(within(configurationPanel()).getByRole('button', { name: 'Cerrar' }));
    await settle();
    expect(applicationSignal?.aborted).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Configuración del intento' })).toBeNull();

    await advance(MINUTE);
    expect(getConfiguration).toHaveBeenCalledOnce();
    expect(applyDraft).toHaveBeenCalledOnce();
    expect(mounted.drafts.putDraft).not.toHaveBeenCalled();
    expect(mounted.runner.createAttempt).not.toHaveBeenCalled();
    await act(async () => {
      application.resolve(false);
    });
    await settle();
    expect(screen.queryByText('Candidate canceled by the user.')).toBeNull();
  });
});
