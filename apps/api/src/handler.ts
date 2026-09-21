import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  DraftConflictError,
  DraftIncompatibleError,
  DraftStorageError,
  createDynamoDraftStore,
  type DraftStore,
} from './draft.js';
import { DraftValidationError, type RobotDraft, validateDraft } from '../../../shared/robot.js';
import {
  AdmissionConflictError,
  AttemptStoreError,
  IdempotencyConflictError,
  QuotaExceededError,
  createDynamoAttemptStore,
  type AttemptStore,
} from './attempt-store.js';
import { summaryOf, type PersistedAttempt } from '../../../shared/server/attempt.js';

const APPLICATION_SCOPE = 'prompt-runner/robot';
const STORED_DRAFT_INCOMPATIBLE_MESSAGE =
  'El borrador guardado no es compatible con la versión actual.';

interface Identity {
  readonly sub: string;
}

interface HandlerDependencies {
  readonly store?: DraftStore;
  readonly fetch?: typeof fetch;
  readonly clientId?: string;
  readonly userInfoUrl?: string;
  readonly attemptStore?: AttemptStore;
  readonly dispatch?: (attemptId: string, owner: string) => Promise<void>;
}

class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  public constructor(statusCode: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const requestMethod = (event: APIGatewayProxyEventV2): string =>
  event.requestContext?.http?.method?.toUpperCase() ?? 'UNKNOWN';

const respond = (
  event: APIGatewayProxyEventV2,
  statusCode: number,
  code: string,
  body: unknown,
): APIGatewayProxyStructuredResultV2 => {
  const attemptId = (body as { attempt?: { id?: unknown } } | null)?.attempt?.id;
  console.log(
    JSON.stringify({
      requestId: event.requestContext?.requestId ?? 'unknown',
      method: requestMethod(event),
      status: statusCode,
      code,
      ...(typeof attemptId === 'string' ? { attemptId } : {}),
    }),
  );
  return jsonResponse(statusCode, body);
};

const jsonResponse = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  },
  body: JSON.stringify(body),
});

const headerValue = (event: APIGatewayProxyEventV2, name: string): string | undefined => {
  const header = Object.entries(event.headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return header?.[1];
};

const bearerToken = (event: APIGatewayProxyEventV2): string => {
  const authorization = headerValue(event, 'authorization');
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    throw new ApiError(401, 'unauthorized', 'Se necesita un token de acceso.');
  }
  return match[1];
};

const authorizerClaims = (event: APIGatewayProxyEventV2): Record<string, unknown> => {
  const context = event.requestContext as typeof event.requestContext & {
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
  };
  const claims = context.authorizer?.jwt?.claims;
  if (!claims) {
    throw new ApiError(401, 'unauthorized', 'La sesión no está autorizada.');
  }
  return claims;
};

const claimString = (claims: Record<string, unknown>, key: string): string | undefined => {
  const value = claims[key];
  return typeof value === 'string' ? value : undefined;
};

