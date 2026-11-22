/**
 * Durable Object WebSocket hibernation attachment codec and unified alarm
 * scheduler for a Page host.
 *
 * Cloudflare Durable Objects cap `ws.serializeAttachment` at 2,048 bytes and
 * persist attachments in DO storage, so attachments carry ONLY non-secret
 * policy and bookkeeping state (never raw session cookies, bearer tokens, or
 * email proofs) and stay strictly under `ATTACHMENT_MAX_BYTES`. Only browser
 * OIDC sessions with derived lookup IDs hibernate; non-OIDC sockets and
 * oversized attachments stay on the resident fallback path.
 */

export const ATTACHMENT_VERSION = 1;
export const ATTACHMENT_MAX_BYTES = 1_900;
export const OIDC_REAUTH_MS = 60_000;

const encoder = new TextEncoder();

/** Strip proof/cookie/provenance fields from an admitted identity, keeping only
 * the fields `DocumentPolicy`, `principalOf`, and usage logging need after
 * hibernation wake (including `namespace` on domain and organization leases). */
export function compactIdentity(identity) {
  if (!identity || typeof identity !== "object") return null;
  const domainAccess =
    identity.domainAccess && typeof identity.domainAccess === "object"
      ? {
          domain: identity.domainAccess.domain,
          ...(identity.domainAccess.namespace && { namespace: identity.domainAccess.namespace }),
          expiresAt: identity.domainAccess.expiresAt,
        }
      : undefined;
  const organizations = Array.isArray(identity.organizations)
    ? identity.organizations.map((org) => ({
        id: org.id,
        ...(org.role && { role: org.role }),
        ...(org.namespace && { namespace: org.namespace }),
        expiresAt: org.expiresAt,
      }))
    : undefined;
  return {
    principal: identity.principal,
    displayName: identity.displayName,
    namespace: identity.namespace,
    credentialKind: identity.credentialKind,
    driver: identity.driver,
    ...(identity.agent && { agent: identity.agent }),
    ...(identity.session && { session: identity.session }),
    canWrite: identity.canWrite === true,
    expiresAt: identity.expiresAt,
    ...(domainAccess && { domainAccess }),
    ...(organizations?.length && { organizations }),
  };
}

/** Build a size-checked JSON-safe attachment object for `ws.serializeAttachment`,
 * or `null` if `sessionCheck` is absent or the payload exceeds `ATTACHMENT_MAX_BYTES`. */
export function encodeSocketAttachment({
  senderId,
  started,
  expiresAt,
  reauthAt,
  projectBound,
  joined,
  features,
  formats,
  access,
  identity,
  sessionCheck,
  usageState,
  pageId,
}) {
  const compact = compactIdentity(identity);
  if (!compact || !senderId || !access || !sessionCheck) return null;
  const attachment = {
    v: ATTACHMENT_VERSION,
    senderId,
    started,
    ...(Number.isFinite(expiresAt) && { expiresAt }),
    ...(Number.isFinite(reauthAt) && { reauthAt }),
    ...(projectBound && { projectBound: true }),
    joined: [...new Set(joined ?? [])],
    features: [...(features ?? [])],
    ...(Array.isArray(formats) && { formats }),
    access,
    identity: compact,
    sessionCheck,
    ...(usageState && { usageState }),
    ...(pageId && { pageId }),
  };
  const bytes = encoder.encode(JSON.stringify(attachment)).byteLength;
  if (bytes > ATTACHMENT_MAX_BYTES) return null;
  return attachment;
}

/** Validate a value returned by `ws.deserializeAttachment()`. Returns `null` if
 * missing, from an unknown version, or structurally invalid. */
export function parseSocketAttachment(raw) {
  if (!raw || typeof raw !== "object" || raw.v !== ATTACHMENT_VERSION) return null;
  if (typeof raw.senderId !== "string" || !raw.senderId) return null;
  if (!raw.identity || typeof raw.identity.principal !== "string" || !raw.identity.principal)
    return null;
  if (!raw.access || typeof raw.access.role !== "string") return null;
  if (!Array.isArray(raw.joined) || !Array.isArray(raw.features)) return null;
  const sessionCheck =
    raw.sessionCheck &&
    Array.isArray(raw.sessionCheck.ids) &&
    raw.sessionCheck.ids.length >= 1 &&
    raw.sessionCheck.ids.length <= 2 &&
    raw.sessionCheck.ids.every((id) => typeof id === "string" && id.length > 0) &&
    typeof raw.sessionCheck.origin === "string" &&
    raw.sessionCheck.origin.length > 0
      ? { ids: [...raw.sessionCheck.ids], origin: raw.sessionCheck.origin }
      : null;
  if (!sessionCheck) return null;
  return {
    v: ATTACHMENT_VERSION,
    senderId: raw.senderId,
    started: Number.isSafeInteger(raw.started) ? raw.started : Date.now(),
    expiresAt: Number.isFinite(raw.expiresAt) ? raw.expiresAt : undefined,
    reauthAt: Number.isFinite(raw.reauthAt) ? raw.reauthAt : undefined,
    projectBound: raw.projectBound === true,
    joined: raw.joined.filter((id) => typeof id === "string"),
    features: raw.features.filter((f) => typeof f === "string"),
    formats: Array.isArray(raw.formats) ? raw.formats : undefined,
    access: raw.access,
    identity: Object.freeze({
      ...raw.identity,
      ...(raw.identity.domainAccess &&
        typeof raw.identity.domainAccess === "object" && {
          domainAccess: Object.freeze({ ...raw.identity.domainAccess }),
        }),
      ...(Array.isArray(raw.identity.organizations) && {
        organizations: Object.freeze(
          raw.identity.organizations.map((org) => Object.freeze({ ...org })),
        ),
      }),
    }),
    sessionCheck,
    usageState:
      raw.usageState && typeof raw.usageState.name === "string"
        ? raw.usageState
        : { name: "closed" },
    pageId: typeof raw.pageId === "string" ? raw.pageId : null,
  };
}

/**
 * Pure earliest-wake calculation for a Page Durable Object's single alarm slot.
 * Considers:
 * - Browser dwell (`usageState.nextAt` for `page.read` / `page.visit`)
 * - Periodic OIDC session re-checks (`reauthAt`)
 * - Fail-closed lease/credential deadlines (`expiresAt`)
 * - Armed Project safety-net lease renewals (`projectLeaseState.at`)
 * - Pending coalesced content-activity flushes (`contentActivityState.dueAt`)
 * Returns `null` when nothing needs a future wake (the host deletes its alarm).
 */
export function nextAlarmAt({
  sockets = [],
  projectLeaseState = null,
  contentActivityState = null,
  now,
}) {
  let earliest = Infinity;
  const consider = (at) => {
    if (Number.isFinite(at) && at < earliest) earliest = at;
  };
  for (const socket of sockets) {
    if (socket.closed) continue;
    if (
      socket.driver === "Browser" &&
      socket.usageState?.name === "open" &&
      Number.isFinite(socket.usageState.nextAt)
    )
      consider(socket.usageState.nextAt);
    consider(socket.reauthAt);
    consider(socket.expiresAt);
  }
  if (projectLeaseState?.name === "armed") consider(projectLeaseState.at);
  if (contentActivityState?.name === "waiting") consider(contentActivityState.dueAt);
  else if (contentActivityState?.name === "flushQueued") consider(now);
  if (!Number.isFinite(earliest)) return null;
  return Math.max(now, earliest);
}
