import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import {
  DraftConflictError,
  DraftStorageError,
  createDynamoDraftStore,
  type DraftStore,
} from './draft.js';
import { DraftValidationError, type RobotDraft, validateDraft } from '../../../shared/robot.js';

const APPLICATION_SCOPE = 'prompt-runner/robot';

interface Identity {
  readonly sub: string;
}

interface HandlerDependencies {
  readonly store?: DraftStore;
  readonly fetch?: typeof fetch;
  readonly clientId?: string;
  readonly userInfoUrl?: string;
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
    if (requestPath(event) !== '/draft' || (method !== 'GET' && method !== 'PUT')) {
      return jsonResponse(404, { code: 'not_found', message: 'Ruta no encontrada.' });
    }
    if (
      event.queryStringParameters?.owner !== undefined ||
      event.queryStringParameters?.sub !== undefined
    ) {
      return jsonResponse(400, {
        code: 'invalid',
        message: 'El propietario lo determina la sesión.',
      });
    }
    const config = configFrom(dependencies);
    const identity = await verifyIdentity(event, { ...config, fetch: dependencies.fetch });
    const store = dependencies.store ?? createDynamoDraftStore();
    if (method === 'GET') {
      return jsonResponse(200, await store.get(identity.sub));
    }
    const input = putInput(requestBody(event));
    return jsonResponse(200, await store.put(identity.sub, input.expectedVersion, input.draft));
  } catch (error) {
    if (error instanceof DraftConflictError) {
      return jsonResponse(409, currentConflict(error));
    }
    if (error instanceof ApiError) {
      return jsonResponse(error.statusCode, { code: error.code, message: error.message });
    }
    if (error instanceof DraftStorageError) {
      return jsonResponse(503, {
        code: 'dependency_unavailable',
        message: 'No se pudo acceder a la configuración.',
      });
    }
    return jsonResponse(500, { code: 'internal', message: 'Ocurrió un error inesperado.' });
  }
};

export const handler: APIGatewayProxyHandlerV2 = (event) => handleRequest(event);