const verifyIdentity = async (
  event: APIGatewayProxyEventV2,
  dependencies: Required<Pick<HandlerDependencies, 'clientId' | 'userInfoUrl'>> &
    Pick<HandlerDependencies, 'fetch'>,
): Promise<Identity> => {
  const claims = authorizerClaims(event);
  const sub = claimString(claims, 'sub');
  if (!sub || sub.trim() === '' || claimString(claims, 'token_use') !== 'access') {
    throw new ApiError(403, 'forbidden', 'El token no es un access token válido.');
  }
  if (claimString(claims, 'client_id') !== dependencies.clientId) {
    throw new ApiError(403, 'forbidden', 'El token no pertenece a esta aplicación.');
  }
  const scopes = claimString(claims, 'scope')?.split(/\s+/u).filter(Boolean) ?? [];
  if (!scopes.includes(APPLICATION_SCOPE)) {
    throw new ApiError(403, 'forbidden', 'El token no tiene el alcance requerido.');
  }

  const token = bearerToken(event);
  let response: Response;
  try {
    response = await (dependencies.fetch ?? fetch)(dependencies.userInfoUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new ApiError(503, 'dependency_unavailable', 'No se pudo comprobar la identidad.', {
      cause: error,
    });
  }
  if (response.status === 401 || response.status === 403) {
    throw new ApiError(401, 'unauthorized', 'La sesión ya no está autorizada.');
  }
  if (!response.ok) {
    throw new ApiError(
      503,
      'dependency_unavailable',
      'El proveedor de identidad no respondió correctamente.',
    );
  }

  let userInfo: unknown;
  try {
    userInfo = await response.json();
  } catch (error) {
    throw new ApiError(503, 'dependency_unavailable', 'La respuesta de identidad no es válida.', {
      cause: error,
    });
  }
  if (
    typeof userInfo !== 'object' ||
    userInfo === null ||
    Array.isArray(userInfo) ||
    typeof (userInfo as Record<string, unknown>).sub !== 'string' ||
    (userInfo as Record<string, unknown>).sub !== sub
  ) {
    throw new ApiError(403, 'forbidden', 'La identidad no coincide con la sesión.');
  }
  const emailVerified = (userInfo as Record<string, unknown>).email_verified;
  if (emailVerified !== true && emailVerified !== 'true') {
    throw new ApiError(403, 'forbidden', 'La cuenta todavía no está verificada.');
  }
  return { sub };
};

const requestPath = (event: APIGatewayProxyEventV2): string =>
  event.rawPath || event.requestContext.http.path;

const requestBody = (event: APIGatewayProxyEventV2): unknown => {
  if (!event.body) {
    throw new ApiError(400, 'invalid', 'Falta el cuerpo de la solicitud.');
  }
  let text: string;
  try {
    text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  } catch (error) {
    throw new ApiError(400, 'invalid', 'El cuerpo de la solicitud no es válido.', { cause: error });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ApiError(400, 'invalid', 'El cuerpo debe ser JSON válido.', { cause: error });
  }
};

const attemptInput = (
  value: unknown,
): { requestKey: string; expectedVersion: number; draft: RobotDraft } => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'invalid', 'La solicitud de intento no es válida.');
  }
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).some((key) => !['requestKey', 'expectedVersion', 'draft'].includes(key))
  ) {
    throw new ApiError(400, 'invalid', 'La solicitud de intento no es válida.');
  }
  if (
    typeof object.requestKey !== 'string' ||
    object.requestKey.length < 1 ||
    object.requestKey.length > 256
  ) {
    throw new ApiError(400, 'invalid', 'requestKey debe ser una cadena de hasta 256 caracteres.');
  }
  if (
    typeof object.expectedVersion !== 'number' ||
    !Number.isSafeInteger(object.expectedVersion) ||
    object.expectedVersion < 0 ||
    object.expectedVersion === Number.MAX_SAFE_INTEGER
  ) {
    throw new ApiError(400, 'invalid', 'expectedVersion debe ser un entero no negativo.');
  }
  try {
    return {
      requestKey: object.requestKey,
      expectedVersion: object.expectedVersion,
      draft: validateDraft(object.draft),
    };
  } catch (error) {
    if (error instanceof DraftValidationError)
      throw new ApiError(error.code === 'too_large' ? 413 : 400, error.code, error.message, {
        cause: error,
      });
    throw error;
  }
};

const dispatchDefault = async (attemptId: string, owner: string): Promise<void> => {
  const functionName = process.env.STARTER_FUNCTION_NAME;
  if (!functionName) throw new Error('Falta STARTER_FUNCTION_NAME.');
  const client = new LambdaClient({});
  await client.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ attemptId, owner }), 'utf8'),
    }),
  );
};

const dispatchAttempt = async (
  dependencies: HandlerDependencies,
  attemptId: string,
  owner: string,
): Promise<boolean> => {
  try {
    await (dependencies.dispatch ?? dispatchDefault)(attemptId, owner);
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({
        component: 'starter-dispatch',
        attemptId,
        owner,
        code: error instanceof Error ? error.name : 'unknown',
      }),
    );
    return false;
  }
};

const pathParts = (event: APIGatewayProxyEventV2): string[] =>
  requestPath(event).split('/').filter(Boolean);
const summaryResponse = (attempt: PersistedAttempt): Record<string, unknown> => ({
  attempt: summaryOf(attempt),
});

