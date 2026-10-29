import { authenticateAnacondaApiKeyRequest } from "@cloud/identity.ts";
import { readServerAppSession } from "@cloud/oidc-session-store.ts";
import { pagesPublicOrigin } from "../agent-guide.mjs";
import { readAccessToken } from "./oauth-store.mjs";
import { domainAccessForIdentity } from "./domain-access.mjs";
import { withAdmissionReason } from "./admission-reasons.mjs";

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
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
    throw withAdmissionReason(new HttpError(403, "Use this Pages origin"), "origin_rejected");
  const changesState =
    !["GET", "HEAD", "OPTIONS"].includes(request.method) ||
    request.headers.get("upgrade")?.toLowerCase() === "websocket";
  // A new MCP client needs a 401 challenge to discover OAuth before it has a
  // credential. This exception never authorizes an operation or a foreign Origin.
  const discoveringMcp =
    new URL(request.url).pathname === "/mcp" &&
    !request.headers.has("authorization") &&
    !request.headers.has("cookie");
  if (
    changesState &&
    !discoveringMcp &&
    !request.headers.has("authorization") &&
    supplied !== origin
  )
    throw withAdmissionReason(new HttpError(403, "Origin is required"), "origin_rejected");
}

async function withDomainAccess(identity, env) {
  const domainAccess = await domainAccessForIdentity(env, identity);
  return Object.freeze({ ...identity, ...(domainAccess && { domainAccess }) });
}

export async function authenticate(request, env) {
  requireSameOrigin(request, env);
  const driver = driverLabel(request);
  const authorization = request.headers.get("authorization");
  if (authorization) {
    if (!/^Bearer \S+$/i.test(authorization)) throw new HttpError(401, "Use a bearer credential");
    const token = authorization.slice(7);
    if (token.startsWith("pages_")) {
      // Internal routes are only reachable through host namespace forwarding.
      // An MCP grant cannot be used to change ACLs or open a native sync socket.
      if (
        ![
          "/mcp",
          "/internal/catalog",
          "/internal/tool",
          "/internal/create",
          "/internal/delete",
          "/internal/assets/authorize",
        ].includes(new URL(request.url).pathname)
      )
        throw withAdmissionReason(
          new HttpError(403, "This credential is limited to Pages MCP"),
          "credential_scope",
        );
      const grant = await readAccessToken(env, token, {
        resource: pagesPublicOrigin(env) + "/mcp",
      });
      if (!grant) throw new HttpError(401, "Reconnect your Pages client", "oauth_invalid_token");
      const scopes = new Set(grant.scope.split(" "));
      if (!scopes.has("pages:read"))
        throw new HttpError(403, "Pages read permission is required", "oauth_insufficient_scope");
      return withDomainAccess(
        {
          principal: grant.identity.principal,
          displayName: grant.identity.displayName || grant.identity.principal,
          driver:
            request.headers.has("x-pages-driver") || new URL(request.url).searchParams.has("driver")
              ? driver
              : ["pages-chatgpt", "https://chatgpt.com/oauth/client.json"].includes(grant.clientId)
                ? "ChatGPT"
                : grant.clientId === "pages-kilo"
                  ? "Kilo"
                  : "MCP",
          canWrite: scopes.has("pages:write"),
          credentialKind: "oauth",
          namespace: grant.identity.namespace,
          emailProof: grant.identity.emailProof,
          expiresAt: grant.expiresAt * 1000,
        },
        env,
      );
    }
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
      try {
        identity = await verify("editor");
      } catch (error) {
        if (error.message !== "Anaconda API key scopes do not allow requested scope") throw error;
        identity = await verify("viewer");
      }
    } catch (error) {
      // A provider outage is not a credential verdict.
      const status = error?.status ?? (error?.name === "AuthError" ? 401 : 500);
      if (status >= 500 && error && typeof error === "object")
        withAdmissionReason(error, "credential_unverified");
      throw error;
    }
    return withDomainAccess(
      {
        principal: identity.principal,
        displayName: identity.metadata.displayName || identity.principal,
        driver,
        canWrite: identity.scope === "editor",
        credentialKind: "api-key",
        namespace: identity.metadata.principalNamespace,
        // Same trust contract as notebook invite resolution: the authenticated
        // Anaconda whoami endpoint returns server-verified account email.
        verifiedEmail:
          identity.metadata.emailVerified === true ? identity.metadata.email : undefined,
        expiresAt: Date.now() + 60_000,
      },
      env,
    );
  }
  if (!request.headers.has("cookie"))
    throw withAdmissionReason(new HttpError(401, "Sign in to Pages"), "credential_missing");
  const session = await readServerAppSession(env, request, Math.floor(Date.now() / 1000));
  if (!session) throw new HttpError(401, "Sign in to Pages");
  return withDomainAccess(
    {
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
        verifiedEmailDomainBinding: session.verifiedEmailDomainBinding,
      },
      expiresAt: session.expiresAt * 1000,
    },
    env,
  );
}

export function requireWrite(identity) {
  if (!identity.canWrite)
    throw new HttpError(
      403,
      "This credential is read-only",
      identity.credentialKind === "oauth" ? "oauth_insufficient_scope" : undefined,
    );
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
    ...([
      "native_admission_cancelled",
      "native_admission_timeout",
      "native_binding_pending",
      "native_binding_persistence_failed",
      "native_binding_mismatch",
      "native_already_connected",
      "native_access_changed",
      "native_acl_committing",
    ].includes(error.code)
      ? { reason: error.code }
      : {}),
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
        "oauth_invalid_token",
        "oauth_insufficient_scope",
        "retry_expired",
        "invalid_retry_token",
        "idempotency_conflict",
        "operation_receipt_capacity",
        "pending_operation_capacity",
        "page_recovery_blocked",
        "invalid_edit_selector",
        "edit_conflict",
        "resync_required",
        "invalid_presence_target",
        "presence_revision_changed",
        "presence_target_not_found",
        "progress_session_expired",
        "progress_capacity_exceeded",
        "progress_budget_exceeded",
        "invalid_cursor",
        "invalid_list_arguments",
      ].includes(error.code) && { code: error.code }),
      ...(["edit_conflict", "resync_required"].includes(error.code) && {
        ...(Array.isArray(error.details?.conflicts) && {
          conflicts: error.details.conflicts.slice(0, 10).map((conflict) => ({
            block_id: String(conflict.block_id ?? "").slice(0, 128),
            ...(Number.isSafeInteger(conflict.node_index) && { node_index: conflict.node_index }),
            reason: String(conflict.reason ?? "Target changed").slice(0, 240),
          })),
        }),
        ...(Array.isArray(error.details?.current_heads) && {
          current_heads: error.details.current_heads.slice(0, 128),
        }),
      }),
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
