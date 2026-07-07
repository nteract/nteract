import { devPrincipalLabel, type CloudPrototypeAuthState } from "./collaborator-auth";

const DEV_PRINCIPAL_PREFIX = "user:dev:";

/**
 * Anonymous principals (`anonymous:<encodedSession>`, minted by the worker
 * from the per-connection viewer_session nonce) change on every connect,
 * so persisted browser state can never match the next session.
 */
export function isAnonymousCloudPrincipal(principal: string): boolean {
  return principal.startsWith("anonymous:");
}

/**
 * Derive a principal matcher from locally stored auth material, WITHOUT
 * the room handshake. Returns null when no principal is derivable — the
 * caller must then skip cached pixels or cached shell data entirely.
 *
 * - Dev token: the worker derives the principal deterministically from
 *   the presented user, so an exact match is available.
 * - OIDC (valid stored token, or expired claims backed by a live
 *   app-session cookie): the worker's principal is
 *   `<namespace>:<encoded sub>` with a server-configured namespace, so
 *   the matcher pins the encoded subject as the principal's id segment
 *   and rejects the namespaces it cannot belong to (anonymous, dev).
 *
 * HEURISTIC, deliberately weaker than the post-handshake guard. The full
 * principal equality check after a server handshake compares against the
 * actual principal; this matcher cannot, because the OIDC namespace is
 * server configuration that is not client-derivable before the first
 * handshake. Its namespace-agnostic id-segment match is sound today only
 * because browser-written records carry exactly one of: `user:dev:*`, the
 * deployment's single OIDC/API-key namespace, or anonymous (never persisted).
 * Adding a browser-reachable auth provider whose subject space overlaps the
 * OIDC sub space widens this match — revisit then.
 */
export function cloudInstantPaintPrincipalMatcher(
  authState: CloudPrototypeAuthState,
  options: { hasAppSession?: boolean } = {},
): ((principal: string) => boolean) | null {
  if (authState.mode === "dev" && authState.token) {
    const expected = devPrincipalLabel(authState.user ?? "browser-editor");
    return (principal) => !isAnonymousCloudPrincipal(principal) && principal === expected;
  }

  const sub = authState.oidcClaims?.sub?.trim();
  const oidcUsable =
    authState.mode === "oidc" ||
    (authState.mode === "oidc_expired" && options.hasAppSession === true);
  if (oidcUsable && sub) {
    const encodedSub = encodeURIComponent(sub);
    return (principal) =>
      !isAnonymousCloudPrincipal(principal) &&
      !principal.startsWith(DEV_PRINCIPAL_PREFIX) &&
      principal.endsWith(`:${encodedSub}`);
  }

  return null;
}
