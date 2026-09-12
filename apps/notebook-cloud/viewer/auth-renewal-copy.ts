/**
 * A network/timeout failure means no server ever answered: the refresh token
 * itself is not implicated, and the same background refresh will likely
 * succeed on its next tick (every 60s, or sooner on focus/visibility). Never
 * tell the user to sign in again for this case - that is only true when a
 * server or local storage actually confirmed the session is gone.
 */
export function isCloudOidcNetworkError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === "OidcNetworkError" || name === "OidcTimeoutError";
}

export function cloudOidcRenewalFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (isCloudOidcNetworkError(error)) {
    return "Couldn't reach the sign-in service. Retrying automatically.";
  }
  if (isStaleOidcSessionError(detail)) {
    return "Sign in again to continue. Your browser session could not be refreshed.";
  }
  return `Unable to refresh sign-in: ${detail}`;
}

function isStaleOidcSessionError(message: string): boolean {
  return (
    /^OIDC token refresh failed:\s*\d+\b/.test(message) ||
    /^Stored OIDC session (?:is|cannot|could not|was|has|missing)/.test(message)
  );
}
