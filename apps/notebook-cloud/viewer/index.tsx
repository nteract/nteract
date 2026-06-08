import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { NotebookHostProvider } from "@nteract/notebook-host";
import {
  AlertCircle,
  BookOpen,
  Check,
  Clock,
  ExternalLink,
  FilePlus2,
  Globe2,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  PencilLine,
  Radio,
  RotateCcw,
  Share2,
  UserRound,
  X,
  Zap,
} from "lucide-react";
import { IsolatedRendererProvider } from "@/components/isolated/isolated-renderer-context";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import { NotebookNotice } from "@/components/notebook/NotebookNotice";
import type { NotebookRailPanelId } from "@/components/notebook-rail";
import {
  NotebookDocumentToolbar,
  NotebookEditModeButton,
  navigateNotebookOutlineItem,
  notebookWorkstationsSummary,
  NotebookDocumentRail,
  NotebookDocumentShell,
  NotebookPackageSummaryPanel,
  NotebookWorkstationsPanel,
  projectNotebookCommandRuntimeStatusFromRuntimeState,
  projectNotebookWorkstationLaunchReadiness,
  projectNotebookWorkstationSelection,
  shouldShowNotebookDocumentCommandToolbar,
  type NotebookCommandToolbarStatus,
  type NotebookEnvironmentManager,
  type NotebookInteractionMode,
  type NotebookInteractionModeProjection,
  type NotebookPackageSection,
  type NotebookShellCapabilities,
  useNotebookCellUIStateBridge,
  useNotebookViewModel,
} from "@/components/notebook";
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar";
import { MediaProvider } from "@/components/outputs/media-provider";
import { useWidgetStoreRequired } from "@/components/widgets/widget-store-context";
import { useTheme } from "@/hooks/useTheme";
import { ErrorBoundary } from "@/lib/error-boundary";
import { EnvironmentSummary } from "@/components/environment";
import { NotebookClient, type NotebookOutlineItem } from "runtimed";
import { createNotebookCloudBlobResolver } from "../src/blob-resolver";
import {
  clearCloudPrototypeDevAuth,
  cloudNotebookSignInCopy,
  cloudPrototypeAuthFromWindow,
  fetchWithCloudPrototypeAuth,
  cloudSyncAuthFromAppSessionTicket,
  cloudSyncAuthFromPrototypeAuthState,
  isCloudPrototypeAuthStorageKey,
  prepareCloudOidcViewerLogin,
  storeCloudRequestedScope,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";
import { createCloudNotebookCellId } from "./cloud-cell-id";
import { useCloudViewerSession, type CloudViewerConfig } from "./cloud-viewer-session";
import { projectCloudNotebookEditAccess } from "./edit-access";
import { cloudNotebookShellCapabilities } from "./shell-capabilities";
import {
  CrdtBridgeProvider,
  createNotebookController,
  NotebookView,
  PresenceValueProvider,
  getCellById,
  setLoggerHost,
  setOpenUrlHost,
  useRuntimeState,
  type PresenceContextValue,
} from "../../notebook/src/notebook-surface";
import {
  beginOidcLogin,
  completeOidcRedirect,
  normalizeOidcAuthConfig,
  refreshStoredOidcToken,
  storedOidcTokenNeedsRefresh,
  type CloudOidcAuthConfig,
} from "./oidc-auth";
import { cloudViewerLoadingPolicy } from "./loading-policy";
import { markCloudViewerLoadMilestone } from "./load-milestones";
import { CLOUD_VIEWER_PRIORITY } from "./mime-policy";
import {
  cloudWorkstationRefreshIntervalMs,
  fetchCloudWorkstations,
  requestCloudWorkstationAttachment,
  setCloudDefaultWorkstation,
  type CloudWorkstationsState,
} from "./workstations-client";
import {
  cloudPresenceHasRuntimePeer,
  cloudPresenceRuntimePeerCount,
  type CloudViewerPresencePeer,
  type CloudViewerPresenceStore,
  cloudViewerPresenceDisplay,
} from "./presence";
import type { ResolvedCell } from "./render-resolution";
import { CloudNotebookNotices, cloudNotebookHasNotices } from "./notices";
import type { CloudAuthRenewalState, ViewerStatus } from "./notice-types";
import { rendererAssetBasePathForProvider } from "./renderer-assets";
import {
  cloudNotebookDisplayTitle,
  cloudNotebookShortId,
  isCloudNotebookListItem,
  projectCloudNotebookDashboard,
  type CloudNotebookDashboardMetric,
  type CloudNotebookDashboardModel,
  type CloudNotebookDashboardSection,
  type CloudNotebookListItem,
} from "./notebook-dashboard";
import {
  clearCachedCloudNotebookList,
  readCachedCloudNotebookList,
  writeCachedCloudNotebookList,
} from "./notebook-list-cache";
import type { CloudNotebookAccessRequest } from "./sharing-client";
import { CloudSharingControls } from "./sharing-controls";
import { createCloudNotebookHost } from "./cloud-notebook-host";
import { cloudResponseError } from "./cloud-response";
import { preloadSiftWasmForCells } from "./sift-preload";
import { cloudSourceLanguage } from "./source-language";
import { loadSupplementalViewerCss } from "./supplemental-css";
import {
  clearCloudAppSession,
  cloudAppSessionIsFresh,
  establishCloudAppSession,
  establishCloudAppSessionFromOidcToken,
  isCloudAppSession,
  readCloudAppSessionStatus,
  type CloudAppSession,
} from "./app-session";
import { cloudOidcRenewalFailureMessage } from "./auth-renewal-copy";
import {
  applyDocumentTheme,
  CLOUD_VIEWER_THEME_STORAGE_KEY,
  installDocumentThemeSync,
} from "./theme";
import { CLOUD_WIDGET_RENDERERS, CloudWidgetStoreProvider } from "./widget-runtime";
import "./index.css";

const CLOUD_VIEWER_OUTPUT_IFRAME_ROOT_MARGIN = "400px 0px";
const CLOUD_ACCESS_REQUEST_POLL_INTERVAL_MS = 10_000;
const CLOUD_EMPTY_ROOM_GRACE_MS = 900;

setLoggerHost({
  debug: () => {},
  info: () => {},
  warn: (message: string, ...args: unknown[]) => console.warn(message, ...args),
  error: (message: string, ...args: unknown[]) => console.error(message, ...args),
});

setOpenUrlHost({
  externalLinks: {
    async open(url: string): Promise<void> {
      window.open(url, "_blank", "noopener,noreferrer");
    },
  },
});

interface CloudViewerAuthConfig {
  oidc: CloudOidcAuthConfig | null;
}

interface ViewerRuntime {
  config: CloudViewerConfig;
}

interface CloudNotebookListResponse {
  ok: boolean;
  notebooks: CloudNotebookListItem[];
}

interface CloudNotebookListBootstrap {
  kind: "notebook-list";
  notebooks: CloudNotebookListItem[];
  saved_at: string;
  session?: CloudAppSession | null;
}

interface CloudNotebookCreateResponse {
  ok: boolean;
  title?: string | null;
  viewer_url?: string;
}

interface CloudNotebookUpdateResponse {
  ok: boolean;
  notebook_id?: string;
  title?: string | null;
  updated_at?: string;
  viewer_url?: string;
}

type CloudNotebookListState =
  | { kind: "loading" }
  | { kind: "ready"; notebooks: CloudNotebookListItem[] }
  | { kind: "signed_out" }
  | { kind: "error"; message: string };

interface CloudNotebookRenameState {
  notebookId: string;
  title: string;
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
    !parsed.commsSnapshotBasePath ||
    !parsed.aclEndpoint ||
    !parsed.invitesEndpoint ||
    !parsed.accessRequestsEndpoint ||
    !parsed.workstationsEndpoint ||
    !parsed.workstationDefaultEndpoint ||
    !parsed.workstationAttachEndpoint ||
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
    commsSnapshotBasePath: parsed.commsSnapshotBasePath,
    aclEndpoint: parsed.aclEndpoint,
    invitesEndpoint: parsed.invitesEndpoint,
    accessRequestsEndpoint: parsed.accessRequestsEndpoint,
    workstationsEndpoint: parsed.workstationsEndpoint,
    workstationDefaultEndpoint: parsed.workstationDefaultEndpoint,
    workstationAttachEndpoint: parsed.workstationAttachEndpoint,
    hostCapabilities: {
      canManageSharing: Boolean(parsed.hostCapabilities?.canManageSharing),
      canSubmitExecutionRequests: Boolean(parsed.hostCapabilities?.canSubmitExecutionRequests),
    },
    session: isCloudAppSession(parsed.session) ? parsed.session : null,
    syncEndpoint: parsed.syncEndpoint,
    syncTicketEndpoint: parsed.syncTicketEndpoint,
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

function loadCloudNotebookListBootstrap(): CloudNotebookListBootstrap | null {
  const element = document.querySelector<HTMLScriptElement>("#nteract-cloud-bootstrap");
  if (!element) {
    return null;
  }
  try {
    const parsed = JSON.parse(element.textContent ?? "{}") as unknown;
    if (isCloudNotebookListBootstrap(parsed)) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function isOidcCallbackPath(): boolean {
  return window.location.pathname.replace(/\/+$/, "") === "/oidc";
}

function isHomePath(): boolean {
  const pathname = window.location.pathname.replace(/\/+$/, "");
  return pathname === "" || pathname === "/index.html";
}

function isNotebookListPath(): boolean {
  return window.location.pathname.replace(/\/+$/, "") === "/n";
}

interface CloudPrototypeAuthOptions {
  appSessionRefreshFallback?: boolean;
  appSessionLoading?: boolean;
  appSession?: CloudAppSession | null;
}

interface CloudAppSessionViewState {
  status: "loading" | "ready" | "error";
  session: CloudAppSession | null;
  error: string | null;
}

function useCloudPrototypeAuth(
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
  const appSessionRefreshFallbackRef = useRef<number | null>(null);
  const appSessionRefreshFallback = options?.appSessionRefreshFallback === true;
  const refreshAuthState = useCallback(() => {
    setAuthState(cloudPrototypeAuthFromWindow());
    if (!shouldRefreshStoredOidcToken() || cloudAppSessionIsFresh(appSession)) {
      appSessionRefreshFallbackRef.current = appSession?.expires_at ?? null;
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
      const appSessionExpiresAt = appSession?.expires_at ?? null;
      if (appSessionExpiresAt && cloudAppSessionIsFresh(appSession)) {
        appSessionRefreshFallbackRef.current = appSessionExpiresAt;
        setAuthRenewal({ kind: "idle", message: null });
        return;
      }
      const fallbackExpiresAt = appSessionRefreshFallbackRef.current;
      if (fallbackExpiresAt && fallbackExpiresAt > currentEpochSeconds() + 60) {
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
        appSessionRefreshFallbackRef.current = null;
        refreshAuthState();
        setAuthRenewal({ kind: "idle", message: null });
      } catch (error) {
        if (appSessionRefreshFallback) {
          const appSession = await readCloudAppSessionStatus().catch(() => null);
          const appSessionExpiresAt = appSession?.session?.expires_at ?? null;
          if (cloudAppSessionIsFresh(appSession?.session)) {
            appSessionRefreshFallbackRef.current = appSessionExpiresAt;
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
      appSessionRefreshFallbackRef.current = null;
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

function useCloudAppSessionStatus(
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
    const controller = new AbortController();
    if (!state.session) {
      setState((current) =>
        current.status === "loading" ? current : { ...current, status: "loading", error: null },
      );
    }
    void readCloudAppSessionStatus({ signal: controller.signal })
      .then((status) => {
        if (controller.signal.aborted) return;
        setState({ status: "ready", session: status.session, error: null });
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
  }, [refreshIndex]);

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

function useCloudAppSessionBridge(
  authState: CloudPrototypeAuthState,
  onEstablished?: () => void,
): void {
  const establishedTokenRef = useRef<string | null>(null);
  useEffect(() => {
    if (authState.mode !== "oidc" || !authState.token) {
      establishedTokenRef.current = null;
      return;
    }
    if (establishedTokenRef.current === authState.token) {
      return;
    }
    establishedTokenRef.current = authState.token;
    void establishCloudAppSession(authState)
      .then(() => {
        onEstablished?.();
      })
      .catch((error: unknown) => {
        establishedTokenRef.current = null;
        console.warn("[notebook-cloud] app session exchange failed", error);
      });
  }, [authState, onEstablished]);
}

function App() {
  const [authConfig] = useState<CloudViewerAuthConfig>(() => loadAuthConfig());
  const [runtimeState] = useState<ViewerRuntimeState | null>(() =>
    isOidcCallbackPath() || isHomePath() || isNotebookListPath() ? null : loadViewerRuntime(),
  );

  if (isHomePath()) {
    return <CloudHomeView authConfig={authConfig} />;
  }

  if (isNotebookListPath()) {
    return <CloudNotebookListView authConfig={authConfig} />;
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

function CloudNotebookListView({ authConfig }: { authConfig: CloudViewerAuthConfig }) {
  const { resolvedTheme } = useTheme(CLOUD_VIEWER_THEME_STORAGE_KEY);
  const [bootstrap, setBootstrap] = useState<CloudNotebookListBootstrap | null>(() =>
    loadCloudNotebookListBootstrap(),
  );
  const appSessionStatus = useCloudAppSessionStatus(bootstrap?.session ?? null);
  const { authState, authRenewal, refreshAuthState } = useCloudPrototypeAuth(authConfig, {
    appSessionRefreshFallback: true,
    appSessionLoading: appSessionStatus.status === "loading",
    appSession: appSessionStatus.session,
  });
  useCloudAppSessionBridge(authState, appSessionStatus.refreshAppSessionStatus);
  const [listState, setListState] = useState<CloudNotebookListState>(() =>
    initialCloudNotebookListState(authState, bootstrap),
  );
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [createState, setCreateState] = useState<"idle" | "starting">("idle");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createFormOpen, setCreateFormOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState(() => defaultCloudNotebookTitle());
  const [renameState, setRenameState] = useState<CloudNotebookRenameState | null>(null);
  const [renameSavingId, setRenameSavingId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const hasExplicitAuth = authState.mode === "dev" || authState.mode === "oidc";
  const hasAppSession = Boolean(appSessionStatus.session);
  const signedIn = hasExplicitAuth || hasAppSession;
  const dashboardModel = useMemo(
    () => (listState.kind === "ready" ? projectCloudNotebookDashboard(listState.notebooks) : null),
    [listState],
  );

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    if (!signedIn) {
      clearCachedCloudNotebookListFromWindow();
      setListState({ kind: "signed_out" });
      return;
    }

    const controller = new AbortController();
    const cachedNotebooks =
      readCachedCloudNotebookListFromWindow(authState) ?? bootstrap?.notebooks ?? null;
    setListState(
      cachedNotebooks ? { kind: "ready", notebooks: cachedNotebooks } : { kind: "loading" },
    );
    void (async () => {
      try {
        const response = await fetchCloudNotebookList(authState, controller.signal);
        if (controller.signal.aborted) return;
        if (!response.ok) {
          throw await cloudResponseError(response, "Unable to list notebooks");
        }
        const body = (await response.json()) as unknown;
        if (!isCloudNotebookListResponse(body)) {
          throw new Error("Unable to list notebooks: response shape was invalid");
        }
        writeCachedCloudNotebookListToWindow(authState, body.notebooks);
        setListState({ kind: "ready", notebooks: body.notebooks });
      } catch (error) {
        if (controller.signal.aborted) return;
        setListState({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      controller.abort();
    };
  }, [authState, bootstrap, hasAppSession, refreshIndex, signedIn]);

  const refreshList = () => {
    setRefreshIndex((value) => value + 1);
  };

  const openCreateForm = () => {
    if (!signedIn) {
      return;
    }
    setCreateError(null);
    setCreateTitle(defaultCloudNotebookTitle());
    setCreateFormOpen(true);
  };

  const closeCreateForm = () => {
    if (createState === "starting") {
      return;
    }
    setCreateError(null);
    setCreateFormOpen(false);
  };

  const createNotebook = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!signedIn || createState === "starting") {
      return;
    }
    const title = createTitle.trim() || defaultCloudNotebookTitle();
    try {
      setCreateError(null);
      setCreateState("starting");
      const response = await fetchWithCloudPrototypeAuth(
        cloudNotebookCollectionEndpoint(),
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title }),
        },
        cloudAuthWithScope(authState, "owner"),
      );
      if (!response.ok) {
        throw await cloudResponseError(response, "Unable to create notebook");
      }
      const body = (await response.json()) as CloudNotebookCreateResponse;
      if (body.ok !== true || typeof body.viewer_url !== "string") {
        throw new Error("Unable to create notebook: response shape was invalid");
      }
      window.location.assign(body.viewer_url);
    } catch (error) {
      setCreateState("idle");
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  };

  const openRenameForm = useCallback((notebook: CloudNotebookListItem) => {
    setRenameError(null);
    setRenameState({
      notebookId: notebook.notebook_id,
      title: notebook.title?.trim() ?? "",
    });
  }, []);

  const closeRenameForm = useCallback(() => {
    if (renameSavingId) {
      return;
    }
    setRenameError(null);
    setRenameState(null);
  }, [renameSavingId]);

  const saveNotebookTitle = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!signedIn || !renameState || renameSavingId) {
      return;
    }

    const notebookId = renameState.notebookId;
    const nextTitle = renameState.title.trim();
    try {
      setRenameError(null);
      setRenameSavingId(notebookId);
      const response = await fetchWithCloudPrototypeAuth(
        cloudNotebookCatalogEndpoint(notebookId),
        {
          method: "PATCH",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title: nextTitle || null }),
        },
        cloudAuthWithScope(authState, "editor"),
      );
      if (!response.ok) {
        throw await cloudResponseError(response, "Unable to rename notebook");
      }
      const body = (await response.json()) as CloudNotebookUpdateResponse;
      if (body.ok !== true || body.notebook_id !== notebookId) {
        throw new Error("Unable to rename notebook: response shape was invalid");
      }
      setListState((current) => {
        if (current.kind !== "ready") {
          return current;
        }
        const notebooks = current.notebooks.map((notebook) =>
          notebook.notebook_id === notebookId
            ? {
                ...notebook,
                title: body.title ?? null,
                updated_at: body.updated_at ?? notebook.updated_at,
                viewer_url: body.viewer_url ?? notebook.viewer_url,
              }
            : notebook,
        );
        writeCachedCloudNotebookListToWindow(authState, notebooks);
        return {
          kind: "ready",
          notebooks,
        };
      });
      setRenameState(null);
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error));
    } finally {
      setRenameSavingId(null);
    }
  };

  const signOut = () => {
    setBootstrap(null);
    appSessionStatus.clearAppSessionStatus();
    clearCachedCloudNotebookListFromWindow();
    void clearCloudAppSession()
      .catch((error: unknown) => {
        console.warn("[notebook-cloud] app session clear failed", error);
      })
      .finally(appSessionStatus.refreshAppSessionStatus);
    clearCloudPrototypeDevAuth(window.localStorage);
    refreshAuthState();
  };

  const headerDetail =
    authState.mode === "oidc" || authState.mode === "dev"
      ? "Signed in"
      : hasAppSession
        ? "Signed in"
        : authState.mode === "oidc_expired"
          ? "Session expired"
          : "Signed out";

  return (
    <main className="cloud-notebook-list-page">
      <header className="cloud-notebook-list-header">
        <div>
          <a className="cloud-notebook-list-brand" href="/">
            nteract
          </a>
          <h1>Notebook home</h1>
          <p>{headerDetail}</p>
        </div>
        <div className="cloud-notebook-list-actions">
          <button
            type="button"
            disabled={!signedIn || listState.kind === "loading"}
            onClick={refreshList}
          >
            <RotateCcw aria-hidden="true" />
            Refresh
          </button>
          <button
            type="button"
            disabled={!signedIn || createState === "starting"}
            onClick={openCreateForm}
          >
            {createState === "starting" ? (
              <Loader2 className="cloud-home-status-spinner" aria-hidden="true" />
            ) : (
              <FilePlus2 aria-hidden="true" />
            )}
            {createState === "starting" ? "Creating" : "New notebook"}
          </button>
          {hasExplicitAuth || hasAppSession ? null : (
            <CloudNotebookSignInButton authConfig={authConfig} authState={authState} />
          )}
          {signedIn ? (
            <button type="button" onClick={signOut}>
              <LogOut aria-hidden="true" />
              Sign out
            </button>
          ) : null}
        </div>
      </header>

      {authRenewal.kind !== "idle" ? (
        <div
          className="cloud-notebook-list-banner"
          data-kind={authRenewal.kind === "failed" ? "error" : "info"}
          role={authRenewal.kind === "failed" ? "alert" : "status"}
        >
          {authRenewal.message}
        </div>
      ) : null}
      {createError ? (
        <div className="cloud-notebook-list-banner" data-kind="error" role="alert">
          {createError}
        </div>
      ) : null}
      {renameError ? (
        <div className="cloud-notebook-list-banner" data-kind="error" role="alert">
          {renameError}
        </div>
      ) : null}
      {createFormOpen ? (
        <form className="cloud-new-notebook-form" onSubmit={createNotebook}>
          <label htmlFor="cloud-new-notebook-title">Notebook title</label>
          <input
            id="cloud-new-notebook-title"
            type="text"
            value={createTitle}
            maxLength={160}
            disabled={createState === "starting"}
            onChange={(event) => setCreateTitle(event.currentTarget.value)}
          />
          <button type="submit" disabled={createState === "starting"}>
            {createState === "starting" ? (
              <Loader2 className="cloud-home-status-spinner" aria-hidden="true" />
            ) : (
              <FilePlus2 aria-hidden="true" />
            )}
            Create
          </button>
          <button type="button" disabled={createState === "starting"} onClick={closeCreateForm}>
            Cancel
          </button>
        </form>
      ) : null}

      <section className="cloud-notebook-list-content" aria-label="Notebook list">
        {listState.kind === "loading" ? (
          <div className="cloud-notebook-list-state" data-kind="loading" role="status">
            <Loader2 className="cloud-home-status-spinner" aria-hidden="true" />
            <span>Loading notebooks</span>
          </div>
        ) : listState.kind === "signed_out" ? (
          <div className="cloud-notebook-list-state" data-kind="signed-out">
            <KeyRound aria-hidden="true" />
            <span>Sign in to view notebooks.</span>
          </div>
        ) : listState.kind === "error" ? (
          <div className="cloud-notebook-list-state" data-kind="error" role="alert">
            <AlertCircle aria-hidden="true" />
            <span>{listState.message}</span>
          </div>
        ) : listState.notebooks.length === 0 ? (
          <div className="cloud-notebook-list-state" data-kind="empty">
            <BookOpen aria-hidden="true" />
            <span>No notebooks yet.</span>
          </div>
        ) : dashboardModel ? (
          <CloudNotebookDashboard
            model={dashboardModel}
            canRename={signedIn}
            renameState={renameState}
            renameSavingId={renameSavingId}
            onOpenRename={openRenameForm}
            onCancelRename={closeRenameForm}
            onRenameTitleChange={(title) =>
              setRenameState((current) => (current ? { ...current, title } : current))
            }
            onSaveRename={saveNotebookTitle}
          />
        ) : (
          <div className="cloud-notebook-list-state" data-kind="error" role="alert">
            <AlertCircle aria-hidden="true" />
            <span>Unable to project notebook dashboard.</span>
          </div>
        )}
      </section>
    </main>
  );
}

function CloudNotebookDashboard({
  model,
  canRename,
  renameState,
  renameSavingId,
  onOpenRename,
  onCancelRename,
  onRenameTitleChange,
  onSaveRename,
}: {
  model: CloudNotebookDashboardModel;
  canRename: boolean;
  renameState: CloudNotebookRenameState | null;
  renameSavingId: string | null;
  onOpenRename: (notebook: CloudNotebookListItem) => void;
  onCancelRename: () => void;
  onRenameTitleChange: (title: string) => void;
  onSaveRename: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const continued = model.continueNotebook;

  return (
    <div className="cloud-dashboard">
      {continued ? (
        <section className="cloud-dashboard-continue" aria-labelledby="cloud-dashboard-continue">
          <div className="cloud-dashboard-continue-main">
            <p>Continue</p>
            <h2 id="cloud-dashboard-continue">{cloudNotebookDisplayTitle(continued)}</h2>
            <div className="cloud-dashboard-continue-facts">
              <span>
                <Clock aria-hidden="true" />
                {formatNotebookUpdatedAt(continued.updated_at)}
              </span>
              <span>
                <UserRound aria-hidden="true" />
                {formatNotebookScope(continued.scope)}
              </span>
              <span>
                {continued.latest_revision_id ? (
                  <Globe2 aria-hidden="true" />
                ) : (
                  <Radio aria-hidden="true" />
                )}
                {continued.latest_revision_id ? "published revision" : "not published"}
              </span>
            </div>
          </div>
          <a className="cloud-dashboard-primary-link" href={continued.viewer_url}>
            Open
            <ExternalLink aria-hidden="true" />
          </a>
        </section>
      ) : null}

      <section className="cloud-dashboard-summary" aria-label="Notebook summary">
        {model.metrics.map((metric) => (
          <CloudNotebookDashboardMetric key={metric.label} metric={metric} />
        ))}
      </section>

      <section className="cloud-dashboard-grid">
        <section className="cloud-dashboard-notebooks" aria-label="Notebook rooms">
          {model.sections.map((section) => (
            <CloudNotebookDashboardSectionView
              key={section.id}
              section={section}
              canRename={canRename}
              renameState={renameState}
              renameSavingId={renameSavingId}
              onOpenRename={onOpenRename}
              onCancelRename={onCancelRename}
              onRenameTitleChange={onRenameTitleChange}
              onSaveRename={onSaveRename}
            />
          ))}
        </section>
        <aside className="cloud-dashboard-aside" aria-label="Notebook workspace">
          <section>
            <p className="cloud-dashboard-aside-kicker">Compute</p>
            <h2>Workstations</h2>
            <p>
              Workstation status appears inside each notebook room once a compute target is
              selected.
            </p>
          </section>
          <section>
            <p className="cloud-dashboard-aside-kicker">Sharing</p>
            <h2>Public previews</h2>
            <p>Published notebooks can expose safe metadata and revision-aware preview images.</p>
          </section>
        </aside>
      </section>
    </div>
  );
}

function CloudNotebookDashboardSectionView({
  section,
  canRename,
  renameState,
  renameSavingId,
  onOpenRename,
  onCancelRename,
  onRenameTitleChange,
  onSaveRename,
}: {
  section: CloudNotebookDashboardSection;
  canRename: boolean;
  renameState: CloudNotebookRenameState | null;
  renameSavingId: string | null;
  onOpenRename: (notebook: CloudNotebookListItem) => void;
  onCancelRename: () => void;
  onRenameTitleChange: (title: string) => void;
  onSaveRename: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const action = canRename ? section.action : null;

  return (
    <section className="cloud-dashboard-notebook-section" data-section={section.id}>
      <div className="cloud-dashboard-section-heading">
        <div>
          <h2>{section.title}</h2>
          <p>{section.detail}</p>
        </div>
        {action?.kind === "rename" ? (
          <button
            type="button"
            className="cloud-dashboard-section-action"
            onClick={() => onOpenRename(action.notebook)}
          >
            <PencilLine aria-hidden="true" />
            {action.label}
          </button>
        ) : null}
      </div>
      <ul className="cloud-notebook-list">
        {section.notebooks.map((notebook) => (
          <li key={notebook.notebook_id}>
            <CloudNotebookDashboardRow
              notebook={notebook}
              canRename={canRename}
              renameTitle={
                renameState?.notebookId === notebook.notebook_id ? renameState.title : null
              }
              renameSaving={renameSavingId === notebook.notebook_id}
              onOpenRename={onOpenRename}
              onCancelRename={onCancelRename}
              onRenameTitleChange={onRenameTitleChange}
              onSaveRename={onSaveRename}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function CloudNotebookDashboardMetric({ metric }: { metric: CloudNotebookDashboardMetric }) {
  const Icon = cloudNotebookDashboardMetricIcons[metric.icon];
  return (
    <div className="cloud-dashboard-summary-item">
      <span>
        <Icon aria-hidden="true" />
        {metric.label}
      </span>
      <strong>{metric.value}</strong>
      <p>{metric.detail}</p>
    </div>
  );
}

const cloudNotebookDashboardMetricIcons = {
  notebooks: BookOpen,
  owned: UserRound,
  published: Zap,
} satisfies Record<CloudNotebookDashboardMetric["icon"], typeof BookOpen>;

function CloudNotebookDashboardRow({
  notebook,
  canRename,
  renameTitle,
  renameSaving,
  onOpenRename,
  onCancelRename,
  onRenameTitleChange,
  onSaveRename,
}: {
  notebook: CloudNotebookListItem;
  canRename: boolean;
  renameTitle: string | null;
  renameSaving: boolean;
  onOpenRename: (notebook: CloudNotebookListItem) => void;
  onCancelRename: () => void;
  onRenameTitleChange: (title: string) => void;
  onSaveRename: (event: FormEvent<HTMLFormElement>) => void;
}) {
  if (renameTitle !== null) {
    return (
      <form className="cloud-notebook-list-rename-form" onSubmit={onSaveRename}>
        <input
          aria-label={`Notebook title for ${cloudNotebookShortId(notebook.notebook_id)}`}
          type="text"
          value={renameTitle}
          maxLength={160}
          placeholder="Untitled notebook"
          disabled={renameSaving}
          onChange={(event) => onRenameTitleChange(event.currentTarget.value)}
        />
        <button type="submit" disabled={renameSaving} title="Save title" aria-label="Save title">
          {renameSaving ? (
            <Loader2 className="cloud-home-status-spinner" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          disabled={renameSaving}
          title="Cancel rename"
          aria-label="Cancel rename"
          onClick={onCancelRename}
        >
          <X aria-hidden="true" />
        </button>
      </form>
    );
  }

  const hasTitle = Boolean(notebook.title?.trim());

  return (
    <div className="cloud-notebook-list-row">
      <a className="cloud-notebook-list-main" href={notebook.viewer_url}>
        <span className="cloud-notebook-list-title">{cloudNotebookDisplayTitle(notebook)}</span>
        {hasTitle ? null : (
          <span className="cloud-notebook-list-detail">
            Created {formatNotebookUpdatedAt(notebook.created_at)}
          </span>
        )}
        <span className="cloud-notebook-list-row-facts">
          <span>
            <UserRound aria-hidden="true" />
            {formatNotebookScope(notebook.scope)}
          </span>
          <span data-state={notebook.latest_revision_id ? "published" : "unpublished"}>
            {notebook.latest_revision_id ? (
              <Share2 aria-hidden="true" />
            ) : (
              <Radio aria-hidden="true" />
            )}
            {notebook.latest_revision_id ? "published revision" : "not published"}
          </span>
        </span>
      </a>
      <span className="cloud-notebook-list-updated">
        <Clock aria-hidden="true" />
        {formatNotebookUpdatedAt(notebook.updated_at)}
      </span>
      <span className="cloud-notebook-list-row-actions">
        {canRename && canRenameCloudNotebook(notebook) ? (
          <button
            type="button"
            className="cloud-notebook-list-icon-button"
            title="Rename notebook"
            aria-label={`Rename ${cloudNotebookDisplayTitle(notebook)}`}
            onClick={() => onOpenRename(notebook)}
          >
            <PencilLine aria-hidden="true" />
          </button>
        ) : null}
        <a
          className="cloud-notebook-list-icon-button"
          href={notebook.viewer_url}
          title="Open notebook"
          aria-label={`Open ${cloudNotebookDisplayTitle(notebook)}`}
        >
          <ExternalLink aria-hidden="true" />
        </a>
      </span>
    </div>
  );
}

function cloudNotebookListEndpoint(): string {
  return new URL("api/n?limit=100", `${window.location.origin}/`).href;
}

function cloudNotebookCollectionEndpoint(): string {
  return new URL("api/n", `${window.location.origin}/`).href;
}

function cloudNotebookCatalogEndpoint(notebookId: string): string {
  return new URL(`api/n/${encodeURIComponent(notebookId)}`, `${window.location.origin}/`).href;
}

function cloudAuthWithScope(
  authState: CloudPrototypeAuthState,
  requestedScope: NonNullable<CloudPrototypeAuthState["requestedScope"]>,
): CloudPrototypeAuthState {
  return authState.requestedScope === requestedScope
    ? authState
    : {
        ...authState,
        requestedScope,
      };
}

function initialCloudNotebookListState(
  authState: CloudPrototypeAuthState,
  bootstrap: CloudNotebookListBootstrap | null,
): CloudNotebookListState {
  const cachedNotebooks = readCachedCloudNotebookListFromWindow(authState) ?? bootstrap?.notebooks;
  return cachedNotebooks ? { kind: "ready", notebooks: cachedNotebooks } : { kind: "loading" };
}

function fetchCloudNotebookList(
  authState: CloudPrototypeAuthState,
  signal: AbortSignal,
): Promise<Response> {
  if (authState.mode === "dev" || authState.mode === "oidc") {
    return fetchWithCloudPrototypeAuth(
      cloudNotebookListEndpoint(),
      { headers: { Accept: "application/json" }, signal },
      authState,
    );
  }
  return fetch(cloudNotebookListEndpoint(), {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  });
}

function readCachedCloudNotebookListFromWindow(
  authState: CloudPrototypeAuthState,
): CloudNotebookListItem[] | null {
  const storage = cloudNotebookListCacheStorage();
  return storage ? readCachedCloudNotebookList(storage, authState) : null;
}

function writeCachedCloudNotebookListToWindow(
  authState: CloudPrototypeAuthState,
  notebooks: CloudNotebookListItem[],
): void {
  const storage = cloudNotebookListCacheStorage();
  if (!storage) {
    return;
  }
  writeCachedCloudNotebookList(storage, authState, notebooks);
}

function clearCachedCloudNotebookListFromWindow(): void {
  const storage = cloudNotebookListCacheStorage();
  if (!storage) {
    return;
  }
  clearCachedCloudNotebookList(storage);
}

function cloudNotebookListCacheStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function defaultCloudNotebookTitle(now = new Date()): string {
  const date = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(now);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(now);
  return `Notebook ${date} ${time}`;
}

function isCloudNotebookListResponse(value: unknown): value is CloudNotebookListResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return candidate.ok === true && Array.isArray(candidate.notebooks);
}

function isCloudNotebookListBootstrap(value: unknown): value is CloudNotebookListBootstrap {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CloudNotebookListBootstrap>;
  return (
    candidate.kind === "notebook-list" &&
    typeof candidate.saved_at === "string" &&
    Array.isArray(candidate.notebooks) &&
    candidate.notebooks.every(isCloudNotebookListItem) &&
    (candidate.session === undefined ||
      candidate.session === null ||
      isCloudAppSession(candidate.session))
  );
}

function canRenameCloudNotebook(notebook: CloudNotebookListItem): boolean {
  return notebook.scope === "owner" || notebook.scope === "editor";
}

function formatNotebookScope(scope: CloudNotebookListItem["scope"]): string {
  switch (scope) {
    case "owner":
      return "owner";
    case "editor":
      return "editor";
    case "runtime_peer":
      return "runtime";
    case "viewer":
      return "viewer";
  }
}

function formatNotebookUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function CloudHomeView({ authConfig }: { authConfig: CloudViewerAuthConfig }) {
  const { resolvedTheme } = useTheme(CLOUD_VIEWER_THEME_STORAGE_KEY);
  const appSessionStatus = useCloudAppSessionStatus(null);
  const { authState, authRenewal, refreshAuthState } = useCloudPrototypeAuth(authConfig, {
    appSessionRefreshFallback: true,
    appSessionLoading: appSessionStatus.status === "loading",
    appSession: appSessionStatus.session,
  });
  useCloudAppSessionBridge(authState, appSessionStatus.refreshAppSessionStatus);
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
  const hasAppSession = Boolean(appSessionStatus.session);
  const signedIn = hasExplicitAuth || hasAppSession;
  const homeStatusMode = signedIn ? "oidc" : authState.mode;
  const homeStatusTitle = hasExplicitAuth
    ? (authState.user ?? "Signed in")
    : hasAppSession
      ? "Signed in"
      : "Open a notebook";
  const homeStatusDescription = signedIn
    ? hasExplicitAuth
      ? "Open a notebook or sign out of this browser session."
      : "Open and manage notebooks with this browser session."
    : "Sign in to open private notebooks or request edit access.";

  return (
    <main className="cloud-home">
      <section className="cloud-home-layout" aria-label="nteract notebook entry">
        <div className="cloud-home-copy">
          <h1>nteract</h1>
          <span>realtime notebooks</span>
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
            <a href="/n">View notebooks</a>
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
            {hasExplicitAuth ? null : (
              <button
                type="button"
                disabled={authAction === "starting" || !oidcConfigured}
                onClick={beginOidcAuth}
              >
                <LogIn aria-hidden="true" />
                {authAction === "starting"
                  ? "Starting sign-in"
                  : !oidcConfigured
                    ? "Sign-in unavailable"
                    : hasAppSession
                      ? "Renew sign-in"
                      : "Sign in with Anaconda"}
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
      .then(async ({ returnUrl, token }) => {
        if (cancelled) return;
        await establishCloudAppSessionFromOidcToken(token).catch((error: unknown) => {
          console.warn("[notebook-cloud] app session exchange failed", error);
        });
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
              <a href="/">Back to nteract</a>
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}

function decodeHashAnchorId(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
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
  const appSessionStatus = useCloudAppSessionStatus(config.session ?? null);
  const { authState, authRenewal, refreshAuthState } = useCloudPrototypeAuth(authConfig, {
    appSessionRefreshFallback: true,
    appSessionLoading: appSessionStatus.status === "loading",
    appSession: appSessionStatus.session,
  });
  useCloudAppSessionBridge(authState, appSessionStatus.refreshAppSessionStatus);
  const [focusedCellId, setFocusedCellId] = useState<string | null>(null);
  const [activeRailPanel, setActiveRailPanel] = useState<NotebookRailPanelId>("outline");
  const [railCollapsed, setRailCollapsed] = useState(initialCloudRailCollapsed);
  const [selectedOutlineItemId, setSelectedOutlineItemId] = useState<string | null>(null);
  const handledHeadingHashRef = useRef<string | null>(null);
  const [latestAccessRequest, setLatestAccessRequest] = useState<CloudNotebookAccessRequest | null>(
    null,
  );
  const [accessRequestError, setAccessRequestError] = useState<string | null>(null);
  const [workstationsState, setWorkstationsState] = useState<CloudWorkstationsState>({
    defaultWorkstationId: null,
    workstations: [],
  });
  const [workstationsError, setWorkstationsError] = useState<string | null>(null);
  const [workstationMutation, setWorkstationMutation] = useState<{
    kind: "idle" | "default" | "attach";
    message: string | null;
    workstationId: string | null;
  }>({ kind: "idle", message: null, workstationId: null });
  const [selectedInteractionMode, setSelectedInteractionMode] =
    useState<NotebookInteractionMode>("view");
  const [emptyRoomGraceElapsed, setEmptyRoomGraceElapsed] = useState(false);
  const appliedGrantedEditScopeRef = useRef<string | null>(null);
  const blobResolver = useMemo(
    () =>
      createNotebookCloudBlobResolver({
        baseUrl: location.href,
        blobBasePath: config.blobBasePath,
        fetchImpl: (input, init) => fetchWithCloudPrototypeAuth(input, init, authState),
        authenticatedBinaryDisplayUrls: true,
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
  const resolveSyncAuth = useCallback(
    async (sessionId: string) => {
      const appSession =
        appSessionStatus.session ??
        (appSessionStatus.status === "loading" && config.syncTicketEndpoint
          ? ((await readCloudAppSessionStatus().catch(() => null))?.session ?? null)
          : null);
      if (appSession && config.syncTicketEndpoint) {
        return cloudSyncAuthFromAppSessionTicket({
          endpoint: config.syncTicketEndpoint,
          requestedScope: "owner",
          sessionId,
        });
      }
      return cloudSyncAuthFromPrototypeAuthState(authState);
    },
    [appSessionStatus.session, appSessionStatus.status, authState, config.syncTicketEndpoint],
  );
  const {
    connectionActorLabel,
    connectionError,
    connectionPeerId,
    connectionScope,
    liveMaterializedRef,
    liveRuntimeRef,
    notebookLanguageRef,
    notebookMetadata,
    presenceStore,
    requestCloudMaterialization,
    retryLiveConnection,
    snapshotResolvedRef,
    status,
    workstationAttachment,
  } = useCloudViewerSession({
    authRenewalKind: authRenewal.kind,
    authState,
    blobResolver,
    config,
    hasAppSession: Boolean(appSessionStatus.session),
    loadingPolicy,
    preloadSiftWasm,
    resolveSyncAuth,
    widgetStore,
  });
  const cloudNotebookHost = useMemo(
    () =>
      createCloudNotebookHost({
        blobResolver,
        getRuntime: () => liveRuntimeRef.current,
      }),
    [blobResolver, liveRuntimeRef],
  );
  const presenceSnapshot = useSyncExternalStore(
    presenceStore.subscribe,
    presenceStore.getSnapshot,
    presenceStore.getSnapshot,
  );
  const runtimeState = useRuntimeState();
  const runtimePeerCount = cloudPresenceRuntimePeerCount(presenceSnapshot);
  const runtimePeerAvailable = cloudPresenceHasRuntimePeer(presenceSnapshot);
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

  useNotebookCellUIStateBridge({ focusedCellId });

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
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash || handledHeadingHashRef.current === hash) return;

    const headingAnchorId = decodeHashAnchorId(hash);
    const item = outlineItems.find(
      (candidate) =>
        candidate.headingAnchorId !== null && candidate.headingAnchorId === headingAnchorId,
    );
    if (!item) return;

    handledHeadingHashRef.current = hash;
    setSelectedOutlineItemId(item.id);
    navigateNotebookOutlineItem(item, hash, {
      behavior: "auto",
      headingHashTarget: "cell",
    });
  }, [outlineItems]);
  const handleSelectOutlineItem = useCallback((item: NotebookOutlineItem) => {
    setSelectedOutlineItemId(item.id);
  }, []);
  const handleNavigateOutlineItem = useCallback((item: NotebookOutlineItem, href: string) => {
    setSelectedOutlineItemId(item.id);
    return navigateNotebookOutlineItem(item, href, { headingHashTarget: "cell" });
  }, []);
  const handleTogglePackagesRail = useCallback(() => {
    if (activeRailPanel === "packages" && !railCollapsed) {
      setActiveRailPanel("outline");
      return;
    }
    setRailCollapsed(false);
    setActiveRailPanel("packages");
  }, [activeRailPanel, railCollapsed]);
  const handleOpenWorkstationsRail = useCallback(() => {
    setRailCollapsed(false);
    setActiveRailPanel("workstations");
  }, []);
  const hasBrowserAppIdentity =
    Boolean(appSessionStatus.session) || authState.mode === "dev" || authState.mode === "oidc";
  const canLoadCloudWorkstations = hasBrowserAppIdentity;
  const refreshCloudWorkstations = useCallback(
    async (signal?: AbortSignal) => {
      if (!canLoadCloudWorkstations || !config.workstationsEndpoint) {
        setWorkstationsState({ defaultWorkstationId: null, workstations: [] });
        setWorkstationsError(null);
        return;
      }
      try {
        const next = await fetchCloudWorkstations(config.workstationsEndpoint, authState, signal);
        if (signal?.aborted) return;
        setWorkstationsState(next);
        setWorkstationsError(null);
      } catch (error) {
        if (signal?.aborted) return;
        setWorkstationsError(error instanceof Error ? error.message : String(error));
      }
    },
    [authState, canLoadCloudWorkstations, config.workstationsEndpoint],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refreshCloudWorkstations(controller.signal);
    return () => controller.abort();
  }, [refreshCloudWorkstations]);
  const handleSetDefaultWorkstation = useCallback(
    async (workstationId: string) => {
      if (!config.workstationDefaultEndpoint) {
        return;
      }
      setWorkstationMutation({
        kind: "default",
        message: null,
        workstationId,
      });
      try {
        const defaultWorkstationId = await setCloudDefaultWorkstation(
          config.workstationDefaultEndpoint,
          authState,
          workstationId,
        );
        setWorkstationsState((previous) => ({
          ...previous,
          defaultWorkstationId: defaultWorkstationId ?? workstationId,
        }));
        setWorkstationsError(null);
        await refreshCloudWorkstations();
      } catch (error) {
        setWorkstationsError(error instanceof Error ? error.message : String(error));
      } finally {
        setWorkstationMutation({ kind: "idle", message: null, workstationId: null });
      }
    },
    [authState, config.workstationDefaultEndpoint, refreshCloudWorkstations],
  );
  const handleAttachWorkstation = useCallback(
    async (workstationId: string) => {
      if (!config.workstationAttachEndpoint) {
        return;
      }
      setWorkstationMutation({
        kind: "attach",
        message: "Attach requested. Waiting for the workstation to join this room.",
        workstationId,
      });
      handleOpenWorkstationsRail();
      try {
        await requestCloudWorkstationAttachment(
          config.workstationAttachEndpoint,
          authState,
          workstationId,
        );
        setWorkstationsError(null);
        await refreshCloudWorkstations();
      } catch (error) {
        setWorkstationsError(error instanceof Error ? error.message : String(error));
        setWorkstationMutation({ kind: "idle", message: null, workstationId: null });
        await refreshCloudWorkstations();
      }
    },
    [
      authState,
      config.workstationAttachEndpoint,
      handleOpenWorkstationsRail,
      refreshCloudWorkstations,
    ],
  );
  const canAcceptCellMutations =
    Boolean(connectionPeerId) &&
    !connectionError &&
    (status.kind === "ready" || status.kind === "empty");
  const editAccessRequestPending = !connectionError && status.kind === "loading";
  const roomEditAccess = useMemo(
    () =>
      projectCloudNotebookEditAccess({
        authState,
        connectionScope,
        selectedMode: selectedInteractionMode,
        canAcceptCellMutations,
        editAccessRequestPending,
      }),
    [
      authState,
      canAcceptCellMutations,
      connectionScope,
      editAccessRequestPending,
      selectedInteractionMode,
    ],
  );
  const requestedEditAccess = roomEditAccess.requestedDocumentEditAccess;
  const editAccessPending = roomEditAccess.editAccessPending;
  const shellCapabilities = useMemo(
    () =>
      cloudNotebookShellCapabilities({
        authState,
        connectionScope,
        connectionActorLabel,
        hasAppSession: Boolean(appSessionStatus.session),
        hasCodeCells: codeCellCount > 0,
        selectedMode: selectedInteractionMode,
        canAcceptCellMutations,
        editAccessRequestPending,
        runtimeAvailable: runtimePeerAvailable,
        runtimePeerCount,
        workstationAttachment,
        hostCapabilities: config.hostCapabilities,
      }),
    [
      authState,
      appSessionStatus.session,
      canAcceptCellMutations,
      codeCellCount,
      config.hostCapabilities,
      connectionActorLabel,
      connectionScope,
      editAccessRequestPending,
      runtimePeerCount,
      runtimePeerAvailable,
      selectedInteractionMode,
      workstationAttachment,
    ],
  );
  const cloudRuntimeStatus = useMemo<NotebookCommandToolbarStatus | null>(() => {
    if (!shellCapabilities.runtime.connected && !shellCapabilities.runtime.executionAvailable) {
      return null;
    }
    return projectNotebookCommandRuntimeStatusFromRuntimeState(runtimeState, {
      executionAvailable: shellCapabilities.runtime.executionAvailable,
    });
  }, [
    runtimeState,
    shellCapabilities.runtime.connected,
    shellCapabilities.runtime.executionAvailable,
  ]);
  const canChooseHostedWorkstation =
    shellCapabilities.access.source === "cloud" &&
    shellCapabilities.auth.canUseAuthenticatedIdentity &&
    shellCapabilities.access.level === "owner";
  const workstationRefreshIntervalMs = cloudWorkstationRefreshIntervalMs({
    canChooseHostedWorkstation,
    hasRegisteredWorkstations: workstationsState.workstations.length > 0,
    mutationKind: workstationMutation.kind,
    panelIsOpen: activeRailPanel === "workstations" && !railCollapsed,
  });
  useEffect(() => {
    if (workstationRefreshIntervalMs === null) {
      return;
    }
    let disposed = false;
    let timer: number | null = null;
    let activeController: AbortController | null = null;
    const scheduleRefresh = () => {
      timer = window.setTimeout(() => {
        const controller = new AbortController();
        activeController = controller;
        void refreshCloudWorkstations(controller.signal).finally(() => {
          if (activeController === controller) {
            activeController = null;
          }
          if (!disposed) {
            scheduleRefresh();
          }
        });
      }, workstationRefreshIntervalMs);
    };
    scheduleRefresh();
    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      activeController?.abort();
    };
  }, [refreshCloudWorkstations, workstationRefreshIntervalMs]);
  const workstationSelection = useMemo(
    () =>
      projectNotebookWorkstationSelection({
        activeAttachment: workstationAttachment,
        canRegisterWorkstation: canChooseHostedWorkstation,
        canSelectWorkstation: canChooseHostedWorkstation,
        canSetDefaultWorkstation: canChooseHostedWorkstation,
        defaultWorkstationId: workstationsState.defaultWorkstationId,
        registeredWorkstations: workstationsState.workstations,
      }),
    [canChooseHostedWorkstation, workstationAttachment, workstationsState],
  );
  const workstationLaunchReadiness = useMemo(
    () =>
      projectNotebookWorkstationLaunchReadiness({
        capabilities: shellCapabilities,
        selection: workstationSelection,
      }),
    [shellCapabilities, workstationSelection],
  );
  const workstationAction = useMemo(() => {
    const { primaryAction, workstationId } = workstationLaunchReadiness;
    return primaryAction.kind !== "none" && primaryAction.label && primaryAction.title
      ? {
          label: primaryAction.label,
          title: primaryAction.title,
          onClick:
            primaryAction.kind === "attach_workstation" && workstationId
              ? () => handleAttachWorkstation(workstationId)
              : handleOpenWorkstationsRail,
        }
      : null;
  }, [handleAttachWorkstation, handleOpenWorkstationsRail, workstationLaunchReadiness]);
  const workstationPanelStatusMessage =
    workstationMutation.message ??
    workstationsError ??
    (workstationLaunchReadiness.state === "workstation_unavailable"
      ? workstationLaunchReadiness.detail
      : null);
  useEffect(() => {
    if (workstationMutation.kind !== "attach" || !workstationAttachment?.workstation_id) {
      return;
    }
    if (
      !workstationMutation.workstationId ||
      workstationMutation.workstationId === workstationAttachment.workstation_id
    ) {
      setWorkstationMutation({ kind: "idle", message: null, workstationId: null });
    }
  }, [workstationAttachment?.workstation_id, workstationMutation]);
  useEffect(() => {
    if (!requestedEditAccess) {
      appliedGrantedEditScopeRef.current = null;
      return;
    }
    if (
      !canAcceptCellMutations ||
      (connectionScope !== "editor" && connectionScope !== "owner") ||
      !connectionPeerId
    ) {
      return;
    }

    const grantKey = `${connectionPeerId}:${connectionScope}`;
    if (appliedGrantedEditScopeRef.current === grantKey) {
      return;
    }
    appliedGrantedEditScopeRef.current = grantKey;
    setSelectedInteractionMode("edit");
  }, [canAcceptCellMutations, connectionPeerId, connectionScope, requestedEditAccess]);
  const canWriteCellSource = useCallback(
    (cellId: string) => {
      const cell = getCellById(cellId);
      if (!cell) {
        return false;
      }
      if (cell.cell_type === "markdown") {
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
  const toolbarRuntime = editAccessPending
    ? null
    : notebookLanguageRef.current === "deno"
      ? "deno"
      : "python";
  const toolbarEnvironmentManager = editAccessPending ? null : packageEnvironmentManager;
  useEffect(() => {
    if (status.kind !== "empty" || notebookCellIds.length > 0) {
      setEmptyRoomGraceElapsed(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setEmptyRoomGraceElapsed(true);
    }, CLOUD_EMPTY_ROOM_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [notebookCellIds.length, status.kind]);
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
          if (liveRuntime && liveRuntime.handle === handle) {
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
  const createCloudNotebookClient = useCallback(
    (action: string) => {
      const liveRuntime = liveRuntimeRef.current;
      if (!liveRuntime) {
        console.warn(`[notebook-cloud] cannot ${action} without a live room connection`);
        return null;
      }
      return {
        liveRuntime,
        client: new NotebookClient({
          transport: liveRuntime.transport,
          logger: console,
          getRequiredHeads: () => liveRuntime.handle.get_heads_hex(),
        }),
      };
    },
    [liveRuntimeRef],
  );
  const handleCloudExecuteCell = useCallback(
    (cellId: string) => {
      const runtimeClient = createCloudNotebookClient("execute cell");
      if (!runtimeClient) return;

      void (async () => {
        const delivered = await runtimeClient.liveRuntime.engine.flushAndWait();
        if (!delivered) {
          console.warn("[notebook-cloud] execute cell request skipped; notebook sync failed");
          return;
        }

        await runtimeClient.client.executeCell(cellId);
      })().catch((error: unknown) => {
        console.warn("[notebook-cloud] execute cell request failed", error);
      });
    },
    [createCloudNotebookClient],
  );
  const handleCloudRunAllCells = useCallback(() => {
    const runtimeClient = createCloudNotebookClient("run all cells");
    if (!runtimeClient) return;

    void (async () => {
      const delivered = await runtimeClient.liveRuntime.engine.flushAndWait();
      if (!delivered) {
        console.warn("[notebook-cloud] run all cells request skipped; notebook sync failed");
        return;
      }

      await runtimeClient.client.runAllCells();
    })().catch((error: unknown) => {
      console.warn("[notebook-cloud] run all cells request failed", error);
    });
  }, [createCloudNotebookClient]);
  const handleCloudStartRuntime = useCallback(() => {
    const runtimeClient = createCloudNotebookClient("start kernel");
    if (!runtimeClient) return;

    void (async () => {
      const delivered = await runtimeClient.liveRuntime.engine.flushAndWait();
      if (!delivered) {
        console.warn("[notebook-cloud] start kernel request skipped; notebook sync failed");
        return;
      }

      await runtimeClient.client.launchKernel("auto", "auto");
    })().catch((error: unknown) => {
      console.warn("[notebook-cloud] start kernel request failed", error);
    });
  }, [createCloudNotebookClient]);
  const handleCloudInterruptRuntime = useCallback(() => {
    const runtimeClient = createCloudNotebookClient("interrupt kernel");
    if (!runtimeClient) return;

    void runtimeClient.client.interruptKernel().catch((error: unknown) => {
      console.warn("[notebook-cloud] interrupt kernel request failed", error);
    });
  }, [createCloudNotebookClient]);
  const handleCloudRestartRuntime = useCallback(() => {
    const runtimeClient = createCloudNotebookClient("restart kernel");
    if (!runtimeClient) return;

    void (async () => {
      const delivered = await runtimeClient.liveRuntime.engine.flushAndWait();
      if (!delivered) {
        console.warn("[notebook-cloud] restart kernel request skipped; notebook sync failed");
        return;
      }

      await runtimeClient.client.shutdownKernel();
      await runtimeClient.client.launchKernel("auto", "auto");
    })().catch((error: unknown) => {
      console.warn("[notebook-cloud] restart kernel request failed", error);
    });
  }, [createCloudNotebookClient]);
  const handleCloudRestartAndRunAll = useCallback(() => {
    const runtimeClient = createCloudNotebookClient("restart kernel and run all cells");
    if (!runtimeClient) return;

    void (async () => {
      const delivered = await runtimeClient.liveRuntime.engine.flushAndWait();
      if (!delivered) {
        console.warn(
          "[notebook-cloud] restart kernel and run all cells request skipped; notebook sync failed",
        );
        return;
      }

      await runtimeClient.client.shutdownKernel();
      await runtimeClient.client.launchKernel("auto", "auto");
      await runtimeClient.client.runAllCells();
    })().catch((error: unknown) => {
      console.warn("[notebook-cloud] restart kernel and run all cells request failed", error);
    });
  }, [createCloudNotebookClient]);
  const handleCloudSetCellSourceHidden = useCallback(
    (cellId: string, hidden: boolean) => {
      cloudNotebookController.setCellSourceHidden(cellId, hidden);
    },
    [cloudNotebookController],
  );
  const handleCloudSetCellOutputsHidden = useCallback(
    (cellId: string, hidden: boolean) => {
      cloudNotebookController.setCellOutputsHidden(cellId, hidden);
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
            setInteraction: (target) => {
              liveRuntimeRef.current?.sendInteractionPresence(target);
            },
          }
        : null,
    [connectionPeerId],
  );
  const handleSourceSyncNeeded = useCallback(() => {
    if (!shellCapabilities.canEditCells && !shellCapabilities.canEditMarkdown) return;
    liveRuntimeRef.current?.engine.scheduleFlush();
  }, [shellCapabilities.canEditCells, shellCapabilities.canEditMarkdown]);
  const resetPrototypeAuth = useCallback(() => {
    void clearCloudAppSession().catch((error: unknown) => {
      console.warn("[notebook-cloud] app session clear failed", error);
    });
    clearCloudPrototypeDevAuth(window.localStorage);
    setLatestAccessRequest(null);
    setAccessRequestError(null);
    setSelectedInteractionMode("view");
    refreshAuthState();
  }, [refreshAuthState]);
  const applyLatestAccessRequest = useCallback(
    (request: CloudNotebookAccessRequest | null) => {
      setLatestAccessRequest(request);
      if (request?.status === "pending" || request?.status === "approved") {
        storeCloudRequestedScope(window.localStorage, "editor");
        setSelectedInteractionMode("edit");
        if (request.status === "approved") {
          retryLiveConnection();
        }
        if (authState.requestedScope !== "editor") {
          refreshAuthState();
        }
        return;
      }

      if (authState.requestedScope === "editor" && connectionScope === "viewer") {
        storeCloudRequestedScope(window.localStorage, "viewer");
        setSelectedInteractionMode("view");
        refreshAuthState();
      }
    },
    [authState.requestedScope, connectionScope, refreshAuthState, retryLiveConnection],
  );
  const loadOwnAccessRequest = useCallback(
    async (options?: { signal?: AbortSignal }) => {
      if (connectionScope !== "viewer" || !hasBrowserAppIdentity) {
        return;
      }

      try {
        const response = await fetchWithCloudPrototypeAuth(
          config.accessRequestsEndpoint,
          { headers: { Accept: "application/json" }, signal: options?.signal },
          authState,
        );
        if (options?.signal?.aborted) {
          return;
        }
        if (!response.ok) {
          return;
        }
        const body = (await response.json()) as {
          access_requests?: CloudNotebookAccessRequest[];
        };
        setAccessRequestError(null);
        applyLatestAccessRequest(
          Array.isArray(body.access_requests) ? (body.access_requests[0] ?? null) : null,
        );
      } catch {
        return;
      }
    },
    [
      applyLatestAccessRequest,
      authState,
      config.accessRequestsEndpoint,
      connectionScope,
      hasBrowserAppIdentity,
    ],
  );
  useEffect(() => {
    if (connectionScope !== "viewer" || !hasBrowserAppIdentity) {
      setLatestAccessRequest(null);
      return;
    }
    const controller = new AbortController();
    void loadOwnAccessRequest({ signal: controller.signal });
    return () => controller.abort();
  }, [connectionScope, hasBrowserAppIdentity, loadOwnAccessRequest]);
  useEffect(() => {
    if (
      latestAccessRequest?.status !== "pending" ||
      connectionScope !== "viewer" ||
      !hasBrowserAppIdentity
    ) {
      return;
    }

    const controller = new AbortController();
    const intervalId = window.setInterval(() => {
      void loadOwnAccessRequest({ signal: controller.signal });
    }, CLOUD_ACCESS_REQUEST_POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(intervalId);
    };
  }, [connectionScope, hasBrowserAppIdentity, latestAccessRequest?.status, loadOwnAccessRequest]);
  const requestCloudEditAccess = useCallback(() => {
    void (async () => {
      setAccessRequestError(null);
      try {
        const response = await fetchWithCloudPrototypeAuth(
          config.accessRequestsEndpoint,
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ scope: "editor" }),
          },
          authState,
        );
        if (!response.ok) {
          throw await cloudResponseError(response, "Unable to request edit access");
        }
        const body = (await response.json()) as {
          access_request?: CloudNotebookAccessRequest | null;
          access_status?: string;
        };
        if (body.access_status === "granted") {
          applyLatestAccessRequest({
            id: "already-granted",
            notebook_id: config.notebookId,
            requester_principal: "",
            scope: "editor",
            status: "approved",
            requested_by_actor_label: "",
            resolved_by_actor_label: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            resolved_at: new Date().toISOString(),
          });
          return;
        }
        applyLatestAccessRequest(body.access_request ?? null);
      } catch (error) {
        setAccessRequestError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [applyLatestAccessRequest, authState, config.accessRequestsEndpoint, config.notebookId]);
  const shouldShowPackageEnvironmentSummary =
    shellCapabilities.canExecute || shellCapabilities.canManagePackages;
  const toolbarAddAfterCellId =
    focusedCellId ?? notebookCellIds[notebookCellIds.length - 1] ?? null;
  const publicNotebookLink = useMemo(
    () => new URL(window.location.pathname, window.location.origin).href,
    [],
  );
  const rail = (
    <NotebookDocumentRail
      viewModel={notebookViewModel}
      activePanelId={activeRailPanel}
      collapsed={railCollapsed}
      selectedOutlineItemId={selectedOutlineItemId}
      packagesSummary={null}
      workstationsSummary={notebookWorkstationsSummary(shellCapabilities)}
      workstationsPanel={
        <NotebookWorkstationsPanel
          capabilities={shellCapabilities}
          selection={workstationSelection}
          statusMessage={workstationPanelStatusMessage}
          busyWorkstationId={workstationMutation.workstationId}
          onAttachWorkstation={canChooseHostedWorkstation ? handleAttachWorkstation : undefined}
          onSetDefaultWorkstation={
            canChooseHostedWorkstation ? handleSetDefaultWorkstation : undefined
          }
        />
      }
      packagesPanel={
        <NotebookPackageSummaryPanel
          packages={notebookViewModel.packages}
          readOnly={!shellCapabilities.canManagePackages}
          header={
            shouldShowPackageEnvironmentSummary ? (
              <EnvironmentSummary
                capabilities={shellCapabilities}
                packages={notebookViewModel.packages}
                showPackageDetails={false}
                className="cloud-package-summary-header"
              />
            ) : undefined
          }
        />
      }
      onActivePanelChange={setActiveRailPanel}
      onCollapsedChange={setRailCollapsed}
      onSelectOutlineItem={handleSelectOutlineItem}
      onNavigateOutlineItem={handleNavigateOutlineItem}
      className="cloud-notebook-rail"
    />
  );

  const showCloudCommandToolbar = shouldShowNotebookDocumentCommandToolbar(shellCapabilities, {
    reserve: editAccessPending,
  });

  const toolbar = (
    <NotebookDocumentToolbar
      capabilities={shellCapabilities}
      frameClassName="z-20"
      headerClassName="cloud-room-toolbar"
      presence={<CloudNotebookTitle />}
      utilityControls={
        <CloudPresenceStatus connectionError={connectionError} store={presenceStore} />
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
          accessRequestsEndpoint={config.accessRequestsEndpoint}
          authState={authState}
          publicLink={publicNotebookLink}
        />
      }
      editControls={
        <CloudNotebookEditModeButton
          authState={authState}
          hasAppSession={Boolean(appSessionStatus.session)}
          interaction={shellCapabilities.interaction ?? null}
          accessLevel={shellCapabilities.access.level}
          accessPending={editAccessPending}
          onModeChange={setSelectedInteractionMode}
          onRequestEditAccess={requestCloudEditAccess}
        />
      }
      identityControls={null}
      reserveCommandToolbar={editAccessPending}
      commandToolbar={{
        runtime: toolbarRuntime,
        environmentManager: toolbarEnvironmentManager,
        environmentPanelOpen: activeRailPanel === "packages" && !railCollapsed,
        runtimeStatus: cloudRuntimeStatus,
        addCellControlsDisabled: editAccessPending,
        addAfterCellId: toolbarAddAfterCellId,
        onAddCell: handleCloudAddCell,
        onStartRuntime: handleCloudStartRuntime,
        onInterruptRuntime: handleCloudInterruptRuntime,
        onRestartRuntime: handleCloudRestartRuntime,
        onRunAllCells: handleCloudRunAllCells,
        onRestartAndRunAll: handleCloudRestartAndRunAll,
        onTogglePackages: handleTogglePackagesRail,
        workstationAction,
      }}
    />
  );
  const notebookHasReadableSnapshot =
    notebookCellIds.length > 0 ||
    (!connectionError && snapshotResolvedRef.current && status.kind === "ready");
  const notebookViewIsLoading =
    status.kind === "loading" ||
    editAccessPending ||
    (status.kind === "empty" && notebookCellIds.length === 0 && !emptyRoomGraceElapsed) ||
    (Boolean(connectionError) && !notebookHasReadableSnapshot) ||
    (shellCapabilities.canEditStructure &&
      notebookCellIds.length === 0 &&
      !liveMaterializedRef.current);
  const noticeStatus: ViewerStatus =
    notebookViewIsLoading && (status.kind === "ready" || status.kind === "empty")
      ? { kind: "loading", message: "Preparing notebook view..." }
      : status;
  const accessRequestNotice = cloudAccessRequestNotice(latestAccessRequest, accessRequestError);
  const hasNotices = cloudNotebookHasNotices({
    authState,
    authRenewal,
    connectionError,
    diagnostics: accessRequestNotice,
    hasReadableSnapshot: notebookHasReadableSnapshot,
    status: noticeStatus,
  });
  const notices = hasNotices ? (
    <CloudNotebookNotices
      authState={authState}
      authRenewal={authRenewal}
      connectionError={connectionError}
      diagnostics={accessRequestNotice}
      hasReadableSnapshot={notebookHasReadableSnapshot}
      status={noticeStatus}
      onResetAuth={resetPrototypeAuth}
    />
  ) : null;

  return (
    <NotebookHostProvider host={cloudNotebookHost}>
      <NotebookDocumentShell
        rootElement="main"
        className={
          showCloudCommandToolbar
            ? "cloud-notebook-shell cloud-notebook-shell--command-toolbar"
            : "cloud-notebook-shell"
        }
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
              onExecuteCell={handleCloudExecuteCell}
              onInterruptKernel={() => {}}
              onDeleteCell={handleCloudDeleteCell}
              onAddCell={handleCloudAddCell}
              onMoveCell={handleCloudMoveCell}
              onSetCellSourceHidden={handleCloudSetCellSourceHidden}
              onSetCellOutputsHidden={handleCloudSetCellOutputsHidden}
              markdownHeadingAnchorsByCellId={notebookViewModel.markdownHeadingAnchorsByCellId}
              outputHostContext={outputHostContext}
              deferOutputIsolatedFramesUntilVisible={!shellCapabilities.canEditCells}
              deferredOutputIsolatedFrameRootMargin={CLOUD_VIEWER_OUTPUT_IFRAME_ROOT_MARGIN}
              autoFocusFirstCell={false}
            />
          </CrdtBridgeProvider>
        </PresenceValueProvider>
      </NotebookDocumentShell>
    </NotebookHostProvider>
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

function cloudAccessRequestNotice(
  request: CloudNotebookAccessRequest | null,
  error: string | null,
): ReactNode {
  if (error) {
    return (
      <NotebookNotice
        tone="error"
        icon={<AlertCircle className="h-4 w-4" />}
        title="Edit request failed."
      >
        {error}
      </NotebookNotice>
    );
  }

  if (!request) {
    return null;
  }

  if (request.status === "pending") {
    return (
      <NotebookNotice
        tone="info"
        icon={<Loader2 className="h-4 w-4 animate-spin" />}
        title="Edit access requested."
      >
        The owner can review this request from the sharing panel.
      </NotebookNotice>
    );
  }

  if (request.status === "approved") {
    return (
      <NotebookNotice
        tone="success"
        icon={<Check className="h-4 w-4" />}
        title="Edit access approved."
      >
        Reconnecting with editor access.
      </NotebookNotice>
    );
  }

  if (request.status === "denied") {
    return (
      <NotebookNotice tone="warning" icon={<X className="h-4 w-4" />} title="Edit request denied.">
        The notebook stays in view mode.
      </NotebookNotice>
    );
  }

  return (
    <NotebookNotice
      tone="info"
      icon={<AlertCircle className="h-4 w-4" />}
      title="Edit request dismissed."
    >
      The owner dismissed the request.
    </NotebookNotice>
  );
}

function CloudNotebookEditModeButton({
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

function initialCloudRailCollapsed(): boolean {
  return true;
}

function shouldShowCloudHeaderSignIn(authState: CloudPrototypeAuthState): boolean {
  return (
    authState.mode === "anonymous" ||
    authState.mode === "invalid" ||
    authState.mode === "oidc_expired"
  );
}

function CloudNotebookTitle() {
  const title = cloudNotebookRouteTitle();

  return (
    <div className="cloud-notebook-title" title={title.title}>
      <span>{title.label}</span>
      {title.detail ? <small>{title.detail}</small> : null}
    </div>
  );
}

function cloudNotebookRouteTitle(): {
  label: string;
  detail: string | null;
  title: string;
} {
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const routeSlug = pathParts[0] === "n" ? pathParts[2] : null;
  const decodedSlug = safeDecodeRouteSegment(routeSlug);

  if (decodedSlug) {
    const label = humanizeCloudRouteTitle(decodedSlug);
    return {
      label,
      detail: null,
      title: label,
    };
  }

  return {
    label: "Cloud Notebook",
    detail: null,
    title: "Cloud Notebook",
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

function CloudPresenceStatus({
  connectionError,
  store,
}: {
  connectionError: string | null;
  store: CloudViewerPresenceStore;
}) {
  const presence = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const presenceDisplay = cloudViewerPresenceDisplay(presence);
  const connected = presenceDisplay.connected && !connectionError;
  const title = connectionError
    ? `Room unavailable: ${cloudConnectionStatusErrorTitle(connectionError)}`
    : presenceDisplay.title;
  const state = connected ? "live" : presence.connection === "connecting" ? "joining" : "waiting";

  return (
    <span
      className="cloud-presence-stack"
      data-slot="cloud-presence-stack"
      data-state={state}
      title={title}
      aria-label={title}
    >
      <AvatarGroup className="cloud-presence-avatar-group" aria-hidden="true">
        {presenceDisplay.peers.map((peer) => (
          <CloudPresenceAvatar key={peer.id} peer={peer} connected={connected} />
        ))}
        {presenceDisplay.hiddenCount > 0 ? (
          <AvatarGroupCount className="cloud-presence-avatar-count" data-size="sm">
            +{presenceDisplay.hiddenCount}
          </AvatarGroupCount>
        ) : null}
      </AvatarGroup>
      <span className="sr-only">{presenceDisplay.label}</span>
    </span>
  );
}

function CloudPresenceAvatar({
  connected,
  peer,
}: {
  connected: boolean;
  peer: CloudViewerPresencePeer;
}) {
  const status = connected ? peer.status : "offline";
  return (
    <Avatar
      size="sm"
      className="cloud-presence-avatar"
      data-kind={peer.kind}
      data-status={status}
      title={peer.label}
    >
      <AvatarFallback>
        {peer.kind === "anonymous" ? (
          <>
            <UserRound aria-hidden="true" />
            {peer.count && peer.count > 1 ? (
              <span className="cloud-presence-anonymous-count">{peer.count}</span>
            ) : null}
          </>
        ) : (
          cloudPresenceInitials(peer.label)
        )}
      </AvatarFallback>
      <AvatarBadge data-status={status} />
    </Avatar>
  );
}

function cloudPresenceInitials(label: string): string {
  const words = label
    .split(/[\s@._-]+/g)
    .map((word) => word.trim())
    .filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return initials || "?";
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

createRoot(requireElement("#root")).render(
  <ErrorBoundary
    fallback={(error) => <ViewerStartupError message={`Cloud viewer crashed: ${error.message}`} />}
  >
    <App />
  </ErrorBoundary>,
);