const putInput = (value: unknown): { expectedVersion: number; draft: RobotDraft } => {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !Object.prototype.hasOwnProperty.call(value, 'expectedVersion') ||
    !Object.prototype.hasOwnProperty.call(value, 'draft') ||
    Object.keys(value).some((key) => key !== 'expectedVersion' && key !== 'draft')
  ) {
    throw new ApiError(400, 'invalid', 'La solicitud debe incluir expectedVersion y draft.');
  }
  const input = value as { expectedVersion: unknown; draft: unknown };
  if (
    typeof input.expectedVersion !== 'number' ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    input.expectedVersion === Number.MAX_SAFE_INTEGER
  ) {
    throw new ApiError(400, 'invalid', 'expectedVersion debe ser un entero no negativo.');
  }
  try {
    return { expectedVersion: input.expectedVersion, draft: validateDraft(input.draft) };
  } catch (error) {
    if (error instanceof DraftValidationError) {
      throw new ApiError(error.code === 'too_large' ? 413 : 400, error.code, error.message, {
        cause: error,
      });
    }
    throw error;
  }
};

const currentConflict = (error: DraftConflictError): Record<string, unknown> => ({
  code: 'conflict',
  message: error.message,
  current: error.current,
});

const configFrom = (dependencies: HandlerDependencies) => {
  const clientId = dependencies.clientId ?? process.env.COGNITO_CLIENT_ID;
  const userInfoUrl = dependencies.userInfoUrl ?? process.env.COGNITO_USERINFO_URL;
  if (!clientId || !userInfoUrl) {
    throw new ApiError(500, 'configuration', 'Falta la configuración de identidad de la API.');
  }
  try {
    const parsed = new URL(userInfoUrl);
    if (parsed.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
  } catch (error) {
    throw new ApiError(500, 'configuration', 'La URL de UserInfo no es válida.', { cause: error });
  }
  return { clientId, userInfoUrl };
};

export const handleRequest = async (
  event: APIGatewayProxyEventV2,
  dependencies: HandlerDependencies = {},
): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    const method = event.requestContext.http.method.toUpperCase();
    const parts = pathParts(event);
    const isDraft = parts.length === 1 && parts[0] === 'draft';
    const isAttemptCollection = parts.length === 1 && parts[0] === 'attempts';
    const isAttemptRequest = parts.length === 2 && parts[0] === 'attempt-requests';
    const isAttemptItem = parts.length === 2 && parts[0] === 'attempts';
    const isAttemptAction =
      parts.length === 3 &&
      parts[0] === 'attempts' &&
      (parts[2] === 'start' || parts[2] === 'cancel');
    const isQuota = parts.length === 1 && parts[0] === 'quota';
    const supported =
      (isDraft && (method === 'GET' || method === 'PUT')) ||
      (isAttemptCollection && (method === 'GET' || method === 'POST')) ||
      (isAttemptRequest && method === 'GET') ||
      (isAttemptItem && method === 'GET') ||
      (isAttemptAction && method === 'POST') ||
      (isQuota && method === 'GET');
    if (!supported) {
      return respond(event, 404, 'not_found', {
        code: 'not_found',
        message: 'Ruta no encontrada.',
      });
    }
    if (
      event.queryStringParameters?.owner !== undefined ||
      event.queryStringParameters?.sub !== undefined
    ) {
      return respond(event, 400, 'invalid', {
        code: 'invalid',
        message: 'El propietario lo determina la sesión.',
      });
    }
    const config = configFrom(dependencies);
    const identity = await verifyIdentity(event, { ...config, fetch: dependencies.fetch });
    const draftStore = dependencies.store ?? createDynamoDraftStore();
    if (isDraft && method === 'GET') {
      return respond(event, 200, 'ok', await draftStore.get(identity.sub));
    }
    if (isDraft && method === 'PUT') {
      const input = putInput(requestBody(event));
      return respond(
        event,
        200,
        'ok',
        await draftStore.put(identity.sub, input.expectedVersion, input.draft),
      );
    }

    const attemptStore = dependencies.attemptStore ?? createDynamoAttemptStore();
    if (isAttemptCollection && method === 'POST') {
      const input = attemptInput(requestBody(event));
      const admitted = await attemptStore.admit({ owner: identity.sub, ...input });
      const dispatchConfirmed = admitted.admitted
        ? await dispatchAttempt(dependencies, admitted.attempt.id, identity.sub)
        : (await attemptStore.get(identity.sub, admitted.attempt.id))?.status === 'pending'
          ? await dispatchAttempt(dependencies, admitted.attempt.id, identity.sub)
          : false;
      return respond(event, 200, 'ok', { attempt: admitted.attempt, dispatchConfirmed });
    }
    if (isAttemptCollection && method === 'GET') {
      const cursor = event.queryStringParameters?.cursor;
      const result = await attemptStore.list(identity.sub, cursor, 20);
      return respond(event, 200, 'ok', result);
    }
    if (isAttemptRequest) {
      const requestKey = decodeURIComponent(parts[1]);
      const attempt = await attemptStore.getByRequest(identity.sub, requestKey);
      if (!attempt) throw new ApiError(404, 'not_found', 'Intento no encontrado.');
      return respond(event, 200, 'ok', summaryResponse(attempt));
    }
    if (isQuota) {
      return respond(event, 200, 'ok', await attemptStore.quota(identity.sub));
    }
    if (isAttemptAction) {
      const attemptId = decodeURIComponent(parts[1]);
      if (parts[2] === 'cancel') {
        const attempt = await attemptStore.requestCancel(identity.sub, attemptId);
        if (!attempt) throw new ApiError(404, 'not_found', 'Intento no encontrado.');
        return respond(event, 200, 'ok', summaryResponse(attempt));
      }
      const current = await attemptStore.closeExpired(identity.sub, attemptId);
      if (!current) throw new ApiError(404, 'not_found', 'Intento no encontrado.');
      if (current.status !== 'pending')
        return respond(event, 200, 'ok', {
          attempt: summaryOf(current),
          dispatchConfirmed: false,
        });
      const dispatchConfirmed = await dispatchAttempt(dependencies, attemptId, identity.sub);
      const attempt = (await attemptStore.get(identity.sub, attemptId)) ?? current;
      return respond(event, 200, 'ok', {
        attempt: summaryOf(attempt),
        dispatchConfirmed,
      });
    }
    if (isAttemptItem && method === 'GET') {
      const attemptId = decodeURIComponent(parts[1]);
      const attempt = await attemptStore.closeExpired(identity.sub, attemptId);
      if (!attempt) throw new ApiError(404, 'not_found', 'Intento no encontrado.');
      return respond(event, 200, 'ok', summaryResponse(attempt));
    }
    throw new ApiError(404, 'not_found', 'Ruta no encontrada.');
  } catch (error) {
    if (error instanceof DraftConflictError) {
      return respond(event, 409, 'conflict', currentConflict(error));
    }
    if (error instanceof ApiError) {
      return respond(event, error.statusCode, error.code, {
        code: error.code,
        message: error.message,
      });
    }
    if (error instanceof DraftIncompatibleError) {
      return respond(event, 500, 'stored_draft_incompatible', {
        code: 'stored_draft_incompatible',
        message: STORED_DRAFT_INCOMPATIBLE_MESSAGE,
      });
    }
    if (error instanceof DraftStorageError) {
      return respond(event, 503, 'dependency_unavailable', {
        code: 'dependency_unavailable',
        message: 'No se pudo acceder a la configuración.',
      });
    }
    if (error instanceof IdempotencyConflictError) {
      return respond(event, 409, 'idempotency_conflict', {
        code: 'idempotency_conflict',
        message: error.message,
      });
    }
    if (error instanceof QuotaExceededError) {
      return respond(event, 429, 'quota_exceeded', {
        code: 'quota_exceeded',
        message: error.message,
      });
    }
    if (error instanceof AdmissionConflictError) {
      return respond(event, 409, 'conflict', { code: 'conflict', message: error.message });
    }
    if (error instanceof AttemptStoreError) {
      return respond(event, 503, 'dependency_unavailable', {
        code: 'dependency_unavailable',
        message: error.message,
      });
    }
    return respond(event, 500, 'internal', {
      code: 'internal',
      message: 'Ocurrió un error inesperado.',
    });
  }
};

export const handler: APIGatewayProxyHandlerV2 = (event) => handleRequest(event);
