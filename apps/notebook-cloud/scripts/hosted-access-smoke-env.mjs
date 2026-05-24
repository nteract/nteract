import { ACCESS_AUTH_TOKEN_PROTOCOL_PREFIX } from "../src/auth-shared.ts";

export function assertHostedAccessSmokeEnv({ ownerToken }) {
  if (ownerToken) {
    return;
  }

  throw new Error(
    "NOTEBOOK_CLOUD_ACCESS_JWT is required. Use a Cloudflare Access application JWT for the notebook-cloud app.",
  );
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
    Authorization: `Bearer ${token}`,
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
