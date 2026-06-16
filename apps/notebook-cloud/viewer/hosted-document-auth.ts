import type { CloudAppSession } from "./app-session";
import {
  cloudBrowserCanUseAuthenticatedApi,
  shouldShowCloudHeaderSignIn,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";

export interface HostedDocumentAuthProjection {
  appSessionLoading: boolean;
  canFetchCatalog: boolean;
  hasAppSession: boolean;
  hasExplicitAuth: boolean;
  showSignIn: boolean;
  signedIn: boolean;
  waitingForAppSession: boolean;
}

export function projectHostedDocumentAuthState(
  authState: CloudPrototypeAuthState,
  options: {
    appSession?: CloudAppSession | null;
    appSessionLoading?: boolean;
  } = {},
): HostedDocumentAuthProjection {
  const appSessionLoading = options.appSessionLoading === true;
  const hasAppSession = Boolean(options.appSession);
  const hasExplicitAuth = authState.mode === "dev" || authState.mode === "oidc";
  const signedIn = hasExplicitAuth || hasAppSession;
  const canFetchCatalog = cloudBrowserCanUseAuthenticatedApi({
    authState,
    hasAppSession,
  });
  const waitingForAppSession = appSessionLoading || (authState.mode === "oidc" && !hasAppSession);
  const showSignIn = shouldShowCloudHeaderSignIn(authState, {
    appSessionLoading,
    hasAppSession,
  });

  return {
    appSessionLoading,
    canFetchCatalog,
    hasAppSession,
    hasExplicitAuth,
    showSignIn,
    signedIn,
    waitingForAppSession,
  };
}
