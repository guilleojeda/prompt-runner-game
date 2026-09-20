import type { AuthConfig } from './auth.js';

export type ConfirmationFailureCode =
  | 'configuration'
  | 'invalid-code'
  | 'expired-code'
  | 'rate-limit'
  | 'operation-limit'
  | 'network'
  | 'account';

export class ConfirmationFailure extends Error {
  public constructor(
    public readonly code: ConfirmationFailureCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ConfirmationFailure';
  }
}

export interface PendingConfirmationClient {
  confirm(email: string, code: string): Promise<void>;
  resend(email: string): Promise<void>;
}

export interface PendingConfirmationClientOptions {
  fetch?: typeof globalThis.fetch;
}

type CognitoOperation = 'ConfirmSignUp' | 'ResendConfirmationCode';

function bindFetch(fetchImpl: typeof globalThis.fetch): typeof globalThis.fetch {
  return fetchImpl.bind(globalThis);
}

function issuerEndpoint(config: AuthConfig): string {
  let issuer: URL;
  try {
    issuer = new URL(config.issuer);
  } catch (error) {
    throw new ConfirmationFailure('configuration', 'La configuración de acceso no es válida.', {
      cause: error,
    });
  }

  const region = /^cognito-idp\.([a-z0-9-]+)\.amazonaws\.com$/iu.exec(issuer.hostname)?.[1];
  if (issuer.protocol !== 'https:' || !region || issuer.search || issuer.hash) {
    throw new ConfirmationFailure('configuration', 'No se pudo identificar la región de Cognito.');
  }
  return `https://cognito-idp.${region}.amazonaws.com/`;
}

function cleanEmail(email: string): string {
  const value = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
    throw new ConfirmationFailure('account', 'Escribí un email válido.');
  }
  return value;
}

function cleanCode(code: string): string {
  const value = code.trim();
  if (!value) {
    throw new ConfirmationFailure('invalid-code', 'Escribí el código de confirmación.');
  }
  return value;
}

function errorCode(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    return '';
  }
  const value = payload as { __type?: unknown; code?: unknown };
  const raw = typeof value.__type === 'string' ? value.__type : value.code;
  return typeof raw === 'string' ? (raw.split('#').pop() ?? '') : '';
}

function failureFor(
  code: string,
  operation: CognitoOperation,
  cause?: unknown,
): ConfirmationFailure {
  if (code === 'CodeMismatchException') {
    return new ConfirmationFailure(
      'invalid-code',
      'El código no es válido. Revisalo e intentá de nuevo.',
      {
        cause,
      },
    );
  }
  if (code === 'InvalidParameterException') {
    return operation === 'ResendConfirmationCode'
      ? new ConfirmationFailure('account', 'Escribí un email válido.', { cause })
      : new ConfirmationFailure(
          'invalid-code',
          'El código no es válido. Revisalo e intentá de nuevo.',
          { cause },
        );
  }
  if (code === 'ExpiredCodeException') {
    return new ConfirmationFailure(
      'expired-code',
      'El código venció. Pedí uno nuevo e intentá otra vez.',
      {
        cause,
      },
    );
  }
  if (code === 'LimitExceededException' || code === 'TooManyRequestsException') {
    if (operation === 'ConfirmSignUp') {
      return new ConfirmationFailure(
        'operation-limit',
        'La confirmación alcanzó un límite de Cognito. El email no se confirmó; intentá de nuevo más tarde.',
        { cause },
      );
    }
    return new ConfirmationFailure(
      'rate-limit',
      'Se alcanzó un límite de reenvío de Cognito. Reintentá cuando el límite se restablezca.',
      { cause },
    );
  }
  if (code === 'UserNotFoundException' || code === 'NotAuthorizedException') {
    return new ConfirmationFailure(
      'account',
      'No encontramos una cuenta pendiente con ese email.',
      {
        cause,
      },
    );
  }
  return new ConfirmationFailure(
    'network',
    'No se pudo completar la confirmación. Intentá de nuevo.',
    {
      cause,
    },
  );
}

export class CognitoPendingConfirmationClient implements PendingConfirmationClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly config: AuthConfig;

  public constructor(config: AuthConfig, options: PendingConfirmationClientOptions = {}) {
    this.config = config;
    this.endpoint = issuerEndpoint(config);
    this.fetchImpl = bindFetch(options.fetch ?? globalThis.fetch);
  }

  public async confirm(email: string, code: string): Promise<void> {
    await this.request('ConfirmSignUp', {
      ClientId: this.config.clientId,
      Username: cleanEmail(email),
      ConfirmationCode: cleanCode(code),
    });
  }

  public async resend(email: string): Promise<void> {
    await this.request('ResendConfirmationCode', {
      ClientId: this.config.clientId,
      Username: cleanEmail(email),
    });
  }

  private async request(
    operation: CognitoOperation,
    payload: Record<string, string>,
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new ConfirmationFailure(
        'network',
        'No se pudo comunicar con Cognito. Revisá tu conexión e intentá de nuevo.',
        { cause: error },
      );
    }

    let body: unknown = null;
    try {
      const text = await response.text();
      if (text) {
        body = JSON.parse(text) as unknown;
      }
    } catch (error) {
      if (response.ok) {
        throw new ConfirmationFailure('network', 'Cognito devolvió una respuesta inválida.', {
          cause: error,
        });
      }
    }

    if (!response.ok) {
      throw failureFor(errorCode(body), operation, body);
    }
  }
}
