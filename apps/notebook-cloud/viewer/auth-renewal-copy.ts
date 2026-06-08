export function cloudOidcRenewalFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
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
