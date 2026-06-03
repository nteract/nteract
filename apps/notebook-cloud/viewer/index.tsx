import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  AlertCircle,
  Cloud,
  CloudOff,
  Globe2,
  KeyRound,
  Link2,
  Loader2,
  LogIn,
  LogOut,
  Mail,
  RotateCcw,
  Share2,
  Trash2,
  UserRound,
} from "lucide-react";
import { IsolatedRendererProvider } from "@/components/isolated/isolated-renderer-context";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import type { NotebookRailPanelId } from "@/components/notebook-rail";
import {
  NotebookCommandToolbar,
  NotebookDocumentHeader,
  NotebookEditModeButton,
  navigateNotebookOutlineItem,
  NotebookDocumentRail,
  NotebookDocumentShell,
  NotebookPresenceStatus,
  NotebookPackageSummaryPanel,
  NotebookToolbarFrame,
  type NotebookEnvironmentManager,
  type NotebookInteractionMode,
  type NotebookInteractionModeProjection,
  type NotebookPackageSection,
  type NotebookShellCapabilities,
  useNotebookCellUIStateBridge,
  useNotebookViewModel,
} from "@/components/notebook";
import { MediaProvider } from "@/components/outputs/media-provider";
import { useWidgetStoreRequired } from "@/components/widgets/widget-store-context";
import { useTheme } from "@/hooks/useTheme";
import { ErrorBoundary } from "@/lib/error-boundary";
import type { NotebookOutlineItem } from "runtimed";
import { createNotebookCloudBlobResolver } from "../src/blob-resolver";
import {
  clearCloudPrototypeDevAuth,
  cloudNotebookSignInCopy,
  cloudPrototypeAuthFromWindow,
  cloudSyncAuthFromPrototypeAuthState,
  fetchWithCloudPrototypeAuth,
  isCloudPrototypeAuthStorageKey,
  prepareCloudOidcViewerLogin,
  prototypeAuthSummary,
  storeCloudRequestedScope,
  withCloudPrototypeAuthHeaders,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";
import { createCloudNotebookCellId } from "./cloud-cell-id";
import { connectCloudSyncRuntime, type CloudSyncRuntime } from "./live-sync";
import { loadSnapshotPairHandle } from "./runtimed-wasm-client";
import { cloudNotebookShellCapabilities } from "./shell-capabilities";
import {
  CrdtBridgeProvider,
  emitBroadcast,
  emitPresence,
  createNotebookController,
  NotebookView,
  PresenceValueProvider,
  setLoggerHost,
  startCursorDispatch,
  type PresenceContextValue,
} from "../../notebook/src/notebook-surface";
import {
  projectCloudCellsIntoNotebookViewStores,
  resetCloudViewStoreProjection,
} from "./notebook-view-store-bridge";
import {
  beginOidcLogin,
  completeOidcRedirect,
  normalizeOidcAuthConfig,
  refreshStoredOidcToken,
  storedOidcTokenNeedsRefresh,
  type CloudOidcAuthConfig,
} from "./oidc-auth";
import { CloudLivePresenceStore } from "./live-presence";
import { cloudViewerLoadingPolicy } from "./loading-policy";
import { markCloudViewerLoadMilestone } from "./load-milestones";
import { CLOUD_VIEWER_PRIORITY } from "./mime-policy";
import {
  type CloudViewerPresenceConnection,
  type CloudViewerPresenceState,
  cloudViewerPresenceDisplay,
  initialCloudViewerPresence,
  reduceCloudViewerConnection,
  reduceCloudViewerPresenceMessage,
} from "./presence";
import { createOutputResolutionCache, type ResolvedCell } from "./render-resolution";
import { materializeCloudNotebookView } from "./cloud-view-model";
import { CloudNotebookNotices, cloudNotebookHasNotices } from "./notices";
import type { CloudAuthRenewalState, ViewerStatus } from "./notice-types";
import { rendererAssetBasePathForProvider } from "./renderer-assets";
import {
  buildCloudShareAccessRows,
  cloudShareAccessSummary,
  hasPublicViewerAccess,
  normalizeShareInviteEmail,
  type CloudNotebookAclRow,
  type CloudNotebookInvite,
  type CloudShareAccessRow,
  type CloudShareInviteScope,
} from "./sharing-client";
import { preloadSiftWasmForCells } from "./sift-preload";
import { cloudSourceLanguage } from "./source-language";
import { loadSupplementalViewerCss } from "./supplemental-css";
import {
  applyDocumentTheme,
  CLOUD_VIEWER_THEME_STORAGE_KEY,
  installDocumentThemeSync,
} from "./theme";
import {
  CLOUD_WIDGET_RENDERERS,
  CloudWidgetStoreProvider,
  projectCloudWidgetComms,
} from "./widget-runtime";
import "./index.css";

setLoggerHost({
  debug: () => {},
  info: () => {},
  warn: (message: string, ...args: unknown[]) => console.warn(message, ...args),
  error: (message: string, ...args: unknown[]) => console.error(message, ...args),
});

interface CloudViewerConfig {
  notebookId: string;
  headsHash: string | null;
  catalogEndpoint: string;
  snapshotBasePath: string;
  runtimeSnapshotBasePath: string;
  aclEndpoint: string;
  invitesEndpoint: string;
  syncEndpoint: string;
  blobBasePath: string;
  rendererAssetsBasePath: string;
  outputDocumentBaseUrl: string | null;
  runtimedWasmModulePath: string;
  runtimedWasmPath: string;
}

interface CloudViewerAuthConfig {
  oidc: CloudOidcAuthConfig | null;
}

interface CloudNotebookCatalogRevision {
  notebook_heads_hash: string;
  runtime_heads_hash: string | null;
  runtime_state_doc_id: string | null;
}

interface CloudNotebookCatalog {
  revisions?: CloudNotebookCatalogRevision[];
}

interface ViewerRuntime {
  config: CloudViewerConfig;
}

type ViewerRuntimeState =
  | { kind: "ready"; runtime: ViewerRuntime }
  | { kind: "error"; message: string };

installDocumentThemeSync();

function requireElement<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing cloud viewer element ${selector}`);
  }
  return element;
}

function loadConfig(): CloudViewerConfig {
  const element = requireElement<HTMLScriptElement>("#nteract-cloud-viewer-config");
  const parsed = JSON.parse(element.textContent ?? "{}") as Partial<CloudViewerConfig>;
  if (
    !parsed.notebookId ||
    !parsed.catalogEndpoint ||
    !parsed.snapshotBasePath ||
    !parsed.runtimeSnapshotBasePath ||
    !parsed.aclEndpoint ||
    !parsed.invitesEndpoint ||
    !parsed.syncEndpoint ||
    !parsed.blobBasePath ||
    !parsed.rendererAssetsBasePath ||
    !parsed.runtimedWasmModulePath ||
    !parsed.runtimedWasmPath
  ) {
    throw new Error("Cloud viewer config is incomplete");
  }
  return {
    notebookId: parsed.notebookId,
    headsHash: parsed.headsHash ?? null,
    catalogEndpoint: parsed.catalogEndpoint,
    snapshotBasePath: parsed.snapshotBasePath,
    runtimeSnapshotBasePath: parsed.runtimeSnapshotBasePath,
    aclEndpoint: parsed.aclEndpoint,
    invitesEndpoint: parsed.invitesEndpoint,
    syncEndpoint: parsed.syncEndpoint,
    blobBasePath: parsed.blobBasePath,
    rendererAssetsBasePath: parsed.rendererAssetsBasePath,
    outputDocumentBaseUrl: parsed.outputDocumentBaseUrl ?? null,
    runtimedWasmModulePath: parsed.runtimedWasmModulePath,
    runtimedWasmPath: parsed.runtimedWasmPath,
  };
}

function loadViewerRuntime(): ViewerRuntimeState {
  try {
    const config = loadConfig();
    return {
      kind: "ready",
      runtime: { config },
    };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function loadAuthConfig(): CloudViewerAuthConfig {
  const element = document.querySelector<HTMLScriptElement>("#nteract-cloud-auth-config");
  if (!element) {
    return { oidc: null };
  }
  try {
    const parsed = JSON.parse(element.textContent ?? "{}") as {
      oidc?: Partial<CloudOidcAuthConfig> | null;
    };
    return { oidc: normalizeOidcAuthConfig(parsed.oidc) };
  } catch {
    return { oidc: null };
  }
}

function isOidcCallbackPath(): boolean {
  return window.location.pathname.replace(/\/+$/, "") === "/oidc";
}

function isHomePath(): boolean {
  const pathname = window.location.pathname.replace(/\/+$/, "");
  return pathname === "" || pathname === "/index.html";
}

function useCloudPrototypeAuth(authConfig: CloudViewerAuthConfig): {
  authState: CloudPrototypeAuthState;
  authRenewal: CloudAuthRenewalState;
  refreshAuthState: () => void;
} {
  const [authState, setAuthState] = useState<CloudPrototypeAuthState>(() =>
    cloudPrototypeAuthFromWindow(),
  );
  const [authRenewal, setAuthRenewal] = useState<CloudAuthRenewalState>(() =>
    shouldRefreshStoredOidcToken()
      ? { kind: "refreshing", message: "Refreshing sign-in..." }
      : { kind: "idle", message: null },
  );
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const refreshAuthState = useCallback(() => {
    setAuthState(cloudPrototypeAuthFromWindow());
    if (!shouldRefreshStoredOidcToken()) {
      setAuthRenewal({ kind: "idle", message: null });
    }
  }, []);

  const refreshOidcIfNeeded = useCallback(async () => {
    const oidc = authConfig.oidc;
    if (!oidc || !shouldRefreshStoredOidcToken()) {
      return;
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
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[notebook-cloud] OIDC session refresh failed", error);
        refreshAuthState();
        setAuthRenewal({ kind: "failed", message: `Unable to refresh sign-in: ${message}` });
      } finally {
        refreshPromiseRef.current = null;
      }
    })();
    refreshPromiseRef.current = refreshPromise;
    return refreshPromise;
  }, [authConfig.oidc, refreshAuthState]);

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

function shouldRefreshStoredOidcToken(): boolean {
  try {
    return Boolean(window.localStorage && storedOidcTokenNeedsRefresh(window.localStorage));
  } catch {
    return false;
  }
}

function App() {
  const [authConfig] = useState<CloudViewerAuthConfig>(() => loadAuthConfig());
  const [runtimeState] = useState<ViewerRuntimeState | null>(() =>
    isOidcCallbackPath() || isHomePath() ? null : loadViewerRuntime(),
  );

  if (isHomePath()) {
    return <CloudHomeView authConfig={authConfig} />;
  }

  if (isOidcCallbackPath()) {
    return <OidcCallbackView authConfig={authConfig} />;
  }

  if (!runtimeState) {
    return <ViewerStartupError message="Unable to start cloud viewer: missing runtime state" />;
  }
  if (runtimeState.kind === "error") {
    return <ViewerStartupError message={`Unable to start cloud viewer: ${runtimeState.message}`} />;
  }

  return (
    <CloudNotebookProviders config={runtimeState.runtime.config}>
      <NotebookViewer runtime={runtimeState.runtime} authConfig={authConfig} />
    </CloudNotebookProviders>
  );
}

function CloudNotebookProviders({
  children,
  config,
}: {
  children: ReactNode;
  config: CloudViewerConfig;
}) {
  useEffect(() => {
    loadSupplementalViewerCss();
  }, []);

  return (
    <IsolatedRendererProvider
      basePath={rendererAssetBasePathForProvider(config.rendererAssetsBasePath)}
    >
      <CloudWidgetStoreProvider>
        <MediaProvider priority={CLOUD_VIEWER_PRIORITY} renderers={CLOUD_WIDGET_RENDERERS}>
          {children}
        </MediaProvider>
      </CloudWidgetStoreProvider>
    </IsolatedRendererProvider>
  );
}

function CloudHomeView({ authConfig }: { authConfig: CloudViewerAuthConfig }) {
  const { resolvedTheme } = useTheme(CLOUD_VIEWER_THEME_STORAGE_KEY);
  const { authState, authRenewal, refreshAuthState } = useCloudPrototypeAuth(authConfig);
  const [authAction, setAuthAction] = useState<"idle" | "starting">("idle");
  const [formError, setFormError] = useState<string | null>(null);
  const oidcConfigured = Boolean(authConfig.oidc);

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  const beginOidcAuth = async () => {
    if (!authConfig.oidc) {
      setFormError("OIDC sign-in is not configured for this host.");
      return;
    }
    try {
      setAuthAction("starting");
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
    clearCloudPrototypeDevAuth(window.localStorage);
    setFormError(null);
    refreshAuthState();
  };

  const signedIn = authState.mode === "oidc";
  const homeStatusTitle = signedIn ? (authState.user ?? "Signed in") : "Public viewer";
  const homeStatusDescription = signedIn
    ? prototypeAuthSummary(authState)
    : "Public notebooks stay readable without an account. Sign in when you need edit access or sharing controls.";

  return (
    <main className="cloud-home">
      <header className="cloud-report-toolbar" aria-label="Notebook cloud entry controls">
        <div className="cloud-home-title">
          <span>nteract cloud notebooks</span>
          <small>live documents for shared computation</small>
        </div>
      </header>

      <section className="cloud-home-layout" aria-label="Notebook cloud entry">
        <div className="cloud-home-copy">
          <p>Cloud notebooks</p>
          <h1>Stay in the document.</h1>
          <span>
            Public notebooks open calmly. Account controls appear only when you need to edit, share,
            or renew access.
          </span>
        </div>

        <section
          className="cloud-home-panel"
          data-mode={authState.mode}
          aria-label="Notebook cloud sign-in"
        >
          <div className="cloud-home-status" data-mode={authState.mode}>
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
          {authRenewal.kind !== "idle" ? (
            <div
              className="cloud-auth-form-error"
              data-kind={authRenewal.kind === "failed" ? "error" : "info"}
              role={authRenewal.kind === "failed" ? "alert" : "status"}
            >
              {authRenewal.message}
            </div>
          ) : null}

          <div className="cloud-home-actions">
            {signedIn ? (
              <button
                type="button"
                onClick={() => {
                  clearCloudPrototypeDevAuth(window.localStorage);
                  refreshAuthState();
                }}
              >
                <LogOut aria-hidden="true" />
                Sign out
              </button>
            ) : (
              <button
                type="button"
                disabled={authAction === "starting" || !oidcConfigured}
                onClick={beginOidcAuth}
              >
                <LogIn aria-hidden="true" />
                {authAction === "starting"
                  ? "Starting sign-in"
                  : oidcConfigured
                    ? "Sign in with Anaconda"
                    : "Sign-in unavailable"}
              </button>
            )}
            {authState.mode === "invalid" || authState.mode === "oidc_expired" ? (
              <button type="button" onClick={resetAuth}>
                <RotateCcw aria-hidden="true" />
                Reset
              </button>
            ) : null}
          </div>

          {oidcConfigured ? null : (
            <p className="cloud-home-note">
              This host has no sign-in provider configured. Public notebooks can still be read.
            </p>
          )}
        </section>
      </section>
    </main>
  );
}

function OidcCallbackView({ authConfig }: { authConfig: CloudViewerAuthConfig }) {
  const { resolvedTheme } = useTheme(CLOUD_VIEWER_THEME_STORAGE_KEY);
  const [status, setStatus] = useState<ViewerStatus>({
    kind: "loading",
    message: "Completing sign-in...",
  });

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    const oidc = authConfig.oidc;
    if (!oidc) {
      setStatus({ kind: "error", message: "OIDC sign-in is not configured for this host." });
      return;
    }

    const params = new URLSearchParams(window.location.search);
    if (!params.has("code") || !params.has("state")) {
      setStatus({ kind: "empty", message: "No sign-in callback is pending." });
      return;
    }

    let cancelled = false;
    void completeOidcRedirect(oidc, {
      callbackUrl: window.location.href,
      storage: window.localStorage,
    })
      .then(({ returnUrl }) => {
        if (cancelled) return;
        setStatus({ kind: "ready", message: "Signed in. Returning to the notebook..." });
        window.location.replace(returnUrl);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStatus({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [authConfig.oidc]);

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
      <header className="cloud-report-toolbar" aria-label="Sign-in status and controls">
        <div className="cloud-home-title">
          <span>nteract cloud notebooks</span>
          <small>account handoff</small>
        </div>
      </header>

      <section className="cloud-home-layout" aria-label="Notebook cloud sign-in callback">
        <div className="cloud-home-copy">
          <p>Cloud sign-in</p>
          <h1>Returning to the notebook.</h1>
          <span>
            The browser is finishing the account handoff. The notebook stays readable while access
            renews.
          </span>
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
              <a href="/">Back to cloud notebooks</a>
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}

function NotebookViewer({
  runtime,
  authConfig,
}: {
  runtime: ViewerRuntime;
  authConfig: CloudViewerAuthConfig;
}) {
  const { config } = runtime;
  const loadingPolicy = cloudViewerLoadingPolicy(config);
  const { resolvedTheme } = useTheme(CLOUD_VIEWER_THEME_STORAGE_KEY);
  const { store: widgetStore } = useWidgetStoreRequired();
  const [status, setStatus] = useState<ViewerStatus>({
    kind: "loading",
    message: loadingPolicy.initialStatusMessage,
  });
  const [cells, setCells] = useState<ResolvedCell[]>([]);
  const [focusedCellId, setFocusedCellId] = useState<string | null>(null);
  const [notebookMetadata, setNotebookMetadata] = useState<unknown>(null);
  const [activeRailPanel, setActiveRailPanel] = useState<NotebookRailPanelId>("outline");
  const [railCollapsed, setRailCollapsed] = useState(initialCloudRailCollapsed);
  const [selectedOutlineItemId, setSelectedOutlineItemId] = useState<string | null>(null);
  const cellsRef = useRef<ResolvedCell[]>([]);
  const cellsByIdRef = useRef(new Map<string, ResolvedCell>());
  const notebookLanguageRef = useRef("python");
  const liveRuntimeRef = useRef<CloudSyncRuntime | null>(null);
  const materializeLiveRuntimeRef = useRef<((runtime: CloudSyncRuntime) => void) | null>(null);
  const liveMaterializedRef = useRef(false);
  const snapshotResolvedRef = useRef(false);
  const projectedWidgetCommIdsRef = useRef(new Set<string>());
  const outputResolutionCacheRef = useRef(createOutputResolutionCache());
  const [presence, setPresence] = useState(initialCloudViewerPresence);
  const [connectionScope, setConnectionScope] = useState<string | null>(null);
  const [connectionPeerId, setConnectionPeerId] = useState<string | null>(null);
  const [connectionActorLabel, setConnectionActorLabel] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectAttempt, setConnectAttempt] = useState(0);
  const { authState, authRenewal, refreshAuthState } = useCloudPrototypeAuth(authConfig);
  const [selectedInteractionMode, setSelectedInteractionMode] = useState<NotebookInteractionMode>(
    () =>
      authState.requestedScope === "editor" || authState.requestedScope === "owner"
        ? "edit"
        : "view",
  );
  const blobResolver = useMemo(
    () =>
      createNotebookCloudBlobResolver({
        baseUrl: location.href,
        blobBasePath: config.blobBasePath,
        fetchImpl: (input, init) => fetchWithCloudPrototypeAuth(input, init, authState),
      }),
    [authState, config.blobBasePath],
  );
  const preloadSiftWasm = useCallback(
    (nextCells: readonly ResolvedCell[]) => {
      preloadSiftWasmForCells(nextCells, {
        blobBasePath: config.blobBasePath,
        rendererAssetsBasePath: config.rendererAssetsBasePath,
        pageUrl: location.href,
      });
    },
    [config.blobBasePath, config.rendererAssetsBasePath],
  );
  const outputHostContext = useMemo<NteractEmbedHostContextPatch>(
    () => ({
      nteract: {
        rendererAssetsBaseUrl: new URL(config.rendererAssetsBasePath, location.href).href,
        outputDocumentUrl: config.outputDocumentBaseUrl
          ? new URL(config.outputDocumentBaseUrl, location.href).href
          : undefined,
      },
    }),
    [config.outputDocumentBaseUrl, config.rendererAssetsBasePath],
  );

  useEffect(() => {
    markCloudViewerLoadMilestone("viewer-start");
  }, []);

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  useLayoutEffect(() => {
    cellsRef.current = cells;
    cellsByIdRef.current = new Map(cells.map((cell) => [cell.id, cell]));
    projectCloudCellsIntoNotebookViewStores(cells);
  }, [cells]);

  useEffect(() => resetCloudViewStoreProjection, []);

  useNotebookCellUIStateBridge({ focusedCellId });

  useEffect(() => {
    if (authRenewal.kind === "refreshing") {
      return;
    }
    if (!loadingPolicy.shouldFetchSnapshotRender) {
      snapshotResolvedRef.current = true;
      return;
    }
    if (!config.headsHash) {
      snapshotResolvedRef.current = true;
      setStatus({ kind: "error", message: "Pinned notebook heads are not configured." });
      return;
    }
    const pinnedHeadsHash = config.headsHash;

    let cancelled = false;

    void (async () => {
      let handle: Awaited<ReturnType<typeof loadSnapshotPairHandle>> | null = null;
      try {
        const catalogResponse = await fetch(
          config.catalogEndpoint,
          withCloudPrototypeAuthHeaders({ headers: { Accept: "application/json" } }, authState),
        );
        if (!catalogResponse.ok) {
          if (!cancelled) {
            snapshotResolvedRef.current = true;
            setStatus({
              kind: catalogResponse.status === 404 ? "empty" : "error",
              message:
                catalogResponse.status === 404
                  ? "No published snapshot is available for this notebook yet."
                  : `Unable to load notebook catalog: ${catalogResponse.status}`,
            });
          }
          return;
        }

        const catalog = (await catalogResponse.json()) as CloudNotebookCatalog;
        const revision = catalog.revisions?.find(
          (candidate) => candidate.notebook_heads_hash === pinnedHeadsHash,
        );
        if (!revision || !revision.runtime_heads_hash || !revision.runtime_state_doc_id) {
          if (!cancelled) {
            snapshotResolvedRef.current = true;
            setStatus({
              kind: "empty",
              message: "No complete snapshot pair is available for these pinned heads.",
            });
          }
          return;
        }

        const [notebookSnapshotResponse, runtimeSnapshotResponse] = await Promise.all([
          fetch(
            pinnedSnapshotEndpoint(config.snapshotBasePath, pinnedHeadsHash),
            withCloudPrototypeAuthHeaders(
              { headers: { Accept: "application/octet-stream" } },
              authState,
            ),
          ),
          fetch(
            pinnedSnapshotEndpoint(config.runtimeSnapshotBasePath, revision.runtime_heads_hash),
            withCloudPrototypeAuthHeaders(
              {
                headers: {
                  Accept: "application/octet-stream",
                  "X-Runtime-State-Doc-Id": revision.runtime_state_doc_id,
                },
              },
              authState,
            ),
          ),
        ]);
        if (!notebookSnapshotResponse.ok || !runtimeSnapshotResponse.ok) {
          if (!cancelled) {
            snapshotResolvedRef.current = true;
            setStatus({
              kind: "error",
              message: `Unable to load pinned snapshot pair: notebook ${notebookSnapshotResponse.status}, runtime ${runtimeSnapshotResponse.status}`,
            });
          }
          return;
        }

        handle = await loadSnapshotPairHandle(
          new Uint8Array(await notebookSnapshotResponse.arrayBuffer()),
          new Uint8Array(await runtimeSnapshotResponse.arrayBuffer()),
          config.runtimedWasmModulePath,
          config.runtimedWasmPath,
        );
        const outputResolutionCache = outputResolutionCacheRef.current;
        const materialized = await materializeCloudNotebookView(handle, {
          blobResolver,
          defaultNotebookLanguage: "python",
          outputResolutionCache,
          callbacks: {
            shouldContinue: () => !cancelled && !liveMaterializedRef.current,
            onInitialCells(syncCells) {
              if (syncCells.length === 0) return;
              markCloudViewerLoadMilestone("snapshot-initial-cells");
              setCells(syncCells);
              setStatus({
                kind: "loading",
                message: `Rendering ${syncCells.length} cells while resolving output payloads...`,
              });
            },
            onCellResolved(resolvedCell, _index, progressiveCells) {
              if (progressiveCells.length === 0) return;
              preloadSiftWasm([resolvedCell]);
              setCells(progressiveCells);
            },
          },
        });
        if (cancelled || liveMaterializedRef.current) return;
        notebookLanguageRef.current = materialized.notebookLanguage;
        setNotebookMetadata(materialized.metadata);

        snapshotResolvedRef.current = true;
        await projectCloudWidgetComms(
          widgetStore,
          materialized.widgetComms,
          projectedWidgetCommIdsRef,
          {
            isAllowedBlobUrl: (url) => isConfiguredBlobUrl(url, config.blobBasePath),
            shouldContinue: () => !cancelled && !liveMaterializedRef.current,
          },
        );
        if (cancelled || liveMaterializedRef.current) return;
        const resolvedCells = materialized.cells;
        preloadSiftWasm(resolvedCells);
        setCells(resolvedCells);
        if (resolvedCells.length === 0) {
          setStatus({ kind: "empty", message: "This published notebook has no cells." });
          return;
        }

        setStatus({
          kind: "ready",
          message: `Rendering ${resolvedCells.length} cells from pinned Automerge snapshots.`,
        });
        markCloudViewerLoadMilestone("snapshot-ready");
      } catch (error) {
        if (!cancelled) {
          snapshotResolvedRef.current = true;
          setStatus({ kind: "error", message: `Unable to load notebook: ${String(error)}` });
        }
      } finally {
        handle?.free();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    authRenewal.kind,
    authState,
    blobResolver,
    config.catalogEndpoint,
    config.blobBasePath,
    config.headsHash,
    config.runtimeSnapshotBasePath,
    config.runtimedWasmModulePath,
    config.runtimedWasmPath,
    config.snapshotBasePath,
    loadingPolicy.shouldFetchSnapshotRender,
    preloadSiftWasm,
    widgetStore,
  ]);

  useEffect(() => {
    if (authRenewal.kind === "refreshing") {
      return;
    }
    if (!loadingPolicy.shouldConnectLiveRoom) {
      return;
    }

    let disposed = false;
    let subscriptions: Array<{ unsubscribe: () => void }> = [];
    let materializeSequence = 0;
    let livePresenceStore: CloudLivePresenceStore | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const sessionId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    const disposeCurrentRuntime = () => {
      const liveRuntime = liveRuntimeRef.current;
      if (!liveRuntime) return;
      liveRuntimeRef.current = null;
      disposeCloudSyncRuntime(liveRuntime);
    };
    const scheduleReconnect = (reason: Error) => {
      if (disposed) return;
      console.warn("[notebook-cloud] live room connection closed", reason);
      setPresence((state) => reduceCloudViewerConnection(state, "disconnected"));
      setConnectionScope(null);
      setConnectionActorLabel(null);
      setConnectionError(reason.message);
      disposeCurrentRuntime();
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!disposed) {
          setConnectAttempt((attempt) => attempt + 1);
        }
      }, 1_000);
    };

    const materializeLiveCells = async (liveRuntime: CloudSyncRuntime) => {
      const sequence = ++materializeSequence;
      const previousNotebookLanguage = notebookLanguageRef.current;
      const outputResolutionCache = outputResolutionCacheRef.current;
      const rawCellCount = liveRuntime.handle.cell_count();
      if (rawCellCount === 0 && (!snapshotResolvedRef.current || cellsRef.current.length > 0)) {
        return;
      }
      const materialized = await materializeCloudNotebookView(liveRuntime.handle, {
        blobResolver,
        defaultNotebookLanguage: previousNotebookLanguage ?? "python",
        outputResolutionCache,
        callbacks: {
          shouldContinue: () => !disposed && sequence === materializeSequence,
          onInitialCells(syncCells) {
            if (syncCells.length === 0) return;
            liveMaterializedRef.current = true;
            markCloudViewerLoadMilestone("live-initial-cells");
            preloadSiftWasm(syncCells);
            setCells(syncCells);
            setStatus({
              kind: "loading",
              message: `Rendering ${syncCells.length} live cells while resolving output payloads...`,
            });
          },
          onCellResolved(resolvedCell, _index, progressiveCells) {
            if (progressiveCells.length === 0) return;
            liveMaterializedRef.current = true;
            preloadSiftWasm([resolvedCell]);
            setCells(progressiveCells);
          },
        },
      });
      if (materialized.rawCellCount === 0) {
        if (!snapshotResolvedRef.current || cellsRef.current.length > 0) {
          return;
        }
      }
      if (disposed || sequence !== materializeSequence) return;
      notebookLanguageRef.current = materialized.notebookLanguage;
      setNotebookMetadata(materialized.metadata);

      await projectCloudWidgetComms(
        widgetStore,
        materialized.widgetComms,
        projectedWidgetCommIdsRef,
        {
          isAllowedBlobUrl: (url) => isConfiguredBlobUrl(url, config.blobBasePath),
          shouldContinue: () => !disposed && sequence === materializeSequence,
        },
      );
      if (disposed || sequence !== materializeSequence) return;
      liveMaterializedRef.current = true;
      const resolvedCells = materialized.cells;
      preloadSiftWasm(resolvedCells);
      setCells(resolvedCells);
      setStatus(
        resolvedCells.length === 0
          ? { kind: "empty", message: "This notebook room has no cells yet." }
          : {
              kind: "ready",
              message: `Rendering ${resolvedCells.length} cells from the live notebook room.`,
            },
      );
      if (resolvedCells.length > 0) {
        markCloudViewerLoadMilestone("live-ready");
      }
    };

    const materializeLiveCellsSafely = (liveRuntime: CloudSyncRuntime) => {
      void materializeLiveCells(liveRuntime).catch((error: unknown) => {
        if (disposed) return;
        console.warn("[notebook-cloud] live room materialization failed", error);
      });
    };
    materializeLiveRuntimeRef.current = materializeLiveCellsSafely;

    setPresence(initialCloudViewerPresence());
    setConnectionError(null);
    setConnectionActorLabel(null);
    setConnectionPeerId(null);
    void connectCloudSyncRuntime({
      syncEndpoint: config.syncEndpoint,
      runtimedWasmModulePath: config.runtimedWasmModulePath,
      runtimedWasmPath: config.runtimedWasmPath,
      sessionId,
      auth: cloudSyncAuthFromPrototypeAuthState(authState),
      onDisconnect: scheduleReconnect,
      onControl: (message) => {
        if (disposed) return;
        if (
          message.type === "cloud_room_ready" ||
          message.type === "cloud_peer_joined" ||
          message.type === "cloud_peer_left"
        ) {
          setPresence((state) => reduceCloudViewerPresenceMessage(state, message));
        }
        if (message.type === "cloud_room_ready") {
          markCloudViewerLoadMilestone("live-room-ready");
          setConnectionError(null);
          setConnectionScope(message.connection_scope);
          setConnectionActorLabel(message.actor_label);
        }
        if (message.type === "cloud_frame_rejected") {
          setStatus({ kind: "error", message: `Room rejected a frame: ${message.reason}` });
        }
      },
    })
      .then((liveRuntime) => {
        if (disposed) {
          disposeCloudSyncRuntime(liveRuntime);
          return;
        }
        liveRuntimeRef.current = liveRuntime;
        setConnectionScope(liveRuntime.connectionScope);
        setConnectionActorLabel(liveRuntime.actorLabel);
        setConnectionPeerId(liveRuntime.peerId);
        livePresenceStore = new CloudLivePresenceStore(liveRuntime.peerId);
        const stopCursorDispatch = startCursorDispatch(liveRuntime.peerId);
        subscriptions = [
          liveRuntime.engine.broadcasts$.subscribe((payload) => {
            emitBroadcast(payload);
          }),
          liveRuntime.engine.presence$.subscribe((payload) => {
            emitPresence(payload);
            livePresenceStore?.handlePresence(payload);
          }),
          liveRuntime.engine.cellChanges$.subscribe(() => {
            materializeLiveCellsSafely(liveRuntime);
          }),
          liveRuntime.engine.runtimeState$.subscribe(() => {
            materializeLiveCellsSafely(liveRuntime);
          }),
          { unsubscribe: stopCursorDispatch },
        ];
        materializeLiveCellsSafely(liveRuntime);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        if (cellsRef.current.length === 0) {
          setStatus({
            kind: "error",
            message: `Unable to load live notebook room: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
        setPresence((state) => reduceCloudViewerConnection(state, "disconnected"));
        setConnectionScope(null);
        setConnectionActorLabel(null);
        setConnectionPeerId(null);
        setConnectionError(error instanceof Error ? error.message : String(error));
        console.warn("[notebook-cloud] live room connection failed", error);
      });

    return () => {
      disposed = true;
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      materializeLiveRuntimeRef.current = null;
      disposeCurrentRuntime();
      resetCloudViewStoreProjection();
      livePresenceStore = null;
      setPresence((state) => reduceCloudViewerConnection(state, "disconnected"));
      setConnectionPeerId(null);
    };
  }, [
    authRenewal.kind,
    authState,
    blobResolver,
    config.blobBasePath,
    config.runtimedWasmModulePath,
    config.runtimedWasmPath,
    config.syncEndpoint,
    connectAttempt,
    loadingPolicy.shouldConnectLiveRoom,
    preloadSiftWasm,
    widgetStore,
  ]);

  const notebookViewModel = useNotebookViewModel({
    metadata: notebookMetadata,
    resolveLanguage: cloudSourceLanguage,
  });
  const { codeCellCount, outlineItems } = notebookViewModel;
  useEffect(() => {
    if (!selectedOutlineItemId) return;
    if (!outlineItems.some((item) => item.id === selectedOutlineItemId)) {
      setSelectedOutlineItemId(null);
    }
  }, [outlineItems, selectedOutlineItemId]);
  const handleSelectOutlineItem = useCallback((item: NotebookOutlineItem) => {
    setSelectedOutlineItemId(item.id);
  }, []);
  const handleNavigateOutlineItem = useCallback((item: NotebookOutlineItem, href: string) => {
    setSelectedOutlineItemId(item.id);
    return navigateNotebookOutlineItem(item, href);
  }, []);
  const handleTogglePackagesRail = useCallback(() => {
    if (activeRailPanel === "packages" && !railCollapsed) {
      setActiveRailPanel("outline");
      return;
    }
    setRailCollapsed(false);
    setActiveRailPanel("packages");
  }, [activeRailPanel, railCollapsed]);
  const canAcceptCellMutations =
    Boolean(connectionPeerId) &&
    !connectionError &&
    (status.kind === "ready" || status.kind === "empty");
  const shellCapabilities = useMemo(
    () =>
      cloudNotebookShellCapabilities({
        authState,
        connectionScope,
        connectionActorLabel,
        hasCodeCells: codeCellCount > 0,
        selectedMode: selectedInteractionMode,
        canAcceptCellMutations,
      }),
    [
      authState,
      canAcceptCellMutations,
      codeCellCount,
      connectionActorLabel,
      connectionScope,
      selectedInteractionMode,
    ],
  );
  const canWriteCellSource = useCallback(
    (cellId: string) => {
      const cell = cellsByIdRef.current.get(cellId);
      if (!cell) {
        return false;
      }
      if (cell.cellType === "markdown") {
        return shellCapabilities.canEditMarkdown;
      }
      return shellCapabilities.canEditCells;
    },
    [shellCapabilities],
  );
  const notebookCellIds = notebookViewModel.cellIds;
  const packageEnvironmentManager = cloudNotebookEnvironmentManager(
    notebookViewModel.packages.sections,
  );
  const requestCloudMaterialization = useCallback((liveRuntime: CloudSyncRuntime) => {
    materializeLiveRuntimeRef.current?.(liveRuntime);
  }, []);
  const cloudNotebookController = useMemo(
    () =>
      createNotebookController({
        getHandle: () => liveRuntimeRef.current?.handle ?? null,
        getEngine: () => liveRuntimeRef.current?.engine ?? null,
        canWriteCellSource,
        canEditStructure: () => shellCapabilities.canEditStructure,
        canAcceptStructure: (handle) => handle.cell_count() > 0,
        createCellId: createCloudNotebookCellId,
        syncMode: {
          structure: "scheduleFlush",
          outputs: "scheduleFlush",
          visibility: "scheduleFlush",
        },
        afterMutation: (handle) => {
          const liveRuntime = liveRuntimeRef.current;
          if (liveRuntime?.handle === handle) {
            requestCloudMaterialization(liveRuntime);
          }
        },
        onFocusCell: setFocusedCellId,
        logPrefix: "[notebook-cloud]",
      }),
    [canWriteCellSource, requestCloudMaterialization, shellCapabilities.canEditStructure],
  );
  const handleCloudAddCell = useCallback(
    (type: "code" | "markdown", afterCellId?: string | null) => {
      return cloudNotebookController.addCell(type, afterCellId);
    },
    [cloudNotebookController],
  );
  const handleCloudDeleteCell = useCallback(
    (cellId: string) => {
      cloudNotebookController.deleteCell(cellId);
    },
    [cloudNotebookController],
  );
  const handleCloudMoveCell = useCallback(
    (cellId: string, afterCellId?: string | null) => {
      cloudNotebookController.moveCell(cellId, afterCellId);
    },
    [cloudNotebookController],
  );
  const getLiveNotebookHandle = useCallback(() => liveRuntimeRef.current?.handle ?? null, []);
  const cloudPresenceContext = useMemo<PresenceContextValue | null>(
    () =>
      connectionPeerId
        ? {
            peerId: connectionPeerId,
            setCursor: (cellId, line, column) => {
              liveRuntimeRef.current?.sendCursorPresence(cellId, line, column);
            },
            setSelection: (cellId, anchorLine, anchorCol, headLine, headCol) => {
              liveRuntimeRef.current?.sendSelectionPresence(
                cellId,
                anchorLine,
                anchorCol,
                headLine,
                headCol,
              );
            },
            setFocus: () => {},
          }
        : null,
    [connectionPeerId],
  );
  const handleSourceSyncNeeded = useCallback(() => {
    if (!shellCapabilities.canEditCells && !shellCapabilities.canEditMarkdown) return;
    liveRuntimeRef.current?.engine.scheduleFlush();
  }, [shellCapabilities.canEditCells, shellCapabilities.canEditMarkdown]);
  const resetPrototypeAuth = useCallback(() => {
    clearCloudPrototypeDevAuth(window.localStorage);
    setSelectedInteractionMode("view");
    refreshAuthState();
  }, [refreshAuthState]);
  const requestCloudEditAccess = useCallback(() => {
    storeCloudRequestedScope(window.localStorage, "editor");
    setSelectedInteractionMode("edit");
    refreshAuthState();
  }, [refreshAuthState]);
  const rail = (
    <NotebookDocumentRail
      viewModel={notebookViewModel}
      activePanelId={activeRailPanel}
      collapsed={railCollapsed}
      selectedOutlineItemId={selectedOutlineItemId}
      packagesPanel={
        <NotebookPackageSummaryPanel
          packages={notebookViewModel.packages}
          readOnly={!shellCapabilities.canManagePackages}
        />
      }
      onActivePanelChange={setActiveRailPanel}
      onCollapsedChange={setRailCollapsed}
      onSelectOutlineItem={handleSelectOutlineItem}
      onNavigateOutlineItem={handleNavigateOutlineItem}
      className="cloud-notebook-rail"
    />
  );

  const toolbar = (
    <NotebookToolbarFrame className="z-20">
      <NotebookDocumentHeader
        capabilities={shellCapabilities}
        className="cloud-room-toolbar"
        presence={<CloudNotebookTitle notebookId={config.notebookId} />}
        utilityControls={
          <>
            <CloudConnectionStatus connection={presence.connection} error={connectionError} />
            <CloudPresenceStatus presence={presence} />
          </>
        }
        authControls={
          shouldShowCloudHeaderSignIn(authState) ? (
            <CloudNotebookSignInButton authConfig={authConfig} authState={authState} />
          ) : null
        }
        sharingControls={
          <CloudSharingControls
            aclEndpoint={config.aclEndpoint}
            invitesEndpoint={config.invitesEndpoint}
            authState={authState}
          />
        }
        editControls={
          <CloudNotebookEditModeButton
            authState={authState}
            interaction={shellCapabilities.interaction ?? null}
            accessLevel={shellCapabilities.access.level}
            onModeChange={setSelectedInteractionMode}
            onRequestEditAccess={requestCloudEditAccess}
          />
        }
        identityControls={null}
      />
      {shouldShowCloudNotebookCommandToolbar(shellCapabilities) ? (
        <NotebookCommandToolbar
          capabilities={shellCapabilities}
          runtime={notebookLanguageRef.current === "deno" ? "deno" : "python"}
          environmentManager={packageEnvironmentManager}
          environmentPanelOpen={activeRailPanel === "packages" && !railCollapsed}
          addAfterCellId={notebookCellIds[notebookCellIds.length - 1] ?? null}
          onAddCell={handleCloudAddCell}
          onTogglePackages={handleTogglePackagesRail}
        />
      ) : null}
    </NotebookToolbarFrame>
  );
  const notebookHasReadableSnapshot =
    notebookCellIds.length > 0 ||
    (!connectionError && snapshotResolvedRef.current && status.kind === "ready");
  const hasNotices = cloudNotebookHasNotices({
    authState,
    authRenewal,
    connectionError,
    hasReadableSnapshot: notebookHasReadableSnapshot,
    status,
  });
  const notebookViewIsLoading =
    status.kind === "loading" ||
    (Boolean(connectionError) && !notebookHasReadableSnapshot) ||
    (shellCapabilities.canEditStructure &&
      notebookCellIds.length === 0 &&
      !liveMaterializedRef.current);
  const notices = hasNotices ? (
    <CloudNotebookNotices
      authState={authState}
      authRenewal={authRenewal}
      connectionError={connectionError}
      hasReadableSnapshot={notebookHasReadableSnapshot}
      status={status}
      onResetAuth={resetPrototypeAuth}
    />
  ) : null;

  return (
    <NotebookDocumentShell
      rootElement="main"
      className="cloud-notebook-shell"
      stageClassName="cloud-notebook-stage"
      toolbar={toolbar}
      toolbarLabel="Notebook view status and controls"
      notices={notices}
      noticesClassName="cloud-notebook-notices"
      capabilities={shellCapabilities}
      rail={rail}
      stageLabel="Hosted notebook"
    >
      <h1 className="sr-only">nteract cloud notebook {config.notebookId}</h1>

      <PresenceValueProvider value={cloudPresenceContext}>
        <CrdtBridgeProvider
          getHandle={getLiveNotebookHandle}
          canWriteSource={canWriteCellSource}
          onSyncNeeded={handleSourceSyncNeeded}
          localActor={connectionActorLabel ?? ""}
        >
          <NotebookView
            cellIds={notebookCellIds}
            isLoading={notebookViewIsLoading}
            capabilities={shellCapabilities}
            canAcceptCellMutations={canAcceptCellMutations}
            runtime={notebookLanguageRef.current === "deno" ? "deno" : "python"}
            sessionRuntimeState={connectionError ? "error" : "ready"}
            onFocusCell={setFocusedCellId}
            onExecuteCell={() => {}}
            onInterruptKernel={() => {}}
            onDeleteCell={handleCloudDeleteCell}
            onAddCell={handleCloudAddCell}
            onMoveCell={handleCloudMoveCell}
            markdownHeadingAnchorsByCellId={notebookViewModel.markdownHeadingAnchorsByCellId}
            outputHostContext={outputHostContext}
          />
        </CrdtBridgeProvider>
      </PresenceValueProvider>
    </NotebookDocumentShell>
  );
}

