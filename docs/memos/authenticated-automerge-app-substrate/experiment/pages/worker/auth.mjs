import { authenticateAnacondaApiKeyRequest } from "@cloud/identity.ts";
import { readServerAppSession } from "@cloud/oidc-session-store.ts";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function driverLabel(request) {
  const value =
    request.headers.get("x-pages-driver") ??
    new URL(request.url).searchParams.get("driver") ??
    (request.headers.has("authorization") ? "API" : "Browser");
  // Reject control characters in labels sent to other clients.
  // eslint-disable-next-line no-control-regex
  if (!value.trim() || value.length > 80 || /[\x00-\x1f\x7f]/.test(value))
    throw new HttpError(400, "Invalid driver label");
  return value.trim();
}

export function requireSameOrigin(request, env) {
  const origin = new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN || request.url).origin;
  const supplied = request.headers.get("origin");
  if ((supplied && supplied !== origin) || request.headers.get("sec-fetch-site") === "cross-site")
    throw new HttpError(403, "Use this Pages origin");
  const changesState =
    !["GET", "HEAD", "OPTIONS"].includes(request.method) ||
    request.headers.get("upgrade")?.toLowerCase() === "websocket";
  if (changesState && !request.headers.has("authorization") && supplied !== origin)
    throw new HttpError(403, "Origin is required");
}

export async function authenticate(request, env) {
  requireSameOrigin(request, env);
  const driver = driverLabel(request);
  const authorization = request.headers.get("authorization");
  if (authorization) {
    if (!/^Bearer \S+$/i.test(authorization)) throw new HttpError(401, "Use an Anaconda API key");
    // Caller identity/scope/operator headers are never forwarded to the verifier.
    const verify = (scope) =>
      authenticateAnacondaApiKeyRequest(
        new Request(request.url, {
          headers: {
            Authorization: authorization,
            "X-Notebook-Cloud-Auth-Provider": "anaconda-api-key",
            "x-scope": scope,
            "x-operator": "pages-api",
          },
        }),
        env,
      );
    let identity;
    try {
      identity = await verify("editor");
    } catch (error) {
      if (error.message !== "Anaconda API key scopes do not allow requested scope") throw error;
      identity = await verify("viewer");
    }
    return Object.freeze({
      principal: identity.principal,
      displayName: identity.metadata.displayName || identity.principal,
      driver,
      canWrite: identity.scope === "editor",
      credentialKind: "api-key",
      namespace: identity.metadata.principalNamespace,
      // Same trust contract as notebook invite resolution: the authenticated
      // Anaconda whoami endpoint returns server-verified account email.
      verifiedEmail: identity.metadata.emailVerified === true ? identity.metadata.email : undefined,
      expiresAt: Date.now() + 60_000,
    });
  }
  const session = await readServerAppSession(env, request, Math.floor(Date.now() / 1000));
  if (!session) throw new HttpError(401, "Sign in to Pages");
  return Object.freeze({
    principal: session.principal,
    displayName: session.displayName || session.principal,
    driver,
    canWrite: true,
    credentialKind: "oidc",
    namespace: session.principalNamespace,
    // Kept inside the host; publicIdentity never forwards this proof.
    emailProof: {
      provider: "app-session",
      principalNamespace: session.principalNamespace,
      identityVerifiedAt: session.identityVerifiedAt,
      verifiedEmailBinding: session.verifiedEmailBinding,
    },
    expiresAt: session.expiresAt * 1000,
  });
}

export function requireWrite(identity) {
  if (!identity.canWrite) throw new HttpError(403, "This credential is read-only");
}

// Structured categories only: provider exceptions can contain credentials or bodies.
export function logFailure(error, stage) {
  const status = error.status ?? (error.name === "AuthError" ? 401 : 500);
  const name = [
    "Error",
    "HttpError",
    "AuthError",
    "PermissionDenied",
    "AggregateError",
    "RuntimeError",
  ].includes(error.name)
    ? error.name
    : "Error";
  console.error("[pages-native]", {
    service: "nteract-pages-native",
    event: "request.failed",
    stage,
    status,
    errorType: name,
    timestamp: new Date().toISOString(),
  });
}

export function errorResponse(error, stage = "request") {
  const status = error.status ?? (error.name === "AuthError" ? 401 : 500);
  if (status >= 500) logFailure(error, stage);
  return Response.json(
    {
      error: status < 500 ? error.message : "Pages request failed",
      ...([
        "retry_expired",
        "invalid_retry_token",
        "idempotency_conflict",
        "operation_receipt_capacity",
        "pending_operation_capacity",
        "page_recovery_blocked",
      ].includes(error.code) && { code: error.code }),
    },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export function json(value, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export async function readJson(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "JSON body required");
  let size = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1024 * 1024) {
      await reader.cancel();
      throw new HttpError(413, "Request is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}
