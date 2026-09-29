import {
  validateDraft,
  validateSavedRobotName,
  type RobotDraft,
  type SavedRobot,
  type SavedRobotSummary,
} from '../../../shared/robot.js';
import { isModelKey } from '../../../shared/models.js';
import type { AuthConfig } from './auth.js';

export interface SavedRobotsPage {
  readonly robots: readonly SavedRobotSummary[];
  readonly nextCursor?: string;
}

export interface SavedRobotDeleteResult {
  readonly deleted: true;
}

export type SavedRobotApiFailureCode =
  'authentication' | 'conflict' | 'not_found' | 'invalid' | 'network' | 'server';

export class SavedRobotApiFailure extends Error {
  public constructor(
    public readonly code: SavedRobotApiFailureCode,
    message: string,
    public readonly status?: number,
    public readonly current?: SavedRobot,
    public readonly ambiguous = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SavedRobotApiFailure';
  }
}

export interface SavedRobotApi {
  listRobots(cursor?: string, signal?: AbortSignal): Promise<SavedRobotsPage>;
  getRobot(id: string, signal?: AbortSignal): Promise<SavedRobot>;
  saveRobot(
    id: string,
    expectedVersion: number,
    name: string,
    draft: RobotDraft,
    signal?: AbortSignal,
  ): Promise<SavedRobot>;
  deleteRobot(
    id: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<SavedRobotDeleteResult>;
}

export type SavedRobotTokenProvider = () => string | Promise<string>;

export interface SavedRobotApiClientOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly tokenProvider: SavedRobotTokenProvider;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requiredString = (value: Record<string, unknown>, key: string): string | null =>
  typeof value[key] === 'string' && value[key].trim() !== '' ? value[key] : null;

const requiredVersion = (value: Record<string, unknown>): number | null =>
  typeof value.version === 'number' && Number.isInteger(value.version) && value.version >= 0
    ? value.version
    : null;

function parseSummary(value: unknown): SavedRobotSummary | null {
  if (!isRecord(value)) return null;
  const id = requiredString(value, 'id');
  const rawName = requiredString(value, 'name');
  const version = requiredVersion(value);
  const createdAt = requiredString(value, 'createdAt');
  const updatedAt = requiredString(value, 'updatedAt');
  const modelKey = value.modelKey;
  if (!id || !rawName || version === null || !createdAt || !updatedAt) return null;
  try {
    const name = validateSavedRobotName(rawName);
    if (!isModelKey(modelKey)) return null;
    return {
      id,
      name,
      version,
      createdAt,
      updatedAt,
      modelKey: modelKey as SavedRobotSummary['modelKey'],
    };
  } catch {
    return null;
  }
}

function parseSavedRobot(value: unknown): SavedRobot | null {
  if (!isRecord(value)) return null;
  const summary = parseSummary(value);
  if (!summary) return null;
  try {
    return { ...summary, draft: validateDraft(value.draft) };
  } catch {
    return null;
  }
}

function parsePage(value: unknown): SavedRobotsPage | null {
  if (!isRecord(value) || !Array.isArray(value.robots)) return null;
  const robots = value.robots.map(parseSummary);
  if (robots.some((robot): robot is null => robot === null)) return null;
  if (value.nextCursor !== undefined && typeof value.nextCursor !== 'string') return null;
  return {
    robots: robots as SavedRobotSummary[],
    ...(typeof value.nextCursor === 'string' && value.nextCursor.length > 0
      ? { nextCursor: value.nextCursor }
      : {}),
  };
}

function parseDeleteResult(value: unknown): SavedRobotDeleteResult | null {
  return isRecord(value) && value.deleted === true ? { deleted: true } : null;
}

function errorMessage(body: unknown, fallback: string): string {
  return isRecord(body) && typeof body.message === 'string' && body.message.trim() !== ''
    ? body.message
    : fallback;
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function bindFetch(fetchImpl: typeof globalThis.fetch): typeof globalThis.fetch {
  return fetchImpl.bind(globalThis);
}

function validateSaveInput(name: string, draft: RobotDraft): { name: string; draft: RobotDraft } {
  try {
    return { name: validateSavedRobotName(name), draft: validateDraft(draft) };
  } catch (error) {
    throw new SavedRobotApiFailure(
      'invalid',
      error instanceof Error ? error.message : 'La configuración del robot no es válida.',
    );
  }
}

export class SavedRobotApiClient implements SavedRobotApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly tokenProvider: SavedRobotTokenProvider;

  public constructor(config: Pick<AuthConfig, 'apiBaseUrl'>, options: SavedRobotApiClientOptions) {
    this.baseUrl = config.apiBaseUrl.endsWith('/') ? config.apiBaseUrl : `${config.apiBaseUrl}/`;
    this.fetchImpl = bindFetch(options.fetch ?? globalThis.fetch);
    this.tokenProvider = options.tokenProvider;
  }

  public listRobots(cursor?: string, signal?: AbortSignal): Promise<SavedRobotsPage> {
    const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.request(
      'GET',
      `robots${suffix}`,
      undefined,
      parsePage,
      'No se pudieron cargar tus robots guardados.',
      signal,
    );
  }

  public getRobot(id: string, signal?: AbortSignal): Promise<SavedRobot> {
    return this.request(
      'GET',
      `robots/${encodeURIComponent(id)}`,
      undefined,
      parseSavedRobot,
      'No se pudo cargar el robot guardado.',
      signal,
    );
  }

  public async saveRobot(
    id: string,
    expectedVersion: number,
    name: string,
    draft: RobotDraft,
    signal?: AbortSignal,
  ): Promise<SavedRobot> {
    const input = validateSaveInput(name, draft);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new SavedRobotApiFailure('invalid', 'La versión del robot no es válida.');
    }
    return this.request(
      'PUT',
      `robots/${encodeURIComponent(id)}`,
      { expectedVersion, name: input.name, draft: input.draft },
      parseSavedRobot,
      'No se pudo guardar el robot guardado.',
      signal,
    );
  }

