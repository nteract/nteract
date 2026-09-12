import { isTransientOidcHttpStatus } from "./oidc-auth";

function errorName(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

function tokenRefreshFailureStatus(message: string): number | null {
  // The only OIDC HTTP failure this function's callers ever see is a token
  // *refresh* failure: `cloudOidcRenewalFailureMessage` only runs on the
  // background renewal path (`cloud-auth-store.ts: runRefreshOidc`), which
  // calls `refreshStoredOidcToken`, never the initial-login code exchange.
  const match = /^OIDC token refresh failed:\s*(\d+)\b/.exec(message);
  return match ? Number(match[1]) : null;
}

/**
 * True when the failure says nothing about whether the stored session is
 * still good: the browser got no usable response (`OidcNetworkError`,
 * `OidcTimeoutError`) or the token endpoint answered with a transient
 * service error (429, 5xx via `OidcHttpError.status`, or the historical
 * message shape for callers/tests that predate that type). The same
 * background refresh on the next 60s tick, or the next focus/visibility
 * trigger, is likely to succeed without the user doing anything - never tell
 * the user to sign in again for this case. That is only warranted when a
 * server explicitly rejected the request or local storage confirmed the
 * session is gone.
 */
export function isTransientCloudOidcError(error: unknown): boolean {
  const name = errorName(error);
  if (name === "OidcNetworkError" || name === "OidcTimeoutError") {
    return true;
  }
  if (name === "OidcHttpError") {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" && isTransientOidcHttpStatus(status);
  }
  const detail = error instanceof Error ? error.message : String(error);
  const status = tokenRefreshFailureStatus(detail);
  return status !== null && isTransientOidcHttpStatus(status);
}

export function cloudOidcRenewalFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const name = errorName(error);
  if (name === "OidcNetworkError" || name === "OidcTimeoutError") {
    return "Couldn't reach the sign-in service. Retrying automatically.";
  }
  if (isTransientCloudOidcError(error)) {
    return "The sign-in service is temporarily unavailable. Retrying automatically.";
  }
  if (isStaleOidcSessionError(detail)) {
    return "Sign in again to continue. Your browser session could not be refreshed.";
  }
  return `Unable to refresh sign-in: ${detail}`;
}

/**
 * The token-endpoint statuses that RFC 6749 §5.2 (and providers in practice)
 * use to reject a refresh grant outright: 400 (most commonly
 * `invalid_grant`), 401, and 403. This is an allowlist, not "anything that
 * isn't 429/5xx" - a 404, 405, or 408 says the request or endpoint had a
 * problem, not that the server looked at the refresh token and refused it.
 * Those fall through to the generic diagnostic message instead of claiming
 * the session is confirmed dead.
 */
const OIDC_TOKEN_REJECTION_STATUSES = new Set([400, 401, 403]);

function isStaleOidcSessionError(message: string): boolean {
  const status = tokenRefreshFailureStatus(message);
  if (status !== null) {
    return OIDC_TOKEN_REJECTION_STATUSES.has(status);
  }
  return /^Stored OIDC session (?:is|cannot|could not|was|has|missing)/.test(message);
}
