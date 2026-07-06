import { useState } from "react";
import { LogIn } from "lucide-react";
import {
  cloudNotebookSignInCopy,
  prepareCloudOidcViewerLogin,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";
import { beginOidcLogin } from "./oidc-auth";
import type { CloudViewerAuthConfig } from "./cloud-viewer-types";

export type CloudSignInMethod = "oidc" | "localDev";

// The single source of truth for sign-in priority: OIDC whenever it is configured
// - a real IdP or the mounted dev issuer - with the loopback dev-token path as
// the fallback. Every sign-in entry point (this button, the home view, and the
// notebook-view re-auth) routes through this so a copy cannot drift; a duplicated
// localDev-first copy is exactly how OIDC became unreachable before.
export function cloudSignInMethodForConfig(
  authConfig: CloudViewerAuthConfig,
): CloudSignInMethod | null {
  if (authConfig.oidc) {
    return "oidc";
  }
  if (authConfig.localDev) {
    return "localDev";
  }
  return null;
}

// Sign-in method for a rendered sign-in control: the config priority above unless
// the session is already authenticated (dev or oidc), in which case there is
// nothing to offer.
export function resolveCloudSignInMethod(
  authConfig: CloudViewerAuthConfig,
  authState: CloudPrototypeAuthState,
): CloudSignInMethod | null {
  if (authState.mode === "dev" || authState.mode === "oidc") {
    return null;
  }
  return cloudSignInMethodForConfig(authConfig);
}

export function cloudNotebookSignInLabel(authConfig: CloudViewerAuthConfig): string {
  const providerLabel = authConfig.oidc?.providerLabel?.trim();
  if (providerLabel) {
    return `Sign in with ${providerLabel}`;
  }
  if (authConfig.oidc) {
    return "Sign in";
  }
  const localDevLabel = authConfig.localDev?.label?.trim();
  return localDevLabel || "Use local auth";
}

export function CloudNotebookSignInButton({
  authConfig,
  authState,
  idleLabel,
}: {
  authConfig: CloudViewerAuthConfig;
  authState: CloudPrototypeAuthState;
  idleLabel?: string;
}) {
  const [authAction, setAuthAction] = useState<"idle" | "starting">("idle");
  const [error, setError] = useState<string | null>(null);

  const method = resolveCloudSignInMethod(authConfig, authState);
  if (!method) {
    return null;
  }
  const copy = cloudNotebookSignInCopy(authState, authAction, error);
  const label =
    authAction === "idle" && !error
      ? (idleLabel ?? cloudNotebookSignInLabel(authConfig))
      : copy.label;

  const beginAuth = async () => {
    try {
      setAuthAction("starting");
      setError(null);
      if (method === "oidc") {
        prepareCloudOidcViewerLogin(window.localStorage);
        const url = await beginOidcLogin(authConfig.oidc!, {
          currentUrl: window.location.href,
          storage: window.localStorage,
        });
        window.location.assign(url.href);
        return;
      }
      window.location.assign(authConfig.localDev!.authUrl);
    } catch (caught) {
      setAuthAction("idle");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <button
      type="button"
      className="cloud-sign-in-button"
      data-state={error ? "error" : authAction}
      disabled={authAction === "starting"}
      title={copy.title}
      onClick={beginAuth}
    >
      <LogIn aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
