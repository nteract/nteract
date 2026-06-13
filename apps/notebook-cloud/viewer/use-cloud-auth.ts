import { useCallback, useEffect, useRef, useState } from "react";
import {
  cloudAppSessionIsFresh,
  cloudAppSessionNeedsRenewal,
  establishCloudAppSession,
  readCloudAppSessionStatus,
  type CloudAppSession,
} from "./app-session";
import { cloudOidcRenewalFailureMessage } from "./auth-renewal-copy";
import {
  cloudPrototypeAuthFromWindow,
  isCloudPrototypeAuthStorageKey,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";
import type { CloudAuthRenewalState } from "./notice-types";
import { refreshStoredOidcToken, storedOidcTokenNeedsRefresh } from "./oidc-auth";
import type { CloudViewerAuthConfig } from "./cloud-viewer-types";

interface CloudPrototypeAuthOptions {
  appSessionRefreshFallback?: boolean;
  appSessionLoading?: boolean;
  appSession?: CloudAppSession | null;
}

export interface CloudAppSessionViewState {
  status: "loading" | "ready" | "error";
  session: CloudAppSession | null;
  error: string | null;
}

export function cloudAppSessionsEqual(
  a: CloudAppSession | null,
  b: CloudAppSession | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.provider === b.provider && a.expires_at === b.expires_at;
}

/**
 * Ready-state reducer for a session-status fetch result that keeps OBJECT
 * IDENTITIES stable when the fetch only confirms what we already have.
 *
 * The session object feeds effect dependency chains (resolveSyncAuth → the
 * live-room effect), so installing a fresh-but-content-identical object on
 * every mount fetch tears down and reconnects the live room gratuitously.
 * Returning `current` unchanged lets React bail out of the re-render
 * entirely.
 */
export function nextCloudAppSessionReadyState(
  current: CloudAppSessionViewState,
  fetchedSession: CloudAppSession | null,
): CloudAppSessionViewState {
  const session = cloudAppSessionsEqual(current.session, fetchedSession)
    ? current.session
    : fetchedSession;
  if (current.status === "ready" && current.session === session && current.error === null) {
    return current;
  }
  return { status: "ready", session, error: null };
}

export function useCloudPrototypeAuth(
  authConfig: CloudViewerAuthConfig,
  options?: CloudPrototypeAuthOptions,
): {
  authState: CloudPrototypeAuthState;
  authRenewal: CloudAuthRenewalState;
  refreshAuthState: () => void;
} {
  const [authState, setAuthState] = useState<CloudPrototypeAuthState>(() =>
    cloudPrototypeAuthFromWindow(),
  );
  const appSession = options?.appSession ?? null;
  const appSessionLoading = options?.appSessionLoading === true;
  const [authRenewal, setAuthRenewal] = useState<CloudAuthRenewalState>(() =>
    shouldRefreshStoredOidcToken() && !cloudAppSessionIsFresh(appSession) && !appSessionLoading
      ? { kind: "refreshing", message: "Refreshing sign-in..." }
      : { kind: "idle", message: null },
  );
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const appSessionRefreshFallback = options?.appSessionRefreshFallback === true;
  const refreshAuthState = useCallback(() => {
    setAuthState(cloudPrototypeAuthFromWindow());
    if (!shouldRefreshStoredOidcToken() || cloudAppSessionIsFresh(appSession)) {
      setAuthRenewal({ kind: "idle", message: null });
    }
  }, [appSession]);

  const refreshOidcIfNeeded = useCallback(async () => {
    const oidc = authConfig.oidc;
    if (!oidc || !shouldRefreshStoredOidcToken()) {
      return;
    }
    if (appSessionRefreshFallback) {
      if (appSessionLoading && !appSession) {
        setAuthRenewal({ kind: "idle", message: null });
        return;
      }
      if (cloudAppSessionIsFresh(appSession)) {
        setAuthRenewal({ kind: "idle", message: null });
        return;
      }
    }
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    const refreshPromise = (async () => {
      setAuthRenewal({ kind: "refreshing", message: "Refreshing sign-in..." });
      try {
        await refreshStoredOidcToken(oidc, { storage: window.localStorage });
        refreshAuthState();
        setAuthRenewal({ kind: "idle", message: null });
      } catch (error) {
        if (appSessionRefreshFallback) {
          const appSession = await readCloudAppSessionStatus().catch(() => null);
          if (cloudAppSessionIsFresh(appSession?.session)) {
            console.warn(
              "[notebook-cloud] OIDC session refresh failed; continuing with app session cookie",
              error,
            );
            refreshAuthState();
            setAuthRenewal({ kind: "idle", message: null });
            return;
          }
        }
        console.warn("[notebook-cloud] OIDC session refresh failed", error);
        refreshAuthState();
        setAuthRenewal({ kind: "failed", message: cloudOidcRenewalFailureMessage(error) });
      } finally {
        refreshPromiseRef.current = null;
      }
    })();
    refreshPromiseRef.current = refreshPromise;
    return refreshPromise;
  }, [appSession, appSessionLoading, appSessionRefreshFallback, authConfig.oidc, refreshAuthState]);

  useEffect(() => {
    void refreshOidcIfNeeded();

    const interval = window.setInterval(() => {
      void refreshOidcIfNeeded();
    }, 60_000);
    const refreshOnFocus = () => {
      void refreshOidcIfNeeded();
    };
    const refreshOnVisibility = () => {
      if (document.visibilityState === "visible") {
        void refreshOidcIfNeeded();
      }
    };
    const refreshOnStorage = (event: StorageEvent) => {
      if (event.storageArea && event.storageArea !== window.localStorage) {
        return;
      }
      if (!isCloudPrototypeAuthStorageKey(event.key)) {
        return;
      }
      refreshAuthState();
      void refreshOidcIfNeeded();
    };
    window.addEventListener("focus", refreshOnFocus);
    window.addEventListener("storage", refreshOnStorage);
    document.addEventListener("visibilitychange", refreshOnVisibility);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOnFocus);
      window.removeEventListener("storage", refreshOnStorage);
      document.removeEventListener("visibilitychange", refreshOnVisibility);
    };
  }, [refreshAuthState, refreshOidcIfNeeded]);

  return { authState, authRenewal, refreshAuthState };
}

