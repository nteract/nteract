// OIDC callback surface for the cloud viewer.
//
// Authorization codes are single-use, so any callback exchange failure should
// recover by starting a fresh login while preserving the return URL captured
// before the successful exchange clears the stored PKCE request.

import { useEffect, useRef, useState } from "react";
import { AlertCircle, KeyRound, Loader2, UserRound } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { establishCloudAppSessionFromOidcTokenWithRetry } from "./app-session";
import { prepareCloudOidcViewerLogin } from "./collaborator-auth";
import {
  OidcTimeoutError,
  beginOidcLogin,
  completeOidcRedirect,
  peekOidcReturnUrl,
  type CloudOidcStorage,
} from "./oidc-auth";
import { applyDocumentTheme, CLOUD_VIEWER_THEME_STORAGE_KEY } from "./theme";
import type { ViewerStatus } from "./notice-types";
import type { CloudViewerAuthConfig } from "./cloud-viewer-types";

type OidcCallbackStatus =
  | Exclude<ViewerStatus, { kind: "error" }>
  | { kind: "error"; message: string; canRetry: boolean };

export interface OidcCallbackViewDeps {
  completeOidcRedirect?: typeof completeOidcRedirect;
  beginOidcLogin?: typeof beginOidcLogin;
  establishAppSession?: typeof establishCloudAppSessionFromOidcTokenWithRetry;
  /** OIDC request/token storage; tests inject an in-memory stand-in. */
  storage?: CloudOidcStorage;
  navigate?: {
    assign?: (url: string) => void;
    replace?: (url: string) => void;
  };
}

const defaultNavigateAssign = (url: string) => window.location.assign(url);
const defaultNavigateReplace = (url: string) => window.location.replace(url);

export function OidcCallbackView({
  authConfig,
  deps = {},
}: {
  authConfig: CloudViewerAuthConfig;
  deps?: OidcCallbackViewDeps;
}) {
  const { resolvedTheme } = useTheme(CLOUD_VIEWER_THEME_STORAGE_KEY);
  const completeRedirect = deps.completeOidcRedirect ?? completeOidcRedirect;
  const startOidcLogin = deps.beginOidcLogin ?? beginOidcLogin;
  const establishAppSession =
    deps.establishAppSession ?? establishCloudAppSessionFromOidcTokenWithRetry;
  const navigateAssign = deps.navigate?.assign ?? defaultNavigateAssign;
  const navigateReplace = deps.navigate?.replace ?? defaultNavigateReplace;
  const storage = deps.storage ?? window.localStorage;
  const preservedReturnUrlRef = useRef<string | null>(null);
  const capturedReturnUrlRef = useRef(false);
  const retryInFlightRef = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const [status, setStatus] = useState<OidcCallbackStatus>({
    kind: "loading",
    message: "Completing sign-in...",
  });

  if (!capturedReturnUrlRef.current) {
    preservedReturnUrlRef.current = peekOidcReturnUrl(storage);
    capturedReturnUrlRef.current = true;
  }

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    const oidc = authConfig.oidc;
    if (!oidc) {
      setStatus({
        kind: "error",
        message: "OIDC sign-in is not configured for this host.",
        canRetry: false,
      });
      return;
    }

    const params = new URLSearchParams(window.location.search);
    if (!params.has("code") || !params.has("state")) {
      setStatus({ kind: "empty", message: "No sign-in callback is pending." });
      return;
    }

    let cancelled = false;
    void completeRedirect(oidc, {
      callbackUrl: window.location.href,
      storage,
    })
      .then(async ({ returnUrl, token }) => {
        if (cancelled) return;
        await establishAppSession(token).catch((error: unknown) => {
          console.warn("[notebook-cloud] app session exchange failed", error);
        });
        if (cancelled) return;
        setStatus({ kind: "ready", message: "Signed in. Returning to the notebook..." });
        navigateReplace(returnUrl);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStatus(oidcCallbackExchangeErrorStatus(error));
      });

    return () => {
      cancelled = true;
    };
  }, [authConfig.oidc, completeRedirect, establishAppSession, navigateReplace, storage]);

  const retryOidcLogin = () => {
    const oidc = authConfig.oidc;
    if (!oidc || retryInFlightRef.current) {
      return;
    }

    retryInFlightRef.current = true;
    setRetrying(true);
    prepareCloudOidcViewerLogin(storage);
    void startOidcLogin(oidc, {
      currentUrl: preservedReturnUrlRef.current ?? "/n",
      storage,
    })
      .then((url) => {
        navigateAssign(url.href);
      })
      .catch((error: unknown) => {
        retryInFlightRef.current = false;
        setRetrying(false);
        setStatus(oidcCallbackRetryErrorStatus(error));
      });
  };

  const statusTitle =
    status.kind === "ready"
      ? "Signed in"
      : status.kind === "error"
        ? "Sign-in needs attention"
        : status.kind === "empty"
          ? "Nothing to finish"
          : "Completing sign-in";
  const statusIcon =
    status.kind === "error" ? (
      <AlertCircle aria-hidden="true" />
    ) : status.kind === "ready" ? (
      <UserRound aria-hidden="true" />
    ) : status.kind === "empty" ? (
      <KeyRound aria-hidden="true" />
    ) : (
      <Loader2 className="cloud-home-status-spinner" aria-hidden="true" />
    );

  return (
    <main className="cloud-home">
      <section className="cloud-home-layout" aria-label="nteract sign-in callback">
        <div className="cloud-home-copy">
          <h1>nteract</h1>
          <span>returning to the notebook</span>
        </div>

        <section
          className="cloud-home-panel"
          data-mode={status.kind}
          aria-label="Cloud sign-in status"
        >
          <div className="cloud-home-status" data-mode={status.kind}>
            {statusIcon}
            <div>
              <h2>{statusTitle}</h2>
              <p>{status.message}</p>
            </div>
          </div>

          {status.kind === "error" || status.kind === "empty" ? (
            <div className="cloud-home-actions">
              {status.kind === "error" && status.canRetry ? (
                <button type="button" disabled={retrying} onClick={retryOidcLogin}>
                  {retrying ? "Starting..." : "Try again"}
                </button>
              ) : null}
              <a href="/">Back to nteract</a>
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}

function oidcCallbackExchangeErrorStatus(error: unknown): OidcCallbackStatus {
  if (error instanceof OidcTimeoutError) {
    return {
      kind: "error",
      canRetry: true,
      message: "The sign-in provider did not respond. Try again to restart sign-in.",
    };
  }
  return {
    kind: "error",
    canRetry: true,
    message: error instanceof Error ? error.message : String(error),
  };
}

function oidcCallbackRetryErrorStatus(error: unknown): OidcCallbackStatus {
  return {
    kind: "error",
    canRetry: true,
    message: error instanceof Error ? error.message : String(error),
  };
}
