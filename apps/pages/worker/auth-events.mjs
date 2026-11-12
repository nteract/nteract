/** Auth events: one structured JSON line per sign-in, sign-out, OAuth grant
 * step, API key acceptance, Kilo agent token exchange and Project invitation
 * change. Telemetry is the
 * durable record of who signed in or connected an agent; the auth tables only
 * hold live state, and expired or revoked rows are deleted.
 *
 * Sink: the same Worker console channel as usage.mjs. celld exports each line
 * as an OTel log body, which lands as Parquet under
 * `<fleet-prefix>/telemetry/logs/` (DEPLOYMENT.md, Telemetry), with 30-day
 * retention. Each line is one JSON object with `event: "pages.auth.v1"` and an
 * `action` from AUTH_ACTIONS.
 *
 * Recorded: principal, OAuth client id (a client Pages recognizes in full,
 * any other metadata-document client by its host), a short grant or
 * invitation reference, scopes, enum reasons, and how many organizations a
 * Kilo exchange reported. A reference is the first 12 hex digits of SHA-256
 * over the id: it joins events of one grant without naming the stored row.
 *
 * Never recorded: tokens, authorization codes, consent ids, CSRF tokens,
 * OAuth state, cookies, session ids, sealed blobs, emails, IP addresses,
 * display names, organization ids or names, or free text. Every field passes
 * an allowlist; a principal that contains `@` is dropped.
 *
 * Emission never fails or delays a request beyond one digest. A record that
 * can't be built is dropped and counted; the next line carries the count as
 * `dropped`. */

import { MAX_ORGANIZATIONS } from "./kilo-exchange.mjs";
import { loggedClientId } from "./oauth-clients.mjs";

export const AUTH_EVENT = "pages.auth.v1";
export const AUTH_ACTIONS = Object.freeze([
  "sign_in.succeeded",
  "sign_in.failed",
  "sign_out",
  "session.expired",
  "oauth.consent_granted",
  "oauth.consent_denied",
  "oauth.code_issued",
  "oauth.token_issued",
  "oauth.token_refused",
  "oauth.grant_revoked",
  "oauth.code_replayed",
  "oauth.refresh_reused",
  "api_key.accepted",
  "kilo_token.accepted",
  "kilo_token.refused",
  "invitation.created",
  "invitation.accepted",
  "invitation.revoked",
]);
/** Who revoked a grant. `user` is a person disconnecting an agent or signing
 * out everywhere in Pages; `rfc7009` is a client's revocation request;
 * `system` is a replay or reuse defence. */
export const REVOKED_BY = Object.freeze(["user", "rfc7009", "system"]);
const CREDENTIALS = ["oidc", "oauth", "api-key", "kilo-token"];
const GRANT_TYPES = ["authorization_code", "refresh_token"];
const SCOPES = new Set(["pages:read", "pages:write", "pages:share", "offline_access"]);
const API_KEY_SCOPES = ["editor", "viewer"];
const ROLES = ["viewer", "commenter", "editor"];
const REF = /^[0-9a-f]{12}$/;
// The Project id shape from spaces.mjs (validSpaceId). auth.mjs imports this
// module, and spaces.mjs imports auth.mjs, so the pattern is repeated here
// rather than imported. Keep the two in step.
const PROJECT_ID = /^(prj|sp)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENUM = /^[a-z0-9_]{1,64}$/;

/** First 12 hex of SHA-256 over `id`, or undefined. Never throws. */
export async function authRef(id) {
  if (typeof id !== "string" || !id) return undefined;
  try {
    const bytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)),
    );
    return Array.from(bytes.slice(0, 6), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return undefined;
  }
}

const enumOf = (value) => (typeof value === "string" && ENUM.test(value) ? value : undefined);
const oneOf = (values) => (value) => (values.includes(value) ? value : undefined);
const principalOf = (value) =>
  typeof value === "string" &&
  value.length <= 512 &&
  // eslint-disable-next-line no-control-regex
  !/[\x00-\x1f\x7f@\s]/.test(value) &&
  value.includes(":")
    ? value
    : undefined;
const scopeOf = (value, action) => {
  if (typeof value !== "string") return undefined;
  if (API_KEY_SCOPES.includes(value)) return value;
  // A sign-out from every browser and agent; one from this browser has none.
  if (action === "sign_out") return value === "all" ? value : undefined;
  const parts = value.split(" ").filter(Boolean);
  return parts.length && parts.every((part) => SCOPES.has(part))
    ? [...new Set(parts)].sort().join(" ")
    : undefined;
};
const refOf = (value) => (typeof value === "string" && REF.test(value) ? value : undefined);
const boolOf = (value) => (typeof value === "boolean" ? value : undefined);
const countOf = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= MAX_ORGANIZATIONS ? value : undefined;

