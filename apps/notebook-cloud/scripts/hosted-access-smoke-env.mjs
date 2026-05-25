import { ACCESS_AUTH_TOKEN_PROTOCOL_PREFIX } from "../src/auth-shared.ts";

export function assertHostedAccessSmokeEnv({ ownerToken }) {
  if (ownerToken) {
    return;
  }

  throw new Error(
    "NOTEBOOK_CLOUD_ACCESS_JWT is required. Use a Cloudflare Access application JWT for the notebook-cloud app.",
  );
}

export function assertAccessHealthConfigured(payload, { baseUrl } = {}) {
  const health = accessHealthFromPayload(payload);
  if (health.status === "configured") {
    return health;
  }

  const target = baseUrl ? ` for ${baseUrl}` : "";
  const detail =
    health.status === "partial"
      ? "exactly one of NOTEBOOK_CLOUD_ACCESS_TEAM_DOMAIN or NOTEBOOK_CLOUD_ACCESS_AUD is missing"
      : "NOTEBOOK_CLOUD_ACCESS_TEAM_DOMAIN and NOTEBOOK_CLOUD_ACCESS_AUD are not set";
  throw new Error(
    `Cloudflare Access auth is ${health.status}${target}; expected configured before running the hosted Access smoke (${detail}; jwks=${health.jwks}).`,
  );
}

export function accessHealthFromPayload(payload) {
  const access = payload?.auth?.cloudflare_access;
  if (!access || typeof access !== "object") {
    throw new Error("health response is missing auth.cloudflare_access");
  }

  const { status, jwks } = access;
  if (!["configured", "partial", "disabled"].includes(status)) {
    throw new Error(`health response has invalid Cloudflare Access status: ${String(status)}`);
  }
  if (!["remote", "pinned", "none"].includes(jwks)) {
    throw new Error(`health response has invalid Cloudflare Access JWKS status: ${String(jwks)}`);
  }
  return { status, jwks };
}

export function accessPrincipalFromJwt(token) {
  const payload = decodeJwtPayload(token);
  const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!subject) {
    throw new Error("Cloudflare Access JWT is missing a non-empty sub claim");
  }
  return `user:cloudflare-access:${encodeURIComponent(subject)}`;
}

export function accessEmailFromJwt(token) {
  const payload = decodeJwtPayload(token);
  return typeof payload.email === "string" && payload.email.trim() ? payload.email.trim() : null;
}

export function accessAuthHeaders(token, { operator, scope, contentType } = {}) {
  const headers = {
    "CF-Access-Token": token,
  };
  if (operator) {
    headers["X-Operator"] = operator;
  }
  if (scope) {
    headers["X-Scope"] = scope;
  }
  if (contentType) {
    headers["Content-Type"] = contentType;
  }
  return headers;
}

export function webSocketUpgradeRequestHeaders(
  target,
  { key, origin, accessToken, protocols = [] } = {},
) {
  const requestHeaders = [
    `GET ${target.pathname}${target.search} HTTP/1.1`,
    `Host: ${target.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
  ];
  if (origin) {
    requestHeaders.push(`Origin: ${origin}`);
  }
  if (accessToken) {
    requestHeaders.push(`CF-Access-Token: ${accessToken}`);
  }
  if (protocols.length > 0) {
    requestHeaders.push(`Sec-WebSocket-Protocol: ${protocols.join(", ")}`);
  }
  return requestHeaders;
}

export function accessAuthProtocols(token) {
  return [`${ACCESS_AUTH_TOKEN_PROTOCOL_PREFIX}${base64Url(token)}`];
}

export function decodeJwtPayload(token) {
  const [, payload] = token.split(".");
  if (!payload) {
    throw new Error("Cloudflare Access token must be a JWT");
  }
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function base64Url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}
