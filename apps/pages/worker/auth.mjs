import { readServerAppSession } from "@cloud/oidc-session-store.ts";
import { pagesPublicOrigin } from "../agent-guide.mjs";
import { readAccessToken } from "./oauth-store.mjs";
import { oauthDriverName } from "./oauth-clients.mjs";
import { domainAccessForIdentity } from "./domain-access.mjs";
import { withAdmissionReason } from "./admission-reasons.mjs";
import { verifyApiKey } from "./api-key-verifier.mjs";
import { identityProvider } from "../identity-provider.mjs";
import { firstApiKeyUse, logAuthEvent } from "./auth-events.mjs";
import { clientProvenance } from "./client-provenance.mjs";
import { REVISION_PATTERN } from "./revisions.mjs";
import { kiloIdentity } from "./kilo-config.mjs";
import { kiloToken, kiloTokenAccount } from "./kilo-token.mjs";
import { organizationLeases, recordKiloMembership } from "./kilo-membership.mjs";

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

/** "Browser" means a person in the Pages web app, signed in with a cookie;
 * viewers show such a session by name alone (viewer/activity.mjs). A request
 * that carries a bearer credential (API key, Pages OAuth token or Kilo agent
 * token) is a client acting for the account, so a "Browser" label from it reads as "API".
 * Other labels pass through. */
export function bearerDriver(driver) {
  return driver.toLowerCase() === "browser" ? "API" : driver;
}

/** An agent's optional session label, such as "release agent", so two
 * sessions of one account and harness show and key as separate agents. It is
 * trusted like the driver: it always sits under the authenticated account.
 * A blank label means no label. Clients fill the header from config
 * templates such as `{env:PAGES_AGENT}`, which send "" when the variable is
 * unset. */
const MAX_AGENT_LABEL = 80;
export function agentLabel(request) {
  const value =
    request.headers.get("x-pages-agent") ?? new URL(request.url).searchParams.get("agent");
  if (value === null || !value.trim()) return undefined;
  // eslint-disable-next-line no-control-regex
  if (value.length > MAX_AGENT_LABEL || /[\x00-\x1f\x7f]/.test(value))
    throw new HttpError(
      400,
      `The X-Pages-Agent label is at most ${MAX_AGENT_LABEL} characters, with no control characters; this one has ${value.length}`,
      "invalid_agent_label",
    );
  return value.trim();
}

/** A presence tag for the MCP session a request belongs to. Pages issues the
 * `Mcp-Session-Id` on initialize and clients echo it, so two sessions on one
 * credential show as two agents. The tag is a digest scoped to the account,
 * so the raw session id never reaches other participants. */