let dropped = 0;

/** Build one auth record from already-hashed references. Unknown keys are
 * dropped; absent values omitted. */
export function authEvent({
  action,
  principal,
  credential,
  clientId,
  grant,
  grantType,
  scope,
  refresh,
  revokedBy,
  reason,
  phase,
  kind,
  outcome,
  projectId,
  invite,
  role,
  organizations,
  now = new Date(),
}) {
  if (!AUTH_ACTIONS.includes(action)) throw new TypeError(`Unknown auth action ${action}`);
  const record = {
    service: "nteract-pages-native",
    event: AUTH_EVENT,
    action,
    principal: principalOf(principal),
    credential: oneOf(CREDENTIALS)(credential),
    client_id: loggedClientId(clientId),
    grant: refOf(grant),
    grant_type: oneOf(GRANT_TYPES)(grantType),
    scope: scopeOf(scope, action),
    refresh: boolOf(refresh),
    revoked_by: oneOf(REVOKED_BY)(revokedBy),
    reason: enumOf(reason),
    phase: enumOf(phase),
    kind: enumOf(kind),
    outcome: enumOf(outcome),
    project_id: typeof projectId === "string" && PROJECT_ID.test(projectId) ? projectId : undefined,
    invite: refOf(invite),
    role: oneOf(ROLES)(role),
    // How many organizations an exchange reported, never which.
    organizations: countOf(organizations),
    timestamp: now.toISOString(),
  };
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
  return record;
}

/** Emit one auth line. `grantId` and `inviteId` are hashed into references
 * here and never logged themselves. Never rejects. */
export async function logAuthEvent({ grantId, inviteId, ...fields }) {
  try {
    const record = authEvent({
      ...fields,
      ...(grantId !== undefined && { grant: await authRef(grantId) }),
      ...(inviteId !== undefined && { invite: await authRef(inviteId) }),
    });
    if (dropped) record.dropped = dropped;
    console.info(JSON.stringify(record));
    dropped = 0;
    return record;
  } catch {
    dropped++;
    return undefined;
  }
}

/** The `onAuthEvent` callback for apps/notebook-cloud server-oidc.ts. It maps
 * the shared sign-in events onto Pages auth actions. Never throws. */
export function recordOidcEvent(event) {
  try {
    if (event?.type === "sign_in")
      void logAuthEvent({
        action: "sign_in.succeeded",
        principal: event.principal,
        credential: "oidc",
      });
    else if (event?.type === "sign_in_failed")
      void logAuthEvent({
        action: "sign_in.failed",
        credential: "oidc",
        reason: event.reason,
        phase: event.phase,
        kind: event.kind,
        outcome: event.outcome,
      });
    else if (event?.type === "session_expired")
      void logAuthEvent({
        action: "session.expired",
        principal: event.principal,
        credential: "oidc",
        reason: event.reason,
      });
  } catch {
    dropped++;
  }
}

/** The principal in a stored browser session row, or undefined. */
export function sessionRowPrincipal(row) {
  try {
    const principal = JSON.parse(row?.session_json ?? "null")?.principal;
    return typeof principal === "string" ? principal : undefined;
  } catch {
    return undefined;
  }
}

// One line per API key per isolate cache window, matching the provider
// lookup's 60 s cache in @cloud/identity.ts. Keys stay in this isolate's
// memory only, as they already do in that cache.
const API_KEY_WINDOW_MS = 60_000;
const API_KEY_ENTRIES = 256;
const apiKeysSeen = new Map();

/** Whether this isolate should record an acceptance for `token` now. */
export function firstApiKeyUse(token, now = Date.now()) {
  const until = apiKeysSeen.get(token);
  if (until !== undefined && until > now) return false;
  apiKeysSeen.delete(token);
  apiKeysSeen.set(token, now + API_KEY_WINDOW_MS);
  while (apiKeysSeen.size > API_KEY_ENTRIES) apiKeysSeen.delete(apiKeysSeen.keys().next().value);
  return true;
}

/** Test hook: forget every API key acceptance. */
export function resetApiKeyUses() {
  apiKeysSeen.clear();
}
