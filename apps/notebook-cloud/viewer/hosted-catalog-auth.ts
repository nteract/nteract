import type { CloudAppSession } from "./app-session";
import {
  cloudBrowserCanUseAuthenticatedApi,
  shouldShowCloudHeaderSignIn,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";
import type { CloudAuthRenewalState } from "./notice-types";

export interface HostedCatalogAuthProjection {
  appSessionLoading: boolean;
  canFetchCatalog: boolean;
  hasAppSession: boolean;
  hasExplicitAuth: boolean;
  showSignIn: boolean;
  signedIn: boolean;
  waitingForAppSession: boolean;
}

export function projectHostedCatalogAuthState(
  authState: CloudPrototypeAuthState,
  options: {
    appSession?: CloudAppSession | null;
    appSessionLoading?: boolean;
    authRenewal?: CloudAuthRenewalState;
  } = {},
): HostedCatalogAuthProjection {
  const appSessionLoading = options.appSessionLoading === true;
  const authRenewalPending = options.authRenewal?.kind === "refreshing";
  const hasAppSession = Boolean(options.appSession);
  const hasExplicitAuth = authState.mode === "dev" || authState.mode === "oidc";
  const canFetchCatalog = cloudBrowserCanUseAuthenticatedApi({
    authState,
    hasAppSession,
  });
  const waitingForAppSession =
    !hasAppSession &&
    (authState.mode === "oidc" ||
      (authState.mode === "oidc_expired" && (appSessionLoading || authRenewalPending)));
  return {
    appSessionLoading,
    canFetchCatalog,
    hasAppSession,
    hasExplicitAuth,
    showSignIn:
      !waitingForAppSession &&
      shouldShowCloudHeaderSignIn(authState, {
        appSessionLoading,
        hasAppSession,
      }),
    signedIn: hasExplicitAuth || hasAppSession,
    waitingForAppSession,
  };
}
