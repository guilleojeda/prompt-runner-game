/**
 * An access token paired with the opaque validation generation that authorized
 * it. The token is intentionally kept out of API failures and callbacks.
 */
export type ApiAccessSnapshot = {
  readonly accessToken: string;
  readonly authContext: number;
};

export type ApiTokenProvider = () =>
  string | ApiAccessSnapshot | Promise<string | ApiAccessSnapshot>;

export type ApiAuthRequired = (authContext?: number) => boolean | void;

export type ResolvedApiToken = {
  readonly token: string;
  readonly authContext?: number;
};

export function resolveApiToken(value: string | ApiAccessSnapshot): ResolvedApiToken {
  if (typeof value === 'string') {
    return { token: value };
  }
  return { token: value.accessToken, authContext: value.authContext };
}

export const API_ACCESS_REJECTED_MESSAGE =
  'El acceso fue rechazado para esta operación. Podés reintentar.';