function cloudNotebookEnvironmentManager(
  sections: readonly NotebookPackageSection[],
): NotebookEnvironmentManager | null {
  for (const section of sections) {
    if (section.manager === "uv" || section.manager === "conda" || section.manager === "pixi") {
      return section.manager;
    }
  }
  return null;
}

function CloudSharingControls({
  aclEndpoint,
  invitesEndpoint,
  authState,
}: {
  aclEndpoint: string;
  invitesEndpoint: string;
  authState: CloudPrototypeAuthState;
}) {
  const [open, setOpen] = useState(false);
  const [acl, setAcl] = useState<CloudNotebookAclRow[]>([]);
  const [invites, setInvites] = useState<CloudNotebookInvite[]>([]);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<"info" | "error">("info");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteScope, setInviteScope] = useState<CloudShareInviteScope>("viewer");
  const [formError, setFormError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const inviteSubmitLockRef = useRef(false);
  const publicLink = new URL(window.location.pathname, window.location.origin).href;
  const accessRows = useMemo(() => buildCloudShareAccessRows({ acl, invites }), [acl, invites]);
  const accessSummary = useMemo(() => cloudShareAccessSummary(accessRows), [accessRows]);
  const publicEnabled = useMemo(() => hasPublicViewerAccess(acl), [acl]);
  const inviteReady = normalizeShareInviteEmail(inviteEmail) !== null;

  const loadSharingState = useCallback(
    async (options?: { preserveMessage?: boolean; signal?: AbortSignal }) => {
      setLoadState("loading");
      if (!options?.preserveMessage) {
        setMessage(null);
      }
      try {
        const [aclResponse, invitesResponse] = await Promise.all([
          fetchWithCloudPrototypeAuth(
            aclEndpoint,
            { headers: { Accept: "application/json" }, signal: options?.signal },
            authState,
          ),
          fetchWithCloudPrototypeAuth(
            invitesEndpoint,
            { headers: { Accept: "application/json" }, signal: options?.signal },
            authState,
          ),
        ]);
        if (options?.signal?.aborted) {
          return;
        }
        if (!aclResponse.ok) {
          throw await cloudResponseError(aclResponse, "Unable to load access list");
        }
        if (!invitesResponse.ok) {
          throw await cloudResponseError(invitesResponse, "Unable to load invites");
        }
        const aclBody = (await aclResponse.json()) as { acl?: CloudNotebookAclRow[] };
        const invitesBody = (await invitesResponse.json()) as { invites?: CloudNotebookInvite[] };
        setAcl(Array.isArray(aclBody.acl) ? aclBody.acl : []);
        setInvites(Array.isArray(invitesBody.invites) ? invitesBody.invites : []);
        setLoadState("ready");
      } catch (error) {
        if (options?.signal?.aborted) {
          return;
        }
        setLoadState("error");
        setMessageKind("error");
        setMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [aclEndpoint, authState, invitesEndpoint],
  );

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void loadSharingState({ signal: controller.signal });
    return () => controller.abort();
  }, [loadSharingState, open]);

  const copyPublicLink = async () => {
    try {
      await navigator.clipboard.writeText(publicLink);
      setCopyState("copied");
      setMessageKind("info");
      setMessage("Link copied.");
    } catch {
      setCopyState("failed");
      setMessageKind("error");
      setMessage("Unable to copy the link.");
    }
  };

  const submitInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inviteSubmitLockRef.current) {
      return;
    }
    const email = normalizeShareInviteEmail(inviteEmail);
    if (!email) {
      setFormError("Enter a valid email address.");
      return;
    }

    inviteSubmitLockRef.current = true;
    setBusyAction("invite");
    setFormError(null);
    setMessage(null);
    try {
      const response = await fetchWithCloudPrototypeAuth(
        invitesEndpoint,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email, scope: inviteScope }),
        },
        authState,
      );
      if (!response.ok) {
        throw await cloudResponseError(response, "Unable to create invite");
      }
      setInviteEmail("");
      setMessageKind("info");
      setMessage(`Invite created for ${email}.`);
      await loadSharingState({ preserveMessage: true });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      inviteSubmitLockRef.current = false;
      setBusyAction(null);
    }
  };

  const togglePublicAccess = async () => {
    setBusyAction("public");
    setMessage(null);
    try {
      const response = await fetchWithCloudPrototypeAuth(
        aclEndpoint,
        {
          method: publicEnabled ? "DELETE" : "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            subject_kind: "public",
            subject: "anonymous",
            scope: "viewer",
          }),
        },
        authState,
      );
      if (!response.ok) {
        throw await cloudResponseError(
          response,
          publicEnabled ? "Unable to disable public link" : "Unable to enable public link",
        );
      }
      setMessageKind("info");
      setMessage(publicEnabled ? "Public link disabled." : "Public link enabled.");
      await loadSharingState({ preserveMessage: true });
    } catch (error) {
      setMessageKind("error");
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const removeAccessRow = async (row: CloudShareAccessRow) => {
    if (!row.removable) return;

    setBusyAction(row.id);
    setMessage(null);
    try {
      const response =
        row.kind === "invite"
          ? await fetchWithCloudPrototypeAuth(
              appendEndpointPathSegment(invitesEndpoint, row.invite.id),
              {
                method: "DELETE",
                headers: { Accept: "application/json" },
              },
              authState,
            )
          : await fetchWithCloudPrototypeAuth(
              aclEndpoint,
              {
                method: "DELETE",
                headers: {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  subject_kind: row.acl.subject_kind,
                  subject: row.acl.subject,
                  scope: row.acl.scope,
                }),
              },
              authState,
            );
      if (!response.ok) {
        throw await cloudResponseError(response, "Unable to remove access");
      }
      setMessageKind("info");
      setMessage(`${row.label} removed.`);
      await loadSharingState({ preserveMessage: true });
    } catch (error) {
      setMessageKind("error");
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const copyLinkLabel =
    copyState === "copied" ? "Copied link" : copyState === "failed" ? "Copy failed" : "Copy link";
  const compactCopyLinkLabel =
    copyState === "copied" ? "Copied" : copyState === "failed" ? "Failed" : "Copy";

  return (
    <details
      className="cloud-share-menu"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary title="Share notebook">
        <Share2 aria-hidden="true" />
        <span>Share</span>
      </summary>
      <div className="cloud-share-panel">
        <header>
          <div>
            <h2>Share notebook</h2>
            <p>Public link, collaborators, and pending invites for this notebook.</p>
          </div>
          <button type="button" aria-label={copyLinkLabel} onClick={() => void copyPublicLink()}>
            <Link2 aria-hidden="true" />
            <span className="cloud-share-copy-label-full">{copyLinkLabel}</span>
            <span className="cloud-share-copy-label-compact">{compactCopyLinkLabel}</span>
          </button>
        </header>

        <section className="cloud-share-public" aria-label="Public link access">
          <div>
            <Globe2 aria-hidden="true" />
            <div>
              <strong>Anyone with the link</strong>
              <span>
                {publicEnabled
                  ? "Can view this notebook without signing in"
                  : "Only invited people can open this notebook"}
              </span>
            </div>
          </div>
          <button
            type="button"
            disabled={busyAction === "public" || loadState === "loading"}
            onClick={() => void togglePublicAccess()}
          >
            {publicEnabled ? "Disable" : "Enable"}
          </button>
        </section>

        <form className="cloud-share-invite" onSubmit={submitInvite}>
          <label>
            <span>Invite by email</span>
            <input
              type="email"
              value={inviteEmail}
              placeholder="name@example.com"
              autoComplete="email"
              onChange={(event) => {
                setInviteEmail(event.target.value);
                setFormError(null);
              }}
            />
          </label>
          <label>
            <span>Access</span>
            <select
              value={inviteScope}
              onChange={(event) => setInviteScope(event.target.value as CloudShareInviteScope)}
            >
              <option value="viewer">Can view</option>
              <option value="editor">Can edit</option>
            </select>
          </label>
          <button type="submit" disabled={!inviteReady || busyAction === "invite"}>
            <Mail aria-hidden="true" />
            Invite
          </button>
          {formError ? (
            <div className="cloud-auth-form-error" role="alert">
              {formError}
            </div>
          ) : null}
        </form>

        <section className="cloud-share-current" aria-label="Current notebook access">
          <div className="cloud-share-current-heading">
            <h3>Current access</h3>
            {accessSummary ? <span>{accessSummary}</span> : null}
          </div>
          {loadState === "loading" && accessRows.length === 0 ? (
            <div className="cloud-share-empty">Loading access...</div>
          ) : accessRows.length === 0 ? (
            <div className="cloud-share-empty">Only the owner can access this notebook.</div>
          ) : (
            <ul>
              {accessRows.map((row) => (
                <li key={row.id}>
                  <CloudShareRowIcon row={row} />
                  <div>
                    <strong>{row.label}</strong>
                    <span>{row.detail}</span>
                  </div>
                  <div className="cloud-share-row-actions">
                    <span className="cloud-share-badge">{row.badge}</span>
                    {row.stateLabel ? (
                      <span className="cloud-share-state" data-tone={row.stateTone ?? undefined}>
                        {row.stateLabel}
                      </span>
                    ) : null}
                    {row.removable ? (
                      <button
                        type="button"
                        aria-label={`Remove ${row.label}`}
                        title={`Remove ${row.label}`}
                        disabled={busyAction === row.id}
                        onClick={() => void removeAccessRow(row)}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {message ? (
          <div className="cloud-share-message" data-kind={messageKind}>
            {message}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function CloudNotebookEditModeButton({
  authState,
  accessLevel,
  interaction,
  onModeChange,
  onRequestEditAccess,
}: {
  authState: CloudPrototypeAuthState;
  accessLevel: NotebookShellCapabilities["access"]["level"];
  interaction: NotebookInteractionModeProjection | null;
  onModeChange: (mode: NotebookInteractionMode) => void;
  onRequestEditAccess: () => void;
}) {
  const canUseEditModeControl = authState.mode === "dev" || authState.mode === "oidc";
  if (
    !canUseEditModeControl ||
    (!interaction?.canRequestEdit && interaction?.activeMode !== "edit")
  ) {
    return null;
  }

  return (
    <NotebookEditModeButton
      mode={interaction.selectedMode}
      state={interaction.state}
      variant="segmented"
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

function CloudNotebookSignInButton({
  authConfig,
  authState,
}: {
  authConfig: CloudViewerAuthConfig;
  authState: CloudPrototypeAuthState;
}) {
  const [authAction, setAuthAction] = useState<"idle" | "starting">("idle");
  const [error, setError] = useState<string | null>(null);

  if (!authConfig.oidc || authState.mode === "oidc") {
    return null;
  }
  const copy = cloudNotebookSignInCopy(authState, authAction, error);

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
      <span>{copy.label}</span>
    </button>
  );
}

function CloudShareRowIcon({ row }: { row: CloudShareAccessRow }) {
  if (row.kind === "invite") {
    return <Mail aria-hidden="true" />;
  }
  if (row.acl.subject_kind === "public") {
    return <Globe2 aria-hidden="true" />;
  }
  return <UserRound aria-hidden="true" />;
}

function shouldShowCloudNotebookCommandToolbar(capabilities: NotebookShellCapabilities): boolean {
  return capabilities.canEditStructure || capabilities.canExecute || capabilities.canManagePackages;
}

function initialCloudRailCollapsed(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(max-width: 599.98px)").matches;
}

function disposeCloudSyncRuntime(liveRuntime: CloudSyncRuntime): void {
  liveRuntime.engine.stop();
  liveRuntime.transport.disconnect();
  liveRuntime.handle.free();
}

function shouldShowCloudHeaderSignIn(authState: CloudPrototypeAuthState): boolean {
  return (
    authState.mode === "anonymous" ||
    authState.mode === "invalid" ||
    authState.mode === "oidc_expired"
  );
}

function CloudNotebookTitle({ notebookId }: { notebookId: string }) {
  const title = cloudNotebookRouteTitle(notebookId);

  return (
    <div className="cloud-notebook-title" title={title.title}>
      <span>{title.label}</span>
      {title.detail ? <small>{title.detail}</small> : null}
    </div>
  );
}

function cloudNotebookRouteTitle(notebookId: string): {
  label: string;
  detail: string | null;
  title: string;
} {
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const routeNotebookId = pathParts[0] === "n" ? pathParts[1] : null;
  const routeSlug = pathParts[0] === "n" ? pathParts[2] : null;
  const decodedSlug = safeDecodeRouteSegment(routeSlug);
  const decodedNotebookId = safeDecodeRouteSegment(routeNotebookId) ?? notebookId;

  if (decodedSlug) {
    const label = humanizeCloudRouteTitle(decodedSlug);
    return {
      label,
      detail: null,
      title: `${label} (${decodedNotebookId})`,
    };
  }

  return {
    label: "Cloud Notebook",
    detail: null,
    title: decodedNotebookId,
  };
}

function humanizeCloudRouteTitle(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => {
      if (!word) return word;
      return `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}`;
    })
    .join(" ");
}

function safeDecodeRouteSegment(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value).trim() || null;
  } catch {
    return value.trim() || null;
  }
}

function CloudConnectionStatus({
  connection,
  error,
}: {
  connection: CloudViewerPresenceConnection;
  error: string | null;
}) {
  const connected = connection === "connected" && !error;
  const connecting = connection === "connecting" && !error;
  const label = connected ? "Live" : connecting ? "Joining" : "Reconnecting";
  const title = connected
    ? "Connected to the notebook room"
    : connecting
      ? "Joining the notebook room"
      : error
        ? `Reconnecting to the notebook room: ${cloudConnectionStatusErrorTitle(error)}`
        : "Reconnecting to the notebook room";
  const Icon = connected || connecting ? Cloud : CloudOff;

  return (
    <span
      className="cloud-connection-status"
      data-state={connected ? "live" : "waiting"}
      title={title}
      aria-label={title}
    >
      <Icon aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function cloudConnectionStatusErrorTitle(error: string): string {
  if (/\bfailed to connect\s+wss?:\/\//i.test(error)) {
    return "unable to join the live room";
  }
  return sanitizeCloudConnectionError(error);
}

function sanitizeCloudConnectionError(error: string): string {
  return error.replace(/\bwss?:\/\/[^\s]+/gi, (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return rawUrl.replace(/[?#].*$/, "");
    }
  });
}

function CloudPresenceStatus({ presence }: { presence: CloudViewerPresenceState }) {
  const presenceDisplay = cloudViewerPresenceDisplay(presence);

  if (!presenceDisplay.connected) {
    return null;
  }

  return (
    <NotebookPresenceStatus
      connected={presenceDisplay.connected}
      label={presenceDisplay.label}
      title={presenceDisplay.title}
      variant="inline"
    />
  );
}

function appendEndpointPathSegment(endpoint: string, segment: string): string {
  const base = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
  return `${base}/${encodeURIComponent(segment)}`;
}

async function cloudResponseError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) {
      return new Error(`${fallback}: ${body.error}`);
    }
  } catch {
    // Ignore malformed error responses and fall back to the HTTP status.
  }
  return new Error(`${fallback}: ${response.status}`);
}

function ViewerStartupError({ message }: { message: string }) {
  return (
    <main className="flex min-h-screen w-full flex-col px-8 py-4 pr-4">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold tracking-normal">nteract cloud notebook</h1>
      </header>
      <div className="cloud-state" data-kind="error">
        {message}
      </div>
    </main>
  );
}

function isConfiguredBlobUrl(value: string, blobBasePath: string): boolean {
  try {
    const url = new URL(value, location.href);
    const base = new URL(blobBasePath, location.href);
    const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    return url.origin === base.origin && url.pathname.startsWith(basePath);
  } catch {
    return false;
  }
}

function pinnedSnapshotEndpoint(basePath: string, headsHash: string): string {
  const normalizedBasePath = basePath.endsWith("/") ? basePath : `${basePath}/`;
  return `${normalizedBasePath}${encodeURIComponent(headsHash)}`;
}

createRoot(requireElement("#root")).render(
  <ErrorBoundary
    fallback={(error) => <ViewerStartupError message={`Cloud viewer crashed: ${error.message}`} />}
  >
    <App />
  </ErrorBoundary>,
);
