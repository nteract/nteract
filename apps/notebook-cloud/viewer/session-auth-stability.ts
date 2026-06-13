import type { CloudPrototypeAuthState } from "./collaborator-auth";

const CLOUD_COOKIE_BLOB_AUTH_STATE: CloudPrototypeAuthState = Object.freeze({
  mode: "anonymous",
  token: null,
  user: null,
  oidcClaims: null,
  requestedScope: null,
  problem: null,
});

export function cloudBrowserApiAuthStateForFetch(
  authState: CloudPrototypeAuthState,
): CloudPrototypeAuthState {
  // Cookie/app-session browser fetches do not add OIDC bearer headers, so
  // host-owned APIs and blob fetches intentionally share one stable auth
  // object across OIDC token refreshes.
  if (authState.mode !== "dev") {
    return CLOUD_COOKIE_BLOB_AUTH_STATE;
  }
  return {
    mode: "dev",
    token: authState.token,
    user: authState.user,
    oidcClaims: null,
    requestedScope: authState.requestedScope,
    problem: authState.problem,
  };
}

export function cloudBlobAuthStateForBrowserFetch(
  authState: CloudPrototypeAuthState,
): CloudPrototypeAuthState {
  return cloudBrowserApiAuthStateForFetch(authState);
}

export function cloudSyncAuthConnectionKey(
  authState: CloudPrototypeAuthState,
  options: { hasAppSession: boolean },
): string {
  // App-session sockets authenticate with HttpOnly cookies plus a per-attempt
  // operator nonce, not the localStorage OIDC object. Keep the connection key
  // stable across equivalent session refreshes.
  if (options.hasAppSession) {
    return "app-session";
  }
  return [
    authState.mode,
    authState.token ?? "",
    authState.user ?? "",
    authState.requestedScope ?? "",
  ].join(":");
}