export async function sessionTag(request, principal) {
  // Only the MCP endpoint, and the worker's own forwards from it to internal
  // routes, carry a session. Elsewhere the header is ignored, never rejected.
  const path = new URL(request.url).pathname;
  if (path !== "/mcp" && !path.startsWith("/internal/")) return undefined;
  const value = request.headers.get("mcp-session-id");
  if (value === null) return undefined;
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(value)) throw new HttpError(400, "Invalid MCP session id");
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${principal}\u0000${value}`)),
  );
  return Array.from(bytes.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const mcpSession = async (request, principal) => {
  const session = await sessionTag(request, principal);
  return session ? { session } : {};
};

/** Where a person connects an agent: absolute from the configured public
 * origin, or the bare path when none is configured. Never the request URL. */
function connectLink(env) {
  try {
    return `${pagesPublicOrigin(env)}/connect`;
  } catch {
    return "/connect";
  }
}

/** The refusal for a request that presents no credential at all. For a
 * provider with API keys it names the header API clients send and where a
 * person gets a key. For one without, it sends the client to OAuth. */
export const credentialRequired = (env) => {
  const key = identityProvider(env).apiKey;
  return withAdmissionReason(
    new HttpError(
      401,
      key
        ? `Send Authorization: Bearer <${key.name}>; see ${connectLink(env)}`
        : `This deployment has no API keys. Connect your MCP client by OAuth; see ${connectLink(env)}`,
      "auth_required",
    ),
    "credential_missing",
  );
};

/** The refusal for a bearer that is not a Pages OAuth access token, on a
 * deployment whose provider has no API keys. */
const apiKeysUnsupported = (env) =>
  withAdmissionReason(
    new HttpError(
      401,
      `This deployment does not accept API keys. Connect your MCP client by OAuth; see ${connectLink(env)}`,
      "api_keys_unsupported",
    ),
    "credential_invalid",
  );

export function requireSameOrigin(request, env) {
  const origin = new URL(env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN || request.url).origin;
  const supplied = request.headers.get("origin");
  if ((supplied && supplied !== origin) || request.headers.get("sec-fetch-site") === "cross-site")
    throw withAdmissionReason(new HttpError(403, "Use this Pages origin"), "origin_rejected");
  const changesState =
    !["GET", "HEAD", "OPTIONS"].includes(request.method) ||
    request.headers.get("upgrade")?.toLowerCase() === "websocket";
  const credentialless = !request.headers.has("authorization") && !request.headers.has("cookie");
  // A new MCP client needs a 401 challenge to discover OAuth before it has a
  // credential. This exception never authorizes an operation or a foreign Origin.
  const discoveringMcp = new URL(request.url).pathname === "/mcp" && credentialless;
  if (
    changesState &&
    !discoveringMcp &&
    !request.headers.has("authorization") &&
    supplied !== origin
  ) {
    // The Origin check guards the ambient cookie. With no credential at all
    // there is nothing to forge, and the request can only fail sign-in.
    if (credentialless) throw credentialRequired(env);
    throw withAdmissionReason(new HttpError(403, "Origin is required"), "origin_rejected");
  }
}

/** The routes a Pages OAuth token or a Kilo agent token may reach: the MCP
 * endpoint, `GET /whoami`, `extra`, and the internal hops the tool routes
 * forward to, which the gateway never exposes. */
const AGENT_ROUTES = Object.freeze([
  "/mcp",
  "/internal/catalog",
  "/internal/tool",
  "/internal/create",
  // A Project member's create_page, forwarded to the owner's Catalog, which
  // refuses the owner and checks the member's role.
  "/internal/project-create",
  "/internal/trash",
  "/internal/restore",
  "/internal/purge",
  "/internal/assets/authorize",
  // delete_project: the content document's impact, then the Space's removal.
  // Both hosts check the caller owns the Project themselves.
  "/internal/content-impact",
  "/internal/space/create",
  "/internal/space/read",
  "/internal/space/update",
  "/internal/space/delete",
  "/internal/space/access",
  "/internal/access",
]);
function onAgentRoute(request, extra = []) {
  const { pathname } = new URL(request.url);
  return (
    (pathname === "/whoami" && request.method === "GET") ||
    AGENT_ROUTES.includes(pathname) ||
    extra.includes(pathname)
  );
}

/** Kilo token answers whose membership evidence is in D1. The token lease
 * hands every request the same answer object until it ends, so once one
 * request's write of an answer succeeds, later requests on it write nothing.
 *
 * Only that settled fact is shared, never a pending write: a gateway request
 * that awaited another request's promise could be cut off when that request
 * responds (isolate-setup.mjs says why). So, as with the token lease
 * (kilo-token-lease.mjs), each request does its own waiting. A request that
 * finds its answer not yet recorded writes it itself and marks the answer
 * only after its own write succeeds. Requests that arrive together at the
 * start of a lease each write the same answer with the same send time, which
 * the fenced write leaves as it is.
 *
 * A request whose write fails gets a retryable 503 `sign_in_unavailable` and
 * marks nothing, so the next request writes again. It does not go on without
 * organization leases instead: that would answer the person's organization
 * Pages with access denials a retry would reverse. Either way no request
 * authenticates with evidence older than the answer it holds. */
const recordedAnswers = new WeakSet();
async function recordExchange(env, principal, account) {
  if (recordedAnswers.has(account)) return;
  try {
    await recordKiloMembership(env, principal, account.organizations, account.verifiedAt);
  } catch (cause) {
    throw withAdmissionReason(
      Object.assign(new Error("Kilo sign-in is unavailable. Retry the request."), {
        status: 503,
        code: "sign_in_unavailable",
        retryable: true,
        cause,
      }),
      "credential_unverified",
    );
  }
  recordedAnswers.add(account);
}

/** The identity with the audience leases its evidence supports: a company
 * domain lease and one lease per organization. Each host derives them again
 * from the credential; no identity carries them between hosts. A Page host
 * applies it to an upload capability's identity too (index.mjs `identify`). */
export async function withDomainAccess(identity, env) {
  const domainAccess = await domainAccessForIdentity(env, identity);
  const organizations = await organizationLeases(env, identity);
  return Object.freeze({
    ...identity,
    ...(domainAccess && { domainAccess }),
    ...(organizations.length && { organizations: Object.freeze(organizations) }),
  });
}

export async function authenticate(request, env) {
  requireSameOrigin(request, env);
  const driver = driverLabel(request);
  const agent = agentLabel(request);
  const provenance = clientProvenance(request, agent);
  const requestAssertions = provenance ? { clientProvenance: provenance } : {};
  const authorization = request.headers.get("authorization");
  if (authorization) {
    if (!/^Bearer \S+$/i.test(authorization)) throw new HttpError(401, "Use a bearer credential");
    const token = authorization.slice(7);
    // An upload capability (asset-uploads.mjs) sent as a bearer credential is
    // refused here, so it never reaches the API-key provider. API keys are
    // JWT-shaped and can't start with this prefix.
    if (token.startsWith("pu1."))
      throw new HttpError(
        401,
        "Send an upload capability only to its upload_url, as Authorization: Pages-Upload <token>",
        "upload_capability_invalid",
      );
    if (token.startsWith("pages_")) {
      // Internal routes are only reachable through host namespace forwarding.
      // An MCP grant cannot be used to change ACLs or open a native sync socket.
      if (!onAgentRoute(request))
        throw withAdmissionReason(
          new HttpError(403, "This credential is limited to Pages MCP"),
          "credential_scope",
        );
      const grant = await readAccessToken(env, token, {
        resource: pagesPublicOrigin(env) + "/mcp",
      });
      if (!grant) throw new HttpError(401, "Reconnect your Pages client", "oauth_invalid_token");
      const scopes = new Set(grant.scope.split(" "));
      if (
        ["/internal/space/access", "/internal/access"].includes(new URL(request.url).pathname) &&
        !scopes.has("pages:share")
      )
        throw new HttpError(
          403,
          "Pages sharing permission is required",
          "oauth_insufficient_scope",
        );
      if (!scopes.has("pages:read"))
        throw new HttpError(403, "Pages read permission is required", "oauth_insufficient_scope");
      return withDomainAccess(
        {
          principal: grant.identity.principal,
          displayName: grant.identity.displayName || grant.identity.principal,
          // Older consent snapshots filled a missing name with the principal.
          accountDisplayName:
            grant.identity.displayName === grant.identity.principal
              ? null
              : grant.identity.displayName || null,
          driver:
            request.headers.has("x-pages-driver") || new URL(request.url).searchParams.has("driver")
              ? bearerDriver(driver)
              : oauthDriverName(grant.clientId),
          ...(agent && { agent }),
          ...requestAssertions,
          ...(await mcpSession(request, grant.identity.principal)),
          canWrite: scopes.has("pages:write"),
          canShare: scopes.has("pages:share"),
          credentialKind: "oauth",
          // Host-internal, like emailProof: an upload capability names its
          // grant so revoking the connection ends it (asset-uploads.mjs).
          grantId: grant.grantId,
          namespace: grant.identity.namespace,
          emailProof: grant.identity.emailProof,
          expiresAt: grant.expiresAt * 1000,
        },
        env,
      );
    }
    // Tested after the prefixes Pages issues, which no JWT carries. A Kilo
    // deployment has no API keys, so no bearer below is shadowed.
    const kilo = kiloToken(env, request, token);
    if (kilo) {
      // The tool routes only, checked before Kilo is asked: no sync socket,
      // browser route or raw asset read.
      if (!onAgentRoute(request, ["/api/tools"]))
        throw withAdmissionReason(
          new HttpError(403, "This credential is limited to Pages agent tools"),
          "credential_scope",
        );
      const account = await kiloTokenAccount(kilo, token);
      const { principal, metadata } = kiloIdentity(kilo.config, account);
      await recordExchange(env, principal, account);
      return withDomainAccess(
        {
          principal,
          displayName: metadata.displayName || principal,
          accountDisplayName: metadata.displayName || null,
          driver: bearerDriver(driver),
          ...(agent && { agent }),
          ...requestAssertions,
          ...(await mcpSession(request, principal)),
          canWrite: true,
          credentialKind: "kilo-token",
          namespace: metadata.principalNamespace,
          // Kilo sends it only with proof the account controls it, and the
          // exchange keeps it only when an invitation could name it
          // (kilo-exchange.mjs). Like an API key's, it lasts as long as this
          // identity does.
          verifiedEmail: metadata.emailVerified === true ? metadata.email : undefined,
          expiresAt: account.until,
        },
        env,
      );
    }
    // The provider has no API keys, so the bearer is not one. Refuse it here:
    // verifyApiKey would send the token to an account service that cannot know it.
    if (!identityProvider(env).apiKey) throw apiKeysUnsupported(env);
    let identity;
    try {
      identity = await verifyApiKey(request, env, { token, authorization });
    } catch (error) {
      // A provider outage is not a credential verdict.
      const status = error?.status ?? (error?.name === "AuthError" ? 401 : 500);
      if (status >= 500 && error && typeof error === "object")
        withAdmissionReason(error, "credential_unverified");
      if (status === 401)
        throw withAdmissionReason(
          new HttpError(
            401,
            `${error.message}. Check that the key is current and from this deployment's ${identityProvider(env).label} account, or create a new one at ${connectLink(env)}`,
            "invalid_api_key",
          ),
          "credential_invalid",
        );
      throw error;
    }
    if (firstApiKeyUse(token))
      await logAuthEvent({
        action: "api_key.accepted",
        principal: identity.principal,
        credential: "api-key",
        scope: identity.scope,
      });
    return withDomainAccess(
      {
        principal: identity.principal,
        displayName: identity.metadata.displayName || identity.principal,
        accountDisplayName: identity.metadata.displayName || null,
        driver: bearerDriver(driver),
        ...(agent && { agent }),
        ...requestAssertions,
        ...(await mcpSession(request, identity.principal)),
        canWrite: identity.scope === "editor",
        credentialKind: "api-key",
        namespace: identity.metadata.principalNamespace,
        // Same trust contract as notebook invite resolution: the provider's
        // authenticated account endpoint returns server-verified account email.
        verifiedEmail:
          identity.metadata.emailVerified === true ? identity.metadata.email : undefined,
        // When the provider answer that verified it stops being current; a
        // cached answer keeps the deadline of the lookup behind it.
        verifiedEmailUntil:
          identity.metadata.emailVerified === true
            ? identity.metadata.emailVerifiedUntil
            : undefined,
        expiresAt: Date.now() + 60_000,
      },
      env,
    );
  }
  if (!request.headers.has("cookie"))
    throw withAdmissionReason(
      new HttpError(401, "Sign in to Pages", "auth_required"),
      "credential_missing",
    );
  const session = await readServerAppSession(env, request, Math.floor(Date.now() / 1000));
  // An expired, revoked or unrelated cookie: sign in again. The Origin check
  // already ran for this request.
  if (!session)
    throw withAdmissionReason(
      new HttpError(401, "Sign in to Pages", "auth_required"),
      "credential_expired",
    );
  return withDomainAccess(
    {
      principal: session.principal,
      displayName: session.displayName || session.principal,
      accountDisplayName: session.displayName || null,
      driver,
      ...requestAssertions,
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

/** Self-account data only; never use this projection for collaborative presence. */
export function accountIdentity(identity) {
  return {
    principal: identity.principal,
    display_name: identity.accountDisplayName ?? null,
    ...(identity.credentialKind === "api-key" &&
      identity.verifiedEmail && { email: identity.verifiedEmail }),
  };
}

export function requireWrite(identity) {
  if (!identity.canWrite)
    throw new HttpError(
      403,
      "This credential is read-only",
      identity.credentialKind === "oauth" ? "oauth_insufficient_scope" : undefined,
    );
}

/** Server failures whose fixed message tells the caller to retry the same
 * request. Every other 5xx keeps the generic message. */
/** Codes a refusal below 500 carries to the client as-is. The agent guide
 * lists every one of these. */
export const CLIENT_ERROR_CODES = Object.freeze([
  "auth_required",
  "invalid_api_key",
  "api_keys_unsupported",
  "invalid_kilo_token",
  "account_unavailable",
  "unknown_operation",
  "invalid_arguments",
  "invalid_page_id",
  "page_not_found",
  "oauth_invalid_token",
  "oauth_insufficient_scope",
  "nonce_conflict",
  "creation_conflict",
  "invalid_nonce",
  "invalid_revision",
  "operation_receipt_capacity",
  "pending_operation_capacity",
  "page_recovery_blocked",
  "page_trashed",
  "page_not_in_trash",
  "trash_capacity",
  "page_quota_exceeded",
  "purge_preview_required",
  "purge_preview_invalid",
  "invalid_edit_selector",
  "replace_match_too_large",
  "invalid_comment_selector",
  "stale_revision",
  "edit_conflict",
  "resync_required",
  "image_not_found",
  "dataset_not_found",
  "invalid_source",
  "source_not_found",
  "stale_source",
  "invalid_view",
  "view_not_found",
  "stale_view",
  "unknown_source",
  "unknown_source_revision",
  "view_limit",
  "unknown_view",
  "document_conflict",
  "upload_capability_invalid",
  "upload_capability_expired",
  "upload_mismatch",
  "invalid_presence_target",
  "presence_revision_changed",
  "presence_target_not_found",
  "progress_session_expired",
  "progress_capacity_exceeded",
  "progress_budget_exceeded",
  "invalid_cursor",
  "invalid_list_arguments",
  "company_email_proof_required",
  "organization_proof_required",
  "link_audience_set",
  "project_id_as_page_id",
  "page_id_as_project_id",
  "project_not_found",
  "project_pending",
  "project_capacity",
  "project_revision_conflict",
  "project_create_forbidden",
  "project_owner_quota_exceeded",
  "project_access_changed",
  "tool_renamed",
  "argument_renamed",
  "placement_mismatch",
  "parent_unavailable",
  "nesting_depth_exceeded",
  "project_content_protected",
  "page_has_children",
  "not_page_owner",
  "placement_cycle",
  "move_destination_required",
  "invalid_position",
  "position_sibling_unknown",
  "lifecycle_unsettled",
  "unsupported_schema_feature",
  "unsupported_markdown",
  "markdownless_node",
  "newer_content",
  "node_not_found",
  "wrong_address_kind",
  "nodes_would_join",
  "stored_form_unsupported",
  "document_format_unsupported",
  "comment_not_author",
  "comment_access_denied",
  "operation_pending",
  "invalid_tag",
  "tag_limit_exceeded",
  "invalid_agent_label",
]);

export const RETRYABLE_SERVER_CODES = Object.freeze([
  "request_timeout",
  // A listing met a shared Page or owner Catalog that did not answer.
  "shared_page_unavailable",
  // Page tags live only in D1, which did not answer (a tag filter or write).
  "tags_unavailable",
  // Kilo could not check an agent token (kilo-token.mjs).
  "sign_in_unavailable",
  // A view slot's release after a failed write hasn't finished
  // (view-lifecycle.mjs `releasing`).
  "view_unavailable",
]);

const LOGGED_ERROR_TYPES = [
  "Error",
  "HttpError",
  "AuthError",
  "PermissionDenied",
  "AggregateError",
  "RuntimeError",
  "TypeError",
  "RangeError",
  "BackendError",
];
const errorType = (error) => (LOGGED_ERROR_TYPES.includes(error?.name) ? error.name : "Error");

/** Where an error was thrown, as function names from its top stack frames.
 * Names are code identifiers: no message, argument, path or line is kept. */
export function failureOrigin(error) {
  const frames = [];
  // The stack starts with the message, which may span lines.
  const header = String(error?.message ?? "").split("\n").length;
  for (const line of String(error?.stack ?? "")
    .split("\n")
    .slice(header, header + 15)) {
    const match = /^\s*at (?:async |new )?([A-Za-z_$][\w$.]{0,63})(?:\s|$)/.exec(line);
    if (match && match[1] !== "async") frames.push(match[1]);
    if (frames.length === 3) break;
  }
  return frames;
}

/** Bounded, content-free description of one error: its type, origin, and the
 * storage backend's operation/code enums when it is a BackendError. */
function failureShape(error) {
  return {
    errorType: errorType(error),
    origin: failureOrigin(error),
    ...(error?.name === "BackendError" &&
      /^[a-z-]{1,32}$/.test(error.operation) &&
      /^[a-z-]{1,32}$/.test(error.code) && { backend: `${error.operation}/${error.code}` }),
  };
}

// Structured categories only: provider exceptions can contain credentials or bodies.
export function logFailure(error, stage) {
  const status = error?.status ?? (error?.name === "AuthError" ? 401 : 500);
  const { errorType: name, ...shape } = failureShape(error);
  const inner = error?.cause ?? (error?.name === "AggregateError" ? error.errors?.[0] : undefined);
  console.error("[pages-native]", {
    service: "nteract-pages-native",
    event: "request.failed",
    stage,
    status,
    errorType: name,
    ...shape,
    ...(inner && typeof inner === "object" && { cause: failureShape(inner) }),
    ...(RETRYABLE_SERVER_CODES.includes(error?.code) ? { reason: error.code } : {}),
    ...(error?.code === "native_access_changed" ? { reason: error.code } : {}),
    timestamp: new Date().toISOString(),
  });
}

export function errorResponse(error, stage = "request") {
  const status = error?.status ?? (error?.name === "AuthError" ? 401 : 500);
  if (status >= 500) logFailure(error, stage);
  // A coded server failure keeps its message and code. It is retryable unless
  // the error says otherwise (a tokenless write's timeout: reconcile first).
  const coded = status >= 500 && RETRYABLE_SERVER_CODES.includes(error?.code);
  const retryable = coded && error.retryable !== false;
  // A retryable failure may say how long to wait, in the body and as
  // Retry-After (whole seconds, never less than the body's wait).
  const retryAfterMs =
    retryable && Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs > 0
      ? error.retryAfterMs
      : undefined;
  return Response.json(
    {
      error: status < 500 || coded ? error.message : "Pages request failed",
      ...(coded && { code: error.code, retryable }),
      ...(retryAfterMs !== undefined && { retry_after_ms: retryAfterMs }),
      ...(CLIENT_ERROR_CODES.includes(error?.code) && { code: error.code }),
      ...(error?.code === "unsupported_markdown" &&
        error.details?.unsupported && {
          unsupported: {
            construct: String(error.details.unsupported.construct).slice(0, 32),
            line: Number(error.details.unsupported.line) || 1,
            column: Number(error.details.unsupported.column) || 1,
            excerpt: String(error.details.unsupported.excerpt ?? "").slice(0, 80),
          },
        }),
      ...(["page_quota_exceeded", "trash_capacity"].includes(error?.code) &&
        Number.isSafeInteger(error.details?.limit) &&
        Number.isSafeInteger(error.details?.count) && {
          limit: error.details.limit,
          count: error.details.count,
        }),
      // The Project owner's limit, never the owner's Page count.
      ...(error?.code === "project_owner_quota_exceeded" &&
        Number.isSafeInteger(error.details?.limit) && { limit: error.details.limit }),
      ...(error?.code === "unsupported_schema_feature" &&
        Array.isArray(error.details?.features) && {
          unsupported_features: error.details.features
            .slice(0, 32)
            .map((id) => String(id).slice(0, 64)),
        }),
      // A refused source write names the source and its current revision,
      // null when the source doesn't exist.
      ...(["stale_source", "source_not_found"].includes(error?.code) &&
        typeof error.details?.source_id === "string" && {
          source_id: error.details.source_id.slice(0, 64),
          source_revision:
            typeof error.details.source_revision === "string"
              ? error.details.source_revision.slice(0, 16)
              : null,
        }),
      // A refused view write names the view and its current revision, null
      // when the view doesn't exist.
      ...(["stale_view", "view_not_found"].includes(error?.code) &&
        typeof error.details?.view_id === "string" && {
          view_id: error.details.view_id.slice(0, 64),
          view_revision:
            typeof error.details.view_revision === "string"
              ? error.details.view_revision.slice(0, 16)
              : null,
        }),
      // The view cap and an unknown view name the Page's views, at most ten.
      ...(["view_limit", "unknown_view"].includes(error?.code) &&
        Array.isArray(error.details?.view_ids) && {
          view_ids: error.details.view_ids.slice(0, 10).map((id) => String(id).slice(0, 64)),
        }),
      // A thread batch is bounded to 100 IDs of at most 256 bytes each.
      ...(error?.code === "invalid_comment_selector" &&
        Array.isArray(error.details?.not_found_thread_ids) && {
          not_found_thread_ids: error.details.not_found_thread_ids
            .slice(0, 100)
            .map((id) => String(id).slice(0, 256)),
        }),
      // Revision refusals name the live revision so the caller can rebuild
      // its request without another read: the Page's revision handle, and
      // the comments document's where the host knows it. Heads never leave.
      ...(["stale_revision", "edit_conflict", "resync_required"].includes(error?.code) && {
        ...(Array.isArray(error.details?.conflicts) && {
          // The id the request named, never a block's key.
          conflicts: error.details.conflicts.slice(0, 10).map((conflict) => ({
            node_id: String(conflict.node_id ?? "").slice(0, 192),
            reason: String(conflict.reason ?? "Target changed").slice(0, 240),
          })),
        }),
        ...(REVISION_PATTERN.test(error.details?.current_revision ?? "") && {
          current_revision: error.details.current_revision,
        }),
        ...(REVISION_PATTERN.test(error.details?.comment_revision ?? "") && {
          comment_revision: error.details.comment_revision,
        }),
      }),
    },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...(retryAfterMs !== undefined && {
          "retry-after": String(Math.ceil(retryAfterMs / 1000)),
        }),
      },
    },
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
