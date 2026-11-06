import { ADMISSION_OUTCOMES } from "../shared/admission.mjs";

/** Every admission denial maps to one internal reason and one
 * client-safe code from ADMISSION_OUTCOMES. Reasons are a closed set: values
 * outside this table are never logged or returned. A reason names the boundary
 * that refused the request, not the cause of a storage delay. Only the scheduled
 * Project lease boundary is also a client-safe WebSocket close reason.
 */
export const ADMISSION_REASONS = Object.freeze({
  // HTTP gateway and Page host checks on /api/connect, /api/sync and /api/saved.
  origin_rejected: "request_rejected",
  invalid_request: "request_rejected",
  credential_scope: "request_rejected",
  credential_missing: "sign_in_required",
  credential_invalid: "sign_in_required",
  credential_expired: "sign_in_required",
  credential_unverified: "temporarily_unavailable",
  page_not_found: "page_access_denied",
  page_deleted: "page_deleted",
  page_trashed: "page_trashed",
  page_no_grant: "page_access_denied",
  page_access_removed: "page_access_denied",
  activity_epoch_changed: "temporarily_unavailable",
  project_lease_expired: "temporarily_unavailable",
  connection_capacity: "temporarily_unavailable",
  receipt_heads_missing: "temporarily_unavailable",
  // A receipt for edits SyncHost's schema gate refused: the tab's declared
  // build lacks a feature the Page is stamped with.
  schema_unsupported: "schema_unsupported",
  // Access changed under a live plain-sync connection.
  native_access_changed: "access_changed",
  // A newer plain-sync socket from the same tab (same principal, driver and
  // presence id) replaced this one.
  plain_session_replaced: "access_changed",
  // The socket transport refused a frame, before or after admission.
  native_frame_unsupported: "request_rejected",
  native_frame_too_large: "request_rejected",
  server_error: "temporarily_unavailable",
});

export const ADMISSION_CODES = ADMISSION_OUTCOMES;

export const ADMISSION_ROUTES = Object.freeze(["/api/connect", "/api/sync", "/api/saved"]);

const credentialKinds = new Set(["oidc", "api-key", "oauth"]);

/** Attach a known reason (and optionally a stricter client code) to an error. */
export function withAdmissionReason(error, reason, code) {
  if (!Object.hasOwn(ADMISSION_REASONS, reason)) throw new TypeError("Unknown admission reason");
  if (code !== undefined && !Object.hasOwn(ADMISSION_CODES, code))
    throw new TypeError("Unknown admission code");
  if (!Object.isExtensible(error)) return error;
  return Object.assign(error, { reason, ...(code && { admissionCode: code }) });
}

const statusOf = (error) => error?.status ?? (error?.name === "AuthError" ? 401 : 500);

export function admissionReason(error) {
  for (const candidate of [error?.reason, error?.code])
    if (typeof candidate === "string" && Object.hasOwn(ADMISSION_REASONS, candidate))
      return candidate;
  if (error?.code === "oauth_invalid_token") return "credential_invalid";
  if (error?.code === "page_access_denied") return "page_no_grant";
  const status = statusOf(error);
  if (status === 401) return "credential_invalid";
  if (status === 400 || status === 426) return "invalid_request";
  if (status === 403) return "page_no_grant";
  if (status === 404) return "page_not_found";
  if (status === 429) return "connection_capacity";
  return "server_error";
}

export function admissionCode(error) {
  const code = error?.admissionCode;
  return typeof code === "string" && Object.hasOwn(ADMISSION_CODES, code)
    ? code
    : ADMISSION_REASONS[admissionReason(error)];
}

export function admissionCloseCode(error) {
  return ADMISSION_CODES[admissionCode(error)].close;
}

/** Only a scheduled lease boundary is public; all other reasons stay internal. */
export function admissionCloseReason(error) {
  return admissionReason(error) === "project_lease_expired" &&
    admissionCode(error) === "temporarily_unavailable"
    ? "project_lease_expired"
    : admissionCode(error);
}

/** One structured, non-sensitive line per denial. celld exports console lines
 * as OTel log bodies without attributes, so the body is a single JSON object.
 * It never includes principals, emails, keys, tokens, Page IDs or messages. */
export function logAdmissionDenied(error, { stage, identity } = {}) {
  const reason = admissionReason(error);
  const record = {
    service: "nteract-pages-native",
    event: "admission.denied",
    stage: ["gateway", "page", "native"].includes(stage) ? stage : "unknown",
    reason,
    code: admissionCode(error),
    status: Number.isSafeInteger(statusOf(error)) ? statusOf(error) : 500,
    credential: credentialKinds.has(identity?.credentialKind) ? identity.credentialKind : "none",
    timestamp: new Date().toISOString(),
  };
  console.warn(JSON.stringify(record));
  return record;
}

/** JSON error for an admission route. Status and message follow errorResponse;
 * the added `code` is the client-safe outcome. */
export function admissionErrorResponse(error, options) {
  const status = statusOf(error);
  const { code } = logAdmissionDenied(error, options);
  return Response.json(
    { error: status < 500 ? error.message : "Pages request failed", code },
    { status, headers: { "cache-control": "no-store" } },
  );
}
