import { useState } from "react";
import { LogIn } from "lucide-react";
import {
  cloudNotebookSignInCopy,
  prepareCloudOidcViewerLogin,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";
import { beginOidcLogin } from "./oidc-auth";
import type { CloudViewerAuthConfig } from "./cloud-viewer-types";

export function cloudNotebookSignInLabel(authConfig: CloudViewerAuthConfig): string {
  const localDevLabel = authConfig.localDev?.label?.trim();
  if (localDevLabel) {
    return localDevLabel;
  }
  if (authConfig.localDev) {
    return "Use local auth";
  }
  const providerLabel = authConfig.oidc?.providerLabel?.trim();
  return providerLabel ? `Sign in with ${providerLabel}` : "Sign in";
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

  if (authState.mode === "dev") {
    return null;
  }
  const localDevAuth = authConfig.localDev;
  const useLocalDevAuth = Boolean(localDevAuth);
  const useOidcAuth = !useLocalDevAuth && Boolean(authConfig.oidc) && authState.mode !== "oidc";
  if (!useLocalDevAuth && !useOidcAuth) {
    return null;
  }
  const copy = cloudNotebookSignInCopy(authState, authAction, error);
  const label =
    authAction === "idle" && !error
      ? (idleLabel ?? cloudNotebookSignInLabel(authConfig))
      : copy.label;

  const beginAuth = async () => {
    if (localDevAuth) {
      try {
        setAuthAction("starting");
        setError(null);
        window.location.assign(localDevAuth.authUrl);
      } catch (caught) {
        setAuthAction("idle");
        setError(caught instanceof Error ? caught.message : String(caught));
      }
      return;
    }
    if (!authConfig.oidc) return;
    try {
      setAuthAction("starting");
      setError(null);
      prepareCloudOidcViewerLogin(window.localStorage);
      const url = await beginOidcLogin(authConfig.oidc, {
        currentUrl: window.location.href,
        storage: window.localStorage,
      });
      window.location.assign(url.href);
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