  public deleteRobot(
    id: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<SavedRobotDeleteResult> {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      return Promise.reject(
        new SavedRobotApiFailure('invalid', 'La versión del robot no es válida.'),
      );
    }
    return this.request(
      'DELETE',
      `robots/${encodeURIComponent(id)}`,
      { expectedVersion },
      parseDeleteResult,
      'No se pudo eliminar el robot guardado.',
      signal,
    );
  }

  private async request<T>(
    method: 'GET' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
    parser: (value: unknown) => T | null,
    invalidMessage: string,
    signal?: AbortSignal,
  ): Promise<T> {
    let token: string;
    try {
      token = await this.tokenProvider();
    } catch (error) {
      throw new SavedRobotApiFailure(
        'authentication',
        'La sesión no tiene un token de acceso.',
        undefined,
        undefined,
        false,
        { cause: error },
      );
    }
    if (!token) {
      throw new SavedRobotApiFailure('authentication', 'La sesión no tiene un token de acceso.');
    }
    const write = method !== 'GET';
    const init: RequestInit = {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    };
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new SavedRobotApiFailure('network', invalidMessage, undefined, undefined, write, {
        cause: error,
      });
    }
    const parsed = await readBody(response);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new SavedRobotApiFailure(
          'authentication',
          errorMessage(parsed, 'Tu sesión ya no tiene acceso a los robots guardados.'),
          response.status,
        );
      }
      if (response.status === 404) {
        throw new SavedRobotApiFailure(
          'not_found',
          errorMessage(parsed, 'No se encontró ese robot guardado.'),
          response.status,
        );
      }
      if (response.status === 409) {
        const current = isRecord(parsed)
          ? (parseSavedRobot(parsed.current) ?? undefined)
          : undefined;
        throw new SavedRobotApiFailure(
          'conflict',
          errorMessage(parsed, 'El robot guardado cambió en otra pestaña.'),
          response.status,
          current,
        );
      }
      throw new SavedRobotApiFailure(
        response.status >= 400 && response.status < 500 ? 'invalid' : 'server',
        errorMessage(parsed, invalidMessage),
        response.status,
        undefined,
        write,
      );
    }
    const result = parser(parsed);
    if (result === null) {
      throw new SavedRobotApiFailure('server', invalidMessage, response.status, undefined, write);
    }
    return result;
  }
}

export function createSavedRobotApiClient(
  config: Pick<AuthConfig, 'apiBaseUrl'>,
  tokenProvider: SavedRobotTokenProvider,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): SavedRobotApi {
  return new SavedRobotApiClient(config, { tokenProvider, fetch: fetchImpl });
}
