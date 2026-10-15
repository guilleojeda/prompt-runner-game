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

export function cloudFrontBasicAuthCode(verifier: string): string {
  const validVerifier = validateMonitoringAuthVerifier(verifier);
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

function handler(event) {
  var request = event.request;
  var authorization = request.headers.authorization;
  if (!authorization || typeof authorization.value !== "string") {
    return unauthorized();
  }

  var value = authorization.value;
  if (value.slice(0, 6).toLowerCase() !== "basic ") {
    return unauthorized();
  }

  var encodedCredentials = value.slice(6);
  if (encodedCredentials.length === 0 ||
      encodedCredentials.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedCredentials)) {
    return unauthorized();
  }

  var credentials;
  try {
    credentials = Buffer.from(encodedCredentials, "base64").toString("utf8");
    if (Buffer.from(credentials, "utf8").toString("base64") !== encodedCredentials) {
      return unauthorized();
    }
  } catch (error) {
    return unauthorized();
  }
  if (credentials.slice(0, 8) !== "monitor:") {
    return unauthorized();
  }

  var digest = crypto.createHash("sha256").update(credentials, "utf8").digest("hex");
  var expected = ${JSON.stringify(validVerifier)};
  var mismatch = 0;
  for (var index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ digest.charCodeAt(index);
  }
  if (digest.length !== expected.length || mismatch !== 0) {
    return unauthorized();
  }

  delete request.headers.authorization;
  return request;
}
`;
}
