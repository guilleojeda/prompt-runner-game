const SHA256_HEX = /^[0-9a-f]{64}$/u;

export function validateMonitoringAuthVerifier(value: string | undefined): string {
  if (!value || !SHA256_HEX.test(value)) {
    throw new Error(
      'MONITORING_BASIC_AUTH_SHA256 must be set to a lowercase SHA-256 hex digest before synthesis.',
    );
  }
  return value;
}

export function requireMonitoringAuthVerifier(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return validateMonitoringAuthVerifier(environment.MONITORING_BASIC_AUTH_SHA256);
}

export function validateMonitoringApiKeyVerifier(value: string | undefined): string {
  if (!value || !SHA256_HEX.test(value)) {
    throw new Error(
      'MONITORING_API_KEY_SHA256 must be set to a lowercase SHA-256 hex digest before synthesis.',
    );
  }
  return value;
}

export function requireMonitoringApiKeyVerifier(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return validateMonitoringApiKeyVerifier(environment.MONITORING_API_KEY_SHA256);
}

export function cloudFrontMonitoringAuthCode(authVerifier: string, apiKeyVerifier: string): string {
  const validAuthVerifier = validateMonitoringAuthVerifier(authVerifier);
  const validApiKeyVerifier = validateMonitoringApiKeyVerifier(apiKeyVerifier);
  return `var crypto = require("crypto");

function unauthorized() {
  return {
    statusCode: 401,
    statusDescription: "Unauthorized",
    headers: {
      "www-authenticate": { value: 'Basic realm="Robot Runner Monitor"' },
      "cache-control": { value: "no-store" }
    }
  };
}

function unauthorizedApiKey() {
  return {
    statusCode: 401,
    statusDescription: "Unauthorized",
    headers: {
      "content-type": { value: "application/json; charset=utf-8" },
      "cache-control": { value: "no-store" }
    },
    body: JSON.stringify({ error: "Unauthorized" })
  };
}

function digestMatches(value, expected) {
  var digest = crypto.createHash("sha256").update(value, "utf8").digest("hex");
  var mismatch = 0;
  for (var index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ digest.charCodeAt(index);
  }
  return digest.length === expected.length && mismatch === 0;
}

function hasValidApiKey(header) {
  if (!header || typeof header.value !== "string") {
    return false;
  }
  if (header.multiValue !== undefined &&
      (!Array.isArray(header.multiValue) || header.multiValue.length > 0)) {
    return false;
  }
  if (!/^[0-9a-f]{64}$/.test(header.value)) {
    return false;
  }
  return digestMatches(header.value, ${JSON.stringify(validApiKeyVerifier)});
}

function hasValidBasicAuthorization(authorization) {
  if (!authorization || typeof authorization.value !== "string") {
    return false;
  }

  var value = authorization.value;
  if (value.slice(0, 6).toLowerCase() !== "basic ") {
    return false;
  }

  var encodedCredentials = value.slice(6);
  if (encodedCredentials.length === 0 ||
      encodedCredentials.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedCredentials)) {
    return false;
  }

  var credentials;
  try {
    credentials = Buffer.from(encodedCredentials, "base64").toString("utf8");
    if (Buffer.from(credentials, "utf8").toString("base64") !== encodedCredentials) {
      return false;
    }
  } catch (error) {
    return false;
  }
  if (credentials.slice(0, 8) !== "monitor:") {
    return false;
  }

  return digestMatches(credentials, ${JSON.stringify(validAuthVerifier)});
}

function handler(event) {
  var request = event.request;
  var headers = request.headers;
  var hasApiKey = Object.prototype.hasOwnProperty.call(headers, "x-api-key");
  if (request.method === "GET" && request.uri === "/api/metrics" && hasApiKey) {
    if (!hasValidApiKey(headers["x-api-key"])) {
      return unauthorizedApiKey();
    }
    delete headers.authorization;
    delete headers["x-api-key"];
    return request;
  }

  if (!hasValidBasicAuthorization(headers.authorization)) {
    return unauthorized();
  }

  delete headers.authorization;
  delete headers["x-api-key"];
  return request;
}
`;
}
