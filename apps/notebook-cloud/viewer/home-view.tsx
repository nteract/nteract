import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  FileText,
  KeyRound,
  LogIn,
  LogOut,
  RotateCcw,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { clearCloudAppSession } from "./app-session";
import { cloudNotebookSignInLabel } from "./cloud-auth-controls";
import { clearCloudPrototypeDevAuth, prepareCloudOidcViewerLogin } from "./collaborator-auth";
import { beginOidcLogin } from "./oidc-auth";
import { applyDocumentTheme, CLOUD_VIEWER_THEME_STORAGE_KEY } from "./theme";
import {
  useCloudAppSessionBridge,
  useCloudAppSessionStatus,
  useCloudPrototypeAuth,
} from "./use-cloud-auth";
import type { CloudViewerAuthConfig } from "./cloud-viewer-types";

export function CloudHomeView({ authConfig }: { authConfig: CloudViewerAuthConfig }) {
  const { resolvedTheme } = useTheme(CLOUD_VIEWER_THEME_STORAGE_KEY);
  const appSessionStatus = useCloudAppSessionStatus(null);
  const { authState, authRenewal, refreshAuthState } = useCloudPrototypeAuth(authConfig, {
    appSessionRefreshFallback: true,
    appSessionLoading: appSessionStatus.status === "loading",
    appSession: appSessionStatus.session,
  });
  useCloudAppSessionBridge(
    authState,
    appSessionStatus.session,
    appSessionStatus.status === "loading",
    appSessionStatus.refreshAppSessionStatus,
  );
  const [authAction, setAuthAction] = useState<"idle" | "starting">("idle");
  const [formError, setFormError] = useState<string | null>(null);
  const localDevAuth = authConfig.localDev;
  const signInConfigured = Boolean(localDevAuth || authConfig.oidc);

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  const beginAuth = async () => {
    if (localDevAuth) {
      try {
        setAuthAction("starting");
        setFormError(null);
        window.location.assign(localDevAuth.authUrl);
      } catch (error) {
        setAuthAction("idle");
        setFormError(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (!authConfig.oidc) {
      setFormError("Sign-in is not configured for this host.");
      return;
    }
    try {
      setAuthAction("starting");
      setFormError(null);
      prepareCloudOidcViewerLogin(window.localStorage);
      const url = await beginOidcLogin(authConfig.oidc, {
        currentUrl: window.location.href,
        storage: window.localStorage,
      });
      window.location.assign(url.href);
    } catch (error) {
      setAuthAction("idle");
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  const resetAuth = () => {
    appSessionStatus.clearAppSessionStatus();
    void clearCloudAppSession()
      .catch((error: unknown) => {
        console.warn("[notebook-cloud] app session clear failed", error);
      })
      .finally(appSessionStatus.refreshAppSessionStatus);
    clearCloudPrototypeDevAuth(window.localStorage);
    setFormError(null);
    refreshAuthState();
  };

  const hasExplicitAuth = authState.mode === "oidc";
  const hasLocalDevAuth = authState.mode === "dev";
  const hasAppSession = Boolean(appSessionStatus.session);
  const signedIn = hasExplicitAuth || hasLocalDevAuth || hasAppSession;
  const homeStatusMode = signedIn ? (hasLocalDevAuth ? "dev" : "oidc") : authState.mode;
  const homeStatusTitle = hasExplicitAuth
    ? (authState.user ?? "Signed in")
    : hasLocalDevAuth
      ? (authState.user ?? "Local auth")
      : hasAppSession
        ? "Signed in"
        : "Open a notebook";
  const homeStatusDescription = signedIn
    ? hasExplicitAuth
      ? "Open a notebook or sign out of this browser session."
      : hasLocalDevAuth
        ? "Open and manage notebooks with local auth."
        : "Open and manage notebooks with this browser session."
    : "Sign in to open private notebooks or request edit access.";

  return (
    <main className="cloud-home">
      <section className="cloud-home-layout" aria-label="nteract notebook entry">
        <div className="cloud-home-copy">
          <div className="cloud-home-kicker">
            <Sparkles aria-hidden="true" />
            NTERACT
          </div>
          <h1>Bring computation to life.</h1>
          <p>Sign in to create live notebooks, share work with colleagues, and attach compute.</p>
        </div>

        <section
          className="cloud-home-panel"
          data-mode={homeStatusMode}
          aria-label="Notebook sign-in"
        >
          <div className="cloud-home-status" data-mode={homeStatusMode}>
            {signedIn ? <UserRound aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
            <div>
              <h2>{homeStatusTitle}</h2>
              <p>{homeStatusDescription}</p>
            </div>
          </div>

          {formError ? (
            <div className="cloud-auth-form-error" role="alert">
              {formError}
            </div>
          ) : null}
          {authRenewal.kind !== "idle" && !hasAppSession ? (
            <div
              className="cloud-auth-form-error"
              data-kind={authRenewal.kind === "failed" ? "error" : "info"}
              role={authRenewal.kind === "failed" ? "alert" : "status"}
            >
              {authRenewal.message}
            </div>
          ) : null}

          <div className="cloud-home-actions">
            <a href="/n">View notebooks</a>
            <a href="/m">
              View Markdown docs
              <FileText aria-hidden="true" />
            </a>
            <a href="https://nteract.io/" target="_blank" rel="noreferrer">
              Visit nteract.io
              <ArrowUpRight aria-hidden="true" />
            </a>
            {signedIn ? (
              <button
                type="button"
                onClick={() => {
                  appSessionStatus.clearAppSessionStatus();
                  void clearCloudAppSession()
                    .catch((error: unknown) => {
                      console.warn("[notebook-cloud] app session clear failed", error);
                    })
                    .finally(appSessionStatus.refreshAppSessionStatus);
                  clearCloudPrototypeDevAuth(window.localStorage);
                  refreshAuthState();
                }}
              >
                <LogOut aria-hidden="true" />
                Sign out
              </button>
            ) : null}
            {hasExplicitAuth || hasLocalDevAuth ? null : (
              <button
                type="button"
                disabled={authAction === "starting" || !signInConfigured}
                onClick={beginAuth}
              >
                <LogIn aria-hidden="true" />
                {authAction === "starting"
                  ? "Starting sign-in"
                  : !signInConfigured
                    ? "Sign-in unavailable"
                    : hasAppSession
                      ? "Renew sign-in"
                      : cloudNotebookSignInLabel(authConfig)}
              </button>
            )}
            {authState.mode === "invalid" || authState.mode === "oidc_expired" ? (
              <button type="button" onClick={resetAuth}>
                <RotateCcw aria-hidden="true" />
                Reset
              </button>
            ) : null}
          </div>

          {signInConfigured ? null : (
            <p className="cloud-home-note">
              This host has no sign-in provider configured. Public notebooks can still be read.
            </p>
          )}
        </section>
      </section>
    </main>
  );
}
