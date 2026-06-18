import type { CloudAppSession } from "./app-session";
import {
  cloudBrowserCanUseAuthenticatedApi,
  shouldShowCloudHeaderSignIn,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";

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
  } = {},
): HostedCatalogAuthProjection {
  const appSessionLoading = options.appSessionLoading === true;
  const hasAppSession = Boolean(options.appSession);
  const hasExplicitAuth = authState.mode === "dev" || authState.mode === "oidc";
  const canFetchCatalog = cloudBrowserCanUseAuthenticatedApi({
    authState,
    hasAppSession,
  });
  const waitingForAppSession = authState.mode === "oidc" && !hasAppSession;
  return {
    appSessionLoading,
    canFetchCatalog,
    hasAppSession,
    hasExplicitAuth,
    showSignIn: shouldShowCloudHeaderSignIn(authState, {
      appSessionLoading,
      hasAppSession,
    }),
    signedIn: hasExplicitAuth || hasAppSession,
    waitingForAppSession,
  };
}
