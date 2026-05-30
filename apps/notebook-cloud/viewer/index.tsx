import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  BookOpen,
  Code2,
  Copy,
  Eye,
  EyeOff,
  Globe2,
  KeyRound,
  Link2,
  LogIn,
  LogOut,
  Mail,
  Pencil,
  RotateCcw,
  Share2,
  Trash2,
  UserRound,
  UsersRound,
} from "lucide-react";
import {
  ReadOnlyNotebook,
  type ReadOnlyNotebookCellData,
} from "@/components/cell/ReadOnlyNotebook";
import { ReadOnlyNotebookCell } from "@/components/cell/ReadOnlyNotebookCell";
import { IsolatedRendererProvider } from "@/components/isolated/isolated-renderer-context";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import { MediaProvider } from "@/components/outputs/media-provider";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import type { TracebackCellTarget } from "@/components/outputs/traceback-output";
import { useWidgetStoreRequired } from "@/components/widgets/widget-store-context";
import { useTheme } from "@/hooks/useTheme";
import { ErrorBoundary } from "@/lib/error-boundary";
import { isTextAttributionEvent } from "runtimed";
import { createNotebookCloudBlobResolver } from "../src/blob-resolver";
import { snapshotWidgetCommsFromRuntimeState } from "../src/widget-comms";
import { EditableMarkdownCell, type CloudTextAttributionQueue } from "./editable-markdown-cell";
import type { RemoteCellPresence } from "@/components/editor/presence-state";
import {
  clearCloudPrototypeDevAuth,
  cloudPrototypeAuthFromWindow,
  cloudSyncAuthFromPrototypeAuthState,
  fetchWithCloudPrototypeAuth,
  isCloudPrototypeAuthStorageKey,
  NOTEBOOK_CLOUD_DEFAULT_SCOPE,
  prepareCloudOidcViewerLogin,
  prototypeAuthDiagnostics,
  prototypeAuthSummary,
  storeCloudPrototypeDevAuth,
  storeCloudRequestedScope,
  validatePrototypeToken,
  withCloudPrototypeAuthHeaders,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";
import { connectCloudSyncRuntime, type CloudSyncRuntime } from "./live-sync";
import { loadSnapshotPairHandle } from "./runtimed-wasm-client";
import {
  beginOidcLogin,
  completeOidcRedirect,
  normalizeOidcAuthConfig,
  refreshStoredOidcToken,
  storedOidcTokenNeedsRefresh,
  type CloudOidcAuthConfig,
} from "./oidc-auth";
import type { ConnectionScope } from "../src/auth-shared";
import {
  CloudLivePresenceStore,
  emptyCloudLivePresenceSnapshot,
  type CloudLivePresenceSnapshot,
} from "./live-presence";
import { cloudViewerLoadingPolicy } from "./loading-policy";
import { CLOUD_VIEWER_PRIORITY } from "./mime-policy";
import {
  cloudViewerPresenceDisplay,
  type CloudViewerPresenceState,
  initialCloudViewerPresence,
  reduceCloudViewerConnection,
  reduceCloudViewerPresenceMessage,
} from "./presence";
import { shouldShowPrototypeDevControls } from "./prototype-dev-controls";
import {
  createOutputResolutionCache,
  type RenderCell,
  type ResolvedCell,
} from "./render-resolution";
import { resolveCellsProgressively } from "./progressive-cell-resolution";
import { rendererAssetBasePathForProvider } from "./renderer-assets";
import {
  buildCloudShareAccessRows,
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

type CloudAuthRenewalState =
  | { kind: "idle"; message: null }
  | { kind: "refreshing"; message: string }
  | { kind: "failed"; message: string };

type ViewerStatus =
  | { kind: "loading"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "ready"; message: string }
  | { kind: "error"; message: string };

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
  const { theme, setTheme, resolvedTheme } = useTheme(CLOUD_VIEWER_THEME_STORAGE_KEY);
  const { authState, authRenewal, refreshAuthState } = useCloudPrototypeAuth(authConfig);
  const [scope, setScope] = useState<ConnectionScope>(
    authState.requestedScope ?? NOTEBOOK_CLOUD_DEFAULT_SCOPE,
  );
  const [authAction, setAuthAction] = useState<"idle" | "starting">("idle");
  const [formError, setFormError] = useState<string | null>(null);
  const showPrototypeDevControls = shouldShowPrototypeDevControls({
    oidcConfigured: Boolean(authConfig.oidc),
    hostname: window.location.hostname,
    search: window.location.search,
  });

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
      setScope(NOTEBOOK_CLOUD_DEFAULT_SCOPE);
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

  return (
    <main className="cloud-home">
      <div className="cloud-report-toolbar" aria-label="Notebook cloud entry controls">
        <h1>nteract cloud notebooks</h1>
        <ThemeToggle theme={theme} onThemeChange={setTheme} className="cloud-theme-toggle" />
      </div>

      <section className="cloud-home-panel" aria-label="Notebook cloud sign-in">
        <div className="cloud-home-status" data-mode={authState.mode}>
          <KeyRound aria-hidden="true" />
          <div>
            <h2>{signedIn ? (authState.user ?? "Signed in") : "Sign in"}</h2>
            <p>{prototypeAuthSummary(authState)}</p>
          </div>
        </div>

        {showPrototypeDevControls ? (
          <label className="cloud-home-scope">
            <span>Scope</span>
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value as ConnectionScope)}
            >
              <option value="editor">editor</option>
              <option value="owner">owner</option>
              <option value="runtime_peer">runtime_peer</option>
              <option value="viewer">viewer</option>
            </select>
          </label>
        ) : null}

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
            <button type="button" disabled={authAction === "starting"} onClick={beginOidcAuth}>
              <LogIn aria-hidden="true" />
              {authAction === "starting" ? "Starting sign-in" : "Sign in with Anaconda"}
            </button>
          )}
          <a href="/n/topic-viz">Open topic-viz</a>
          {authState.mode === "invalid" ||
          authState.mode === "access" ||
          authState.mode === "oidc_expired" ? (
            <button type="button" onClick={resetAuth}>
              <RotateCcw aria-hidden="true" />
              Reset
            </button>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function OidcCallbackView({ authConfig }: { authConfig: CloudViewerAuthConfig }) {
  const { theme, setTheme, resolvedTheme } = useTheme(CLOUD_VIEWER_THEME_STORAGE_KEY);
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

  return (
    <main className="flex min-h-screen w-full flex-col px-8 py-4 pr-4">
      <div className="cloud-report-toolbar" aria-label="Sign-in status and controls">
        <h1 className="text-xl font-semibold tracking-normal">nteract cloud notebook</h1>
        <ThemeToggle theme={theme} onThemeChange={setTheme} className="cloud-theme-toggle" />
      </div>
      <div className="cloud-state" data-kind={status.kind}>
        {status.message}
      </div>
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
  const { theme, setTheme, resolvedTheme } = useTheme(CLOUD_VIEWER_THEME_STORAGE_KEY);
  const { store: widgetStore } = useWidgetStoreRequired();
  const [status, setStatus] = useState<ViewerStatus>({
    kind: "loading",
    message: loadingPolicy.initialStatusMessage,
  });
  const [cells, setCells] = useState<ResolvedCell[]>([]);
  const [showCode, setShowCode] = useState(true);
  const cellsRef = useRef<ResolvedCell[]>([]);
  const notebookLanguageRef = useRef("python");
  const liveRuntimeRef = useRef<CloudSyncRuntime | null>(null);
  const liveMaterializedRef = useRef(false);
  const snapshotResolvedRef = useRef(false);
  const projectedWidgetCommIdsRef = useRef(new Set<string>());
  const outputResolutionCacheRef = useRef(createOutputResolutionCache());
  const [presence, setPresence] = useState(initialCloudViewerPresence);
  const [livePresence, setLivePresence] = useState(emptyCloudLivePresenceSnapshot);
  const [connectionScope, setConnectionScope] = useState<string | null>(null);
  const [connectionActorLabel, setConnectionActorLabel] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [textAttributionQueue, setTextAttributionQueue] = useState<CloudTextAttributionQueue>(
    () => ({ batches: [] }),
  );
  const [connectAttempt, setConnectAttempt] = useState(0);
  const { authState, authRenewal, refreshAuthState } = useCloudPrototypeAuth(authConfig);
  const textAttributionSequenceRef = useRef(0);
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
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    cellsRef.current = cells;
  }, [cells]);

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
        const rawCells = JSON.parse(handle.get_cells_json()) as RenderCell[];
        const runtimeState = handle.get_runtime_state();
        const widgetComms = snapshotWidgetCommsFromRuntimeState(runtimeState, blobResolver);
        const metadata = parseJsonOrNull(handle.get_metadata_snapshot_json?.());
        const notebookLanguage = languageFromNotebookMetadata(metadata) ?? "python";
        notebookLanguageRef.current = notebookLanguage;
        const outputResolutionCache = outputResolutionCacheRef.current;
        const resolvedCells = await resolveCellsProgressively(
          rawCells,
          blobResolver,
          notebookLanguage,
          outputResolutionCache,
          {
            shouldContinue: () => !cancelled && !liveMaterializedRef.current,
            onInitialCells(syncCells) {
              if (syncCells.length === 0) return;
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
        );
        if (cancelled || liveMaterializedRef.current) return;

        snapshotResolvedRef.current = true;
        await projectCloudWidgetComms(widgetStore, widgetComms, projectedWidgetCommIdsRef, {
          isAllowedBlobUrl: (url) => isConfiguredBlobUrl(url, config.blobBasePath),
          shouldContinue: () => !cancelled && !liveMaterializedRef.current,
        });
        if (cancelled || liveMaterializedRef.current) return;
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
      const rawCells = JSON.parse(liveRuntime.handle.get_cells_json()) as RenderCell[];
      if (rawCells.length === 0) {
        if (!snapshotResolvedRef.current || cellsRef.current.length > 0) {
          return;
        }
      }
      const widgetComms = snapshotWidgetCommsFromRuntimeState(
        liveRuntime.handle.get_runtime_state(),
        blobResolver,
      );
      const metadata = parseJsonOrNull(liveRuntime.handle.get_metadata_snapshot_json?.());
      const notebookLanguage =
        languageFromNotebookMetadata(metadata) ?? notebookLanguageRef.current ?? "python";
      notebookLanguageRef.current = notebookLanguage;
      const outputResolutionCache = outputResolutionCacheRef.current;
      const resolvedCells = await resolveCellsProgressively(
        rawCells,
        blobResolver,
        notebookLanguage,
        outputResolutionCache,
        {
          shouldContinue: () => !disposed && sequence === materializeSequence,
          onInitialCells(syncCells) {
            if (syncCells.length === 0) return;
            liveMaterializedRef.current = true;
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
      );
      if (disposed || sequence !== materializeSequence) return;

      await projectCloudWidgetComms(widgetStore, widgetComms, projectedWidgetCommIdsRef, {
        isAllowedBlobUrl: (url) => isConfiguredBlobUrl(url, config.blobBasePath),
        shouldContinue: () => !disposed && sequence === materializeSequence,
      });
      if (disposed || sequence !== materializeSequence) return;
      liveMaterializedRef.current = true;
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
    };

    const materializeLiveCellsSafely = (liveRuntime: CloudSyncRuntime) => {
      void materializeLiveCells(liveRuntime).catch((error: unknown) => {
        if (disposed) return;
        console.warn("[notebook-cloud] live room materialization failed", error);
      });
    };

    setPresence(initialCloudViewerPresence());
    setLivePresence(emptyCloudLivePresenceSnapshot());
    setConnectionError(null);
    setConnectionActorLabel(null);
    setTextAttributionQueue({ batches: [] });
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
        livePresenceStore = new CloudLivePresenceStore(liveRuntime.peerId);
        setLivePresence(livePresenceStore.snapshot());
        subscriptions = [
          liveRuntime.engine.broadcasts$.subscribe((payload) => {
            if (!isTextAttributionEvent(payload)) return;
            const sequence = ++textAttributionSequenceRef.current;
            setTextAttributionQueue((queue) => {
              const nextBatch = { sequence, attributions: payload.attributions };
              return {
                batches: [...queue.batches.slice(-63), nextBatch],
              };
            });
          }),
          liveRuntime.engine.presence$.subscribe((payload) => {
            const snapshot = livePresenceStore?.handlePresence(payload);
            if (snapshot) {
              setLivePresence(snapshot);
            }
          }),
          liveRuntime.engine.cellChanges$.subscribe(() => {
            materializeLiveCellsSafely(liveRuntime);
          }),
          liveRuntime.engine.runtimeState$.subscribe(() => {
            materializeLiveCellsSafely(liveRuntime);
          }),
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
      disposeCurrentRuntime();
      livePresenceStore = null;
      setPresence((state) => reduceCloudViewerConnection(state, "disconnected"));
      setLivePresence(emptyCloudLivePresenceSnapshot());
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

  const readOnlyCells = useMemo(
    () =>
      cells.map(
        (cell): ReadOnlyNotebookCellData => ({
          id: cell.id,
          cellType: cell.cellType,
          source: cell.source,
          language: cloudSourceLanguage(cell.language),
          outputs: cell.outputs,
          executionId: cell.executionId,
          executionCount: cell.executionCount,
        }),
      ),
    [cells],
  );
  const codeCellCount = useMemo(
    () => readOnlyCells.filter((cell) => cell.cellType === "code").length,
    [readOnlyCells],
  );
  const tracebackTargets = useMemo(() => {
    const targets = new Map<string, TracebackCellTarget>();
    for (const cell of cells) {
      if (!cell.executionId) continue;
      targets.set(cell.executionId, {
        cellId: cell.id,
      });
    }
    return targets;
  }, [cells]);
  const resolveTracebackExecutionTarget = useCallback(
    (executionId: string) => tracebackTargets.get(executionId) ?? null,
    [tracebackTargets],
  );
  const handleTracebackCellNavigate = useCallback((target: TracebackCellTarget) => {
    findCellElement(target.cellId)?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, []);
  const canEditMarkdown = canEditLiveNotebook(connectionScope);
  const getLiveNotebookHandle = useCallback(() => liveRuntimeRef.current?.handle ?? null, []);
  const handleMarkdownSourceChange = useCallback(
    (cellId: string, source: string) => {
      if (!canEditMarkdown) return;
      const currentCell = cellsRef.current.find((cell) => cell.id === cellId);
      if (currentCell?.cellType !== "markdown") return;

      setCells((current) =>
        current.map((cell) => (cell.id === cellId ? { ...cell, source } : cell)),
      );
    },
    [canEditMarkdown],
  );
  const handleMarkdownSyncNeeded = useCallback(() => {
    if (!canEditMarkdown) return;
    liveRuntimeRef.current?.engine.scheduleFlush();
  }, [canEditMarkdown]);
  const handlePresenceCursor = useCallback((cellId: string, line: number, column: number) => {
    liveRuntimeRef.current?.sendCursorPresence(cellId, line, column);
  }, []);
  const handlePresenceSelection = useCallback(
    (cellId: string, anchorLine: number, anchorCol: number, headLine: number, headCol: number) => {
      liveRuntimeRef.current?.sendSelectionPresence(
        cellId,
        anchorLine,
        anchorCol,
        headLine,
        headCol,
      );
    },
    [],
  );
  const resetPrototypeAuth = useCallback(() => {
    clearCloudPrototypeDevAuth(window.localStorage);
    refreshAuthState();
  }, [refreshAuthState]);

  return (
    <main className="flex min-h-screen w-full flex-col py-6">
      <h1 className="sr-only">nteract cloud notebook {config.notebookId}</h1>

      <div className="cloud-report-toolbar" aria-label="Notebook view status and controls">
        <CloudPresenceStatus presence={presence} connectionScope={connectionScope} />

        <div className="cloud-toolbar-actions">
          <ThemeToggle theme={theme} onThemeChange={setTheme} className="cloud-theme-toggle" />

          {connectionScope === "owner" ? (
            <CloudSharingControls
              aclEndpoint={config.aclEndpoint}
              invitesEndpoint={config.invitesEndpoint}
              authState={authState}
            />
          ) : null}

          <CloudNotebookSignInButton authConfig={authConfig} authState={authState} />

          <CloudNotebookEditModeButton
            authState={authState}
            connectionScope={connectionScope}
            onAuthStateChange={refreshAuthState}
          />

          <CloudAuthControls
            authConfig={authConfig}
            authState={authState}
            connectionActorLabel={connectionActorLabel}
            connectionError={connectionError}
            connectionScope={connectionScope}
            onAuthStateChange={refreshAuthState}
          />

          {status.kind === "ready" && codeCellCount > 0 ? (
            <button
              type="button"
              className="cloud-code-toggle"
              aria-pressed={showCode}
              aria-label={showCode ? "Hide code cells" : "Show code cells"}
              title={showCode ? "Hide code cells" : "Show code cells"}
              onClick={() => setShowCode((current) => !current)}
            >
              {showCode ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              <Code2 aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      {authState.mode === "invalid" || authState.mode === "oidc_expired" ? (
        <div className="cloud-state cloud-auth-state mx-8 mr-4" data-kind="error">
          <span>{prototypeAuthSummary(authState)}</span>
          <button type="button" onClick={resetPrototypeAuth}>
            <RotateCcw aria-hidden="true" />
            Reset to anonymous
          </button>
        </div>
      ) : null}

      {authRenewal.kind !== "idle" ? (
        <div
          className="cloud-state cloud-auth-state mx-8 mr-4"
          data-kind={authRenewal.kind === "failed" ? "error" : "loading"}
        >
          <span>{authRenewal.message}</span>
          {authRenewal.kind === "failed" ? (
            <button type="button" onClick={resetPrototypeAuth}>
              <RotateCcw aria-hidden="true" />
              Reset to anonymous
            </button>
          ) : null}
        </div>
      ) : null}

      {connectionError ? (
        <div className="cloud-state cloud-auth-state mx-8 mr-4" data-kind="error">
          <span>Live room connection failed: {connectionError}</span>
          <button type="button" onClick={resetPrototypeAuth}>
            <RotateCcw aria-hidden="true" />
            Reset to anonymous
          </button>
        </div>
      ) : null}

      {status.kind === "ready" ? null : (
        <div className="cloud-state mx-8 mr-4" data-kind={status.kind}>
          {status.message}
        </div>
      )}

      {canEditMarkdown ? (
        <CloudLiveNotebook
          cells={cells}
          priority={CLOUD_VIEWER_PRIORITY}
          hostContext={outputHostContext}
          showCode={showCode}
          livePresence={livePresence}
          getHandle={getLiveNotebookHandle}
          localActorLabel={connectionActorLabel}
          textAttributionQueue={textAttributionQueue}
          onMarkdownSourceChange={handleMarkdownSourceChange}
          onMarkdownSyncNeeded={handleMarkdownSyncNeeded}
          onPresenceCursor={handlePresenceCursor}
          onPresenceSelection={handlePresenceSelection}
          resolveTracebackExecutionTarget={resolveTracebackExecutionTarget}
          onNavigateToTracebackCell={handleTracebackCellNavigate}
        />
      ) : (
        <ReadOnlyNotebook
          cells={readOnlyCells}
          priority={CLOUD_VIEWER_PRIORITY}
          hostContext={outputHostContext}
          displayMode="report"
          showCode={showCode}
          className="cloud-report-notebook"
          cellClassName="cloud-cell"
          sourceClassName="cloud-source-block"
          outputClassName="cloud-output-block"
          deferIsolatedFrameUntilVisible
          deferredIsolatedFrameRootMargin="600px 0px"
          resolveTracebackExecutionTarget={resolveTracebackExecutionTarget}
          onNavigateToTracebackCell={handleTracebackCellNavigate}
          renderCellError={(error, _cell, index) => (
            <div className="cloud-state" data-kind="error">
              Unable to render cell {index + 1}: {error.message}
            </div>
          )}
        />
      )}
    </main>
  );
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
            <p>Manage public read access and collaborator invites for this cloud notebook.</p>
          </div>
          <button type="button" onClick={() => void copyPublicLink()}>
            <Link2 aria-hidden="true" />
            {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
          </button>
        </header>

        <section className="cloud-share-public" aria-label="Public link access">
          <div>
            <Globe2 aria-hidden="true" />
            <div>
              <strong>Anyone with the link</strong>
              <span>{publicEnabled ? "Can view this notebook" : "No anonymous access"}</span>
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
          <h3>Current access</h3>
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
                  <span className="cloud-share-badge">{row.badge}</span>
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
  connectionScope,
  onAuthStateChange,
}: {
  authState: CloudPrototypeAuthState;
  connectionScope: string | null;
  onAuthStateChange: () => void;
}) {
  if (authState.mode !== "oidc") {
    return null;
  }

  const requestedScope = authState.requestedScope ?? NOTEBOOK_CLOUD_DEFAULT_SCOPE;
  const requestingEdit = requestedScope === "editor" || requestedScope === "owner";
  const editing = connectionScope === "editor" || connectionScope === "owner";
  const label = requestingEdit ? "View" : "Edit";
  const title = requestingEdit
    ? editing
      ? "Return to read-only viewing"
      : "Stop requesting edit access"
    : "Request edit access";

  return (
    <button
      type="button"
      className="cloud-scope-toggle-button"
      aria-pressed={requestingEdit}
      data-state={editing ? "editing" : requestingEdit ? "requested" : "viewing"}
      title={title}
      onClick={() => {
        storeCloudRequestedScope(
          window.localStorage,
          requestingEdit ? NOTEBOOK_CLOUD_DEFAULT_SCOPE : "editor",
        );
        onAuthStateChange();
      }}
    >
      {requestingEdit ? <BookOpen aria-hidden="true" /> : <Pencil aria-hidden="true" />}
      <span>{label}</span>
    </button>
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
      title={error ?? "Sign in with Anaconda"}
      onClick={beginOidcAuth}
    >
      <LogIn aria-hidden="true" />
      <span>{error ? "Sign-in failed" : authAction === "starting" ? "Signing in" : "Sign in"}</span>
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

function CloudAuthControls({
  authConfig,
  authState,
  connectionActorLabel,
  connectionError,
  connectionScope,
  onAuthStateChange,
}: {
  authConfig: CloudViewerAuthConfig;
  authState: CloudPrototypeAuthState;
  connectionActorLabel: string | null;
  connectionError: string | null;
  connectionScope: string | null;
  onAuthStateChange: () => void;
}) {
  const [token, setToken] = useState("");
  const [user, setUser] = useState(authState.user ?? "alice");
  const [scope, setScope] = useState<ConnectionScope>(
    authState.requestedScope ?? NOTEBOOK_CLOUD_DEFAULT_SCOPE,
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [authAction, setAuthAction] = useState<"idle" | "starting">("idle");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const showPrototypeDevControls = shouldShowPrototypeDevControls({
    oidcConfigured: Boolean(authConfig.oidc),
    hostname: window.location.hostname,
    search: window.location.search,
  });
  const summary =
    authState.mode === "dev"
      ? `Dev ${authState.user ?? "browser-editor"}`
      : authState.mode === "oidc"
        ? (authState.user ?? "Signed in")
        : authState.mode === "access"
          ? "Browser session"
          : authState.mode === "invalid" || authState.mode === "oidc_expired"
            ? "Auth needs attention"
            : "Anonymous";
  const diagnostics = prototypeAuthDiagnostics(authState, {
    actorLabel: connectionActorLabel,
    connectionError,
    connectionScope,
  });
  useEffect(() => {
    setCopyState("idle");
  }, [authState, connectionActorLabel, connectionError, connectionScope]);

  const applyDevAuth = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = validatePrototypeToken(token);
    if (problem) {
      setFormError(problem);
      return;
    }
    storeCloudPrototypeDevAuth(window.localStorage, { token, user, scope });
    setToken("");
    setFormError(null);
    onAuthStateChange();
  };

  const beginOidcAuth = async () => {
    if (!authConfig.oidc) {
      setFormError("OIDC sign-in is not configured for this host.");
      return;
    }
    try {
      setAuthAction("starting");
      prepareCloudOidcViewerLogin(window.localStorage);
      setScope(NOTEBOOK_CLOUD_DEFAULT_SCOPE);
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
    setToken("");
    setFormError(null);
    onAuthStateChange();
  };

  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(diagnostics.copyText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <details className="cloud-auth-menu">
      <summary title="Prototype collaborator identity">
        <KeyRound aria-hidden="true" />
        <span>{summary}</span>
      </summary>
      <form onSubmit={applyDevAuth}>
        <p>{prototypeAuthSummary(authState)}</p>
        <dl className="cloud-auth-diagnostics" aria-label="Prototype auth diagnostics">
          {diagnostics.rows.map((row) => (
            <div key={row.label} data-tone={row.tone ?? "default"}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
        {showPrototypeDevControls ? (
          <>
            <label>
              <span>Dev token</span>
              <input
                type="password"
                value={token}
                placeholder="Worker dev token"
                autoComplete="off"
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            <label>
              <span>User</span>
              <input
                type="text"
                value={user}
                autoComplete="off"
                onChange={(event) => setUser(event.target.value)}
              />
            </label>
            <label>
              <span>Scope</span>
              <select
                value={scope}
                onChange={(event) => setScope(event.target.value as ConnectionScope)}
              >
                <option value="editor">editor</option>
                <option value="owner">owner</option>
                <option value="runtime_peer">runtime_peer</option>
                <option value="viewer">viewer</option>
              </select>
            </label>
          </>
        ) : null}
        {formError ? (
          <div className="cloud-auth-form-error" role="alert">
            {formError}
          </div>
        ) : null}
        <div className="cloud-auth-actions">
          {authState.mode === "oidc" ? (
            <button
              type="button"
              onClick={() => {
                clearCloudPrototypeDevAuth(window.localStorage);
                onAuthStateChange();
              }}
            >
              <LogOut aria-hidden="true" />
              Sign out
            </button>
          ) : authConfig.oidc ? (
            <button type="button" disabled={authAction === "starting"} onClick={beginOidcAuth}>
              <LogIn aria-hidden="true" />
              {authAction === "starting" ? "Starting sign-in" : "Sign in"}
            </button>
          ) : null}
          {showPrototypeDevControls ? (
            <button type="submit">
              <KeyRound aria-hidden="true" />
              Use dev identity
            </button>
          ) : null}
          <button type="button" onClick={() => void copyDiagnostics()}>
            <Copy aria-hidden="true" />
            {copyState === "copied"
              ? "Copied"
              : copyState === "failed"
                ? "Copy failed"
                : "Copy diagnostics"}
          </button>
          <button type="button" onClick={resetAuth}>
            <RotateCcw aria-hidden="true" />
            Anonymous
          </button>
        </div>
      </form>
    </details>
  );
}

function disposeCloudSyncRuntime(liveRuntime: CloudSyncRuntime): void {
  liveRuntime.engine.stop();
  liveRuntime.transport.disconnect();
  liveRuntime.handle.free();
}

function findCellElement(cellId: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>("[data-cell-id]")) {
    if (element.dataset.cellId === cellId) return element;
  }
  return null;
}

function CloudLiveNotebook({
  cells,
  priority,
  hostContext,
  showCode,
  getHandle,
  localActorLabel,
  textAttributionQueue,
  onMarkdownSourceChange,
  onMarkdownSyncNeeded,
  livePresence,
  onPresenceCursor,
  onPresenceSelection,
  resolveTracebackExecutionTarget,
  onNavigateToTracebackCell,
}: {
  cells: ResolvedCell[];
  priority: readonly string[];
  hostContext: NteractEmbedHostContextPatch;
  showCode: boolean;
  getHandle: () => CloudSyncRuntime["handle"] | null;
  localActorLabel: string | null;
  textAttributionQueue: CloudTextAttributionQueue;
  livePresence: CloudLivePresenceSnapshot;
  onMarkdownSourceChange: (cellId: string, source: string) => void;
  onMarkdownSyncNeeded: () => void;
  onPresenceCursor: (cellId: string, line: number, column: number) => void;
  onPresenceSelection: (
    cellId: string,
    anchorLine: number,
    anchorCol: number,
    headLine: number,
    headCol: number,
  ) => void;
  resolveTracebackExecutionTarget: (executionId: string) => TracebackCellTarget | null;
  onNavigateToTracebackCell: (target: TracebackCellTarget) => void;
}) {
  return (
    <section
      aria-label="Notebook cells"
      className="cloud-report-notebook flex min-h-0 flex-1 flex-col overflow-x-clip overscroll-x-contain"
      data-cell-count={cells.length}
      data-slot="cloud-live-notebook"
    >
      {cells.map((cell, index) => (
        <ErrorBoundary
          key={cell.id}
          resetKeys={[
            cell.id,
            cell.cellType,
            cell.source,
            cell.language,
            cell.executionCount,
            cell.outputs.length,
          ]}
          fallback={(error) => (
            <div className="cloud-state" data-kind="error">
              Unable to render cell {index + 1}: {error.message}
            </div>
          )}
        >
          {cell.cellType === "markdown" ? (
            <EditableMarkdownCell
              cell={cell}
              className="cloud-cell cloud-editable-markdown-cell"
              sourceClassName="cloud-source-block"
              priority={priority}
              hostContext={hostContext}
              onSourceChange={onMarkdownSourceChange}
              onSyncNeeded={onMarkdownSyncNeeded}
              getHandle={getHandle}
              localActorLabel={localActorLabel}
              textAttributionQueue={textAttributionQueue}
              remotePresence={presenceForCell(livePresence, cell.id)}
              onPresenceCursor={onPresenceCursor}
              onPresenceSelection={onPresenceSelection}
            />
          ) : (
            <ReadOnlyNotebookCell
              id={cell.id}
              cellType={cell.cellType}
              source={cell.source}
              language={cloudSourceLanguage(cell.language)}
              outputs={cell.outputs}
              executionCount={cell.executionCount}
              priority={priority}
              hostContext={hostContext}
              displayMode="report"
              showSource={cell.cellType !== "code" || showCode}
              className="cloud-cell"
              sourceClassName="cloud-source-block"
              outputClassName="cloud-output-block"
              deferIsolatedFrameUntilVisible
              deferredIsolatedFrameRootMargin="600px 0px"
              resolveTracebackExecutionTarget={resolveTracebackExecutionTarget}
              onNavigateToTracebackCell={onNavigateToTracebackCell}
            />
          )}
        </ErrorBoundary>
      ))}
    </section>
  );
}

function CloudPresenceStatus({
  presence,
  connectionScope,
}: {
  presence: CloudViewerPresenceState;
  connectionScope: string | null;
}) {
  const presenceDisplay = cloudViewerPresenceDisplay(presence);
  const scopeLabel =
    connectionScope === "editor" || connectionScope === "owner"
      ? "editing"
      : connectionScope === "viewer"
        ? "viewing"
        : null;

  return (
    <div
      className="cloud-presence"
      data-connected={String(presenceDisplay.connected)}
      title={scopeLabel ? `${presenceDisplay.title}; ${scopeLabel}` : presenceDisplay.title}
      aria-label={presenceDisplay.title}
      aria-live="polite"
    >
      <UsersRound aria-hidden="true" />
      <span>{scopeLabel ? `${presenceDisplay.label} · ${scopeLabel}` : presenceDisplay.label}</span>
    </div>
  );
}

function presenceForCell(
  livePresence: CloudLivePresenceSnapshot,
  cellId: string,
): RemoteCellPresence {
  return livePresence.cells.get(cellId) ?? EMPTY_REMOTE_CELL_PRESENCE;
}

const EMPTY_REMOTE_CELL_PRESENCE: RemoteCellPresence = {
  cursors: [],
  selections: [],
};

function canEditLiveNotebook(connectionScope: string | null): boolean {
  return connectionScope === "editor" || connectionScope === "owner";
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

function languageFromNotebookMetadata(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const languageInfo = (metadata as Record<string, unknown>).language_info;
  if (typeof languageInfo !== "object" || languageInfo === null) return null;
  const name = (languageInfo as Record<string, unknown>).name;
  return typeof name === "string" ? name : null;
}

function parseJsonOrNull(value: string | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
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