export function useCloudAppSessionStatus(
  initialSession: CloudAppSession | null,
): CloudAppSessionViewState & {
  clearAppSessionStatus: () => void;
  refreshAppSessionStatus: () => void;
} {
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [state, setState] = useState<CloudAppSessionViewState>(() => ({
    status: initialSession ? "ready" : "loading",
    session: initialSession,
    error: null,
  }));

  useEffect(() => {
    if (!initialSession) {
      return;
    }
    setState({ status: "ready", session: initialSession, error: null });
  }, [initialSession]);

  useEffect(() => {
    if (refreshIndex === 0 && cloudAppSessionIsFresh(initialSession)) {
      return;
    }

    const controller = new AbortController();
    setState((current) =>
      current.session || current.status === "loading"
        ? current
        : { ...current, status: "loading", error: null },
    );
    void readCloudAppSessionStatus({ signal: controller.signal })
      .then((status) => {
        if (controller.signal.aborted) return;
        setState((current) => nextCloudAppSessionReadyState(current, status.session));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((current) => ({
          status: "error",
          session: current.session,
          error: error instanceof Error ? error.message : String(error),
        }));
      });

    return () => {
      controller.abort();
    };
  }, [initialSession, refreshIndex]);

  const clearAppSessionStatus = useCallback(() => {
    setState({ status: "ready", session: null, error: null });
  }, []);
  const refreshAppSessionStatus = useCallback(() => {
    setRefreshIndex((value) => value + 1);
  }, []);

  return {
    ...state,
    clearAppSessionStatus,
    refreshAppSessionStatus,
  };
}

function shouldRefreshStoredOidcToken(): boolean {
  try {
    return Boolean(window.localStorage && storedOidcTokenNeedsRefresh(window.localStorage));
  } catch {
    return false;
  }
}

function currentEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function useCloudAppSessionBridge(
  authState: CloudPrototypeAuthState,
  appSession: CloudAppSession | null,
  appSessionLoading: boolean,
  onEstablished?: () => void,
): void {
  const establishedTokenRef = useRef<string | null>(null);
  const lastAttemptAtRef = useRef(0);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const renewIfNeeded = useCallback(() => {
    if (authState.mode !== "oidc" || !authState.token) {
      establishedTokenRef.current = null;
      return;
    }
    if (appSessionLoading && !appSession) {
      return;
    }

    const nowSeconds = currentEpochSeconds();
    const tokenChanged = establishedTokenRef.current !== authState.token;
    const sessionNeedsRenewal = cloudAppSessionNeedsRenewal(appSession, nowSeconds);
    if (!tokenChanged && !sessionNeedsRenewal) {
      return;
    }
    if (inFlightRef.current) {
      return;
    }
    if (!tokenChanged && nowSeconds - lastAttemptAtRef.current < 5 * 60) {
      return;
    }

    lastAttemptAtRef.current = nowSeconds;
    inFlightRef.current = establishCloudAppSession(authState)
      .then(() => {
        establishedTokenRef.current = authState.token;
        onEstablished?.();
      })
      .catch((error: unknown) => {
        console.warn("[notebook-cloud] app session exchange failed", error);
      })
      .finally(() => {
        inFlightRef.current = null;
      });
  }, [appSession, appSessionLoading, authState, onEstablished]);

  useEffect(() => {
    renewIfNeeded();
    const interval = window.setInterval(renewIfNeeded, 60_000);
    const renewOnFocus = () => renewIfNeeded();
    const renewOnVisibility = () => {
      if (document.visibilityState === "visible") {
        renewIfNeeded();
      }
    };
    window.addEventListener("focus", renewOnFocus);
    document.addEventListener("visibilitychange", renewOnVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", renewOnFocus);
      document.removeEventListener("visibilitychange", renewOnVisibility);
    };
  }, [renewIfNeeded]);
}
