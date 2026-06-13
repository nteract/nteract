import { useState } from "react";
import { LogIn } from "lucide-react";
import {
  NotebookEditModeButton,
  type NotebookInteractionMode,
  type NotebookInteractionModeProjection,
  type NotebookShellCapabilities,
} from "@/components/notebook";
import {
  cloudNotebookSignInCopy,
  prepareCloudOidcViewerLogin,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";
import { beginOidcLogin } from "./oidc-auth";
import type { CloudViewerAuthConfig } from "./cloud-viewer-types";

export function cloudNotebookSignInLabel(authConfig: CloudViewerAuthConfig): string {
  const providerLabel = authConfig.oidc?.providerLabel?.trim();
  return providerLabel ? `Sign in with ${providerLabel}` : "Sign in";
}

export function CloudNotebookEditModeButton({
  authState,
  hasAppSession,
  accessLevel,
  accessPending,
  interaction,
  onModeChange,
  onRequestEditAccess,
}: {
  authState: CloudPrototypeAuthState;
  hasAppSession: boolean;
  accessLevel: NotebookShellCapabilities["access"]["level"];
  accessPending: boolean;
  interaction: NotebookInteractionModeProjection | null;
  onModeChange: (mode: NotebookInteractionMode) => void;
  onRequestEditAccess: () => void;
}) {
  const canUseEditModeControl =
    hasAppSession || authState.mode === "dev" || authState.mode === "oidc";
  if (
    !canUseEditModeControl ||
    (!interaction?.canRequestEdit && interaction?.activeMode !== "edit")
  ) {
    return null;
  }

  return (
    <NotebookEditModeButton
      mode={accessPending ? "view" : interaction.selectedMode}
      state={accessPending ? "viewing" : interaction.state}
      variant="segmented"
      disabled={accessPending}
      onModeChange={(mode) => {
        if (mode === "edit" && accessLevel !== "editor" && accessLevel !== "owner") {
          onRequestEditAccess();
          return;
        }
        onModeChange(mode);
      }}
    />
  );
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

  if (!authConfig.oidc || authState.mode === "oidc") {
    return null;
  }
  const copy = cloudNotebookSignInCopy(authState, authAction, error);
  const label =
    authAction === "idle" && !error
      ? (idleLabel ?? cloudNotebookSignInLabel(authConfig))
      : copy.label;

  const beginOidcAuth = async () => {
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
      onClick={beginOidcAuth}
    >
      <LogIn aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
