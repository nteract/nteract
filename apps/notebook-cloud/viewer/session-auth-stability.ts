import type { CloudPrototypeAuthState } from "./collaborator-auth";

const CLOUD_COOKIE_BLOB_AUTH_STATE: CloudPrototypeAuthState = Object.freeze({
  mode: "anonymous",
  token: null,
  user: null,
  oidcClaims: null,
  requestedScope: null,
  problem: null,
});

export function cloudBlobAuthStateForBrowserFetch(
  authState: CloudPrototypeAuthState,
): CloudPrototypeAuthState {
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

export function cloudSyncAuthConnectionKey(
  authState: CloudPrototypeAuthState,
  options: { hasAppSession: boolean },
): string {
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
