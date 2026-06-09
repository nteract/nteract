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
  FilePlus2,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  RotateCcw,
  UserRound,
  X,
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
  cloudBrowserCanUseAuthenticatedApi,
  cloudNotebookSignInCopy,
  fetchWithCloudPrototypeAuth,
  cloudSyncAuthFromAppSessionCookie,
  cloudSyncAuthFromPrototypeAuthState,
  prepareCloudOidcViewerLogin,
  storeCloudRequestedScope,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";
import { createCloudNotebookCellId } from "./cloud-cell-id";
import { useCloudViewerSession, type CloudViewerConfig } from "./cloud-viewer-session";
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
import { beginOidcLogin, completeOidcRedirect } from "./oidc-auth";
import { cloudViewerLoadingPolicy } from "./loading-policy";
import { markCloudViewerLoadMilestone } from "./load-milestones";
import { CLOUD_VIEWER_PRIORITY } from "./mime-policy";
import {
  cloudPresenceHasRuntimePeer,
  cloudPresenceRuntimePeerCount,
  type CloudViewerPresencePeer,
  type CloudViewerPresenceStore,
  cloudViewerPresenceDisplay,
} from "./presence";
import type { ResolvedCell } from "./render-resolution";
import { CloudNotebookNotices, cloudNotebookHasNotices } from "./notices";
import type { ViewerStatus } from "./notice-types";
import { rendererAssetBasePathForProvider } from "./renderer-assets";
import { projectCloudNotebookDashboard, type CloudNotebookListItem } from "./notebook-dashboard";
import { CloudNotebookDashboard } from "./cloud-notebook-dashboard-view";
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
  establishCloudAppSessionFromOidcToken,
  readCloudAppSessionStatus,
} from "./app-session";
import {
  applyDocumentTheme,
  CLOUD_VIEWER_THEME_STORAGE_KEY,
  installDocumentThemeSync,
} from "./theme";
import { CLOUD_WIDGET_RENDERERS, CloudWidgetStoreProvider } from "./widget-runtime";
import {
  isHomePath,
  isNotebookListPath,
  isOidcCallbackPath,
  loadAuthConfig,
  loadCloudNotebookListBootstrap,
  loadViewerRuntime,
  requireElement,
} from "./cloud-viewer-config";
import type {
  CloudNotebookCreateResponse,
  CloudNotebookListBootstrap,
  CloudNotebookListResponse,
  CloudNotebookListState,
  CloudNotebookRenameState,
  CloudNotebookUpdateResponse,
  CloudViewerAuthConfig,
  ViewerRuntime,
  ViewerRuntimeState,
} from "./cloud-viewer-types";
import {
  useCloudAppSessionBridge,
  useCloudAppSessionStatus,
  useCloudPrototypeAuth,
} from "./use-cloud-auth";
import { useCloudShellCapabilities } from "./use-cloud-shell-capabilities";
import { useCloudWorkstationManager } from "./use-cloud-workstations";
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

installDocumentThemeSync();

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
  useCloudAppSessionBridge(
    authState,
    appSessionStatus.session,
    appSessionStatus.status === "loading",
    appSessionStatus.refreshAppSessionStatus,
  );
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
  const canFetchNotebookList = authState.mode === "dev" || hasAppSession;
  const waitingForAppSession = authState.mode === "oidc" && !hasAppSession;
  const dashboardModel = useMemo(
    () => (listState.kind === "ready" ? projectCloudNotebookDashboard(listState.notebooks) : null),
    [listState],
  );

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    const cachedNotebooks =
      readCachedCloudNotebookListFromWindow(authState) ?? bootstrap?.notebooks ?? null;
    if (!canFetchNotebookList) {
      if (waitingForAppSession) {
        setListState(
          cachedNotebooks ? { kind: "ready", notebooks: cachedNotebooks } : { kind: "loading" },
        );
        return;
      }
      clearCachedCloudNotebookListFromWindow();
      setListState({ kind: "signed_out" });
      return;
    }

    const controller = new AbortController();
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
  }, [authState, bootstrap, canFetchNotebookList, refreshIndex, waitingForAppSession]);

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

  const headerDetail = cloudNotebookListHeaderDetail(authState, hasAppSession);

  return (
    <main className="cloud-notebook-list-page">
      <header className="cloud-notebook-list-header">
        <div>
          <a className="cloud-notebook-list-brand" href="/">
            nteract
          </a>
          <h1>Notebooks</h1>
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

      {authRenewal.kind !== "idle" && !hasAppSession ? (
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

function cloudNotebookListHeaderDetail(
  authState: CloudPrototypeAuthState,
  hasAppSession: boolean,
): string {
  if (authState.mode === "oidc_expired") {
    return "Session expired";
  }
  if (authState.mode === "anonymous" && !hasAppSession) {
    return "Signed out";
  }
  const firstName = cloudNotebookListFirstName(authState);
  return firstName ? `by ${firstName}` : "Signed in";
}

function cloudNotebookListFirstName(authState: CloudPrototypeAuthState): string | null {
  const claimName =
    authState.oidcClaims?.given_name?.trim() || authState.oidcClaims?.name?.trim() || "";
  if (!claimName || claimName.includes("@")) {
    return null;
  }
  return claimName.split(/\s+/u)[0] ?? null;
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

function CloudHomeView({ authConfig }: { authConfig: CloudViewerAuthConfig }) {
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
  useCloudAppSessionBridge(
    authState,
    appSessionStatus.session,
    appSessionStatus.status === "loading",
    appSessionStatus.refreshAppSessionStatus,
  );
  const [focusedCellId, setFocusedCellId] = useState<string | null>(null);
  const [activeRailPanel, setActiveRailPanel] = useState<NotebookRailPanelId>("outline");
  const [railCollapsed, setRailCollapsed] = useState(initialCloudRailCollapsed);
  const [selectedOutlineItemId, setSelectedOutlineItemId] = useState<string | null>(null);
  const handledHeadingHashRef = useRef<string | null>(null);
  const [latestAccessRequest, setLatestAccessRequest] = useState<CloudNotebookAccessRequest | null>(
    null,
  );
  const [accessRequestError, setAccessRequestError] = useState<string | null>(null);
  const [selectedInteractionMode, setSelectedInteractionMode] =
    useState<NotebookInteractionMode>("view");
  const [emptyRoomGraceElapsed, setEmptyRoomGraceElapsed] = useState(false);
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
        (appSessionStatus.status === "loading"
          ? ((await readCloudAppSessionStatus().catch(() => null))?.session ?? null)
          : null);
      if (appSession) {
        return cloudSyncAuthFromAppSessionCookie({
          requestedScope: "owner",
          sessionId,
        });
      }
      return cloudSyncAuthFromPrototypeAuthState(authState);
    },
    [appSessionStatus.session, appSessionStatus.status, authState],
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
  const canUseAuthenticatedCloudApi = cloudBrowserCanUseAuthenticatedApi({
    authState,
    hasAppSession: Boolean(appSessionStatus.session),
  });
  const { shellCapabilities, canAcceptCellMutations, editAccessPending } =
    useCloudShellCapabilities({
      authState,
      codeCellCount,
      connectionActorLabel,
      connectionError,
      connectionPeerId,
      connectionScope,
      hasAppSession: Boolean(appSessionStatus.session),
      hostCapabilities: config.hostCapabilities,
      runtimePeerAvailable,
      runtimePeerCount,
      selectedMode: selectedInteractionMode,
      status,
      workstationAttachment,
    });
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
  const {
    busyWorkstationId,
    onAttachWorkstation,
    onSetDefaultWorkstation,
    workstationAction,
    workstationPanelStatusMessage,
    workstationSelection,
  } = useCloudWorkstationManager({
    authState,
    canLoadCloudWorkstations: canUseAuthenticatedCloudApi,
    capabilities: shellCapabilities,
    config,
    onOpenWorkstationsRail: handleOpenWorkstationsRail,
    panelIsOpen: activeRailPanel === "workstations" && !railCollapsed,
    workstationAttachment,
  });
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
  const beginNotebookOidcAuth = useCallback(async () => {
    if (!authConfig.oidc) {
      resetPrototypeAuth();
      return;
    }
    try {
      prepareCloudOidcViewerLogin(window.localStorage);
      const url = await beginOidcLogin(authConfig.oidc, {
        currentUrl: window.location.href,
        storage: window.localStorage,
      });
      window.location.assign(url.href);
    } catch (error) {
      console.warn("[notebook-cloud] OIDC sign-in start failed", error);
    }
  }, [authConfig.oidc, resetPrototypeAuth]);
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
      if (connectionScope !== "viewer" || !canUseAuthenticatedCloudApi) {
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
      canUseAuthenticatedCloudApi,
      config.accessRequestsEndpoint,
      connectionScope,
    ],
  );
  useEffect(() => {
    if (connectionScope !== "viewer" || !hasBrowserAppIdentity) {
      setLatestAccessRequest(null);
      return;
    }
    if (!canUseAuthenticatedCloudApi) {
      return;
    }
    const controller = new AbortController();
    void loadOwnAccessRequest({ signal: controller.signal });
    return () => controller.abort();
  }, [canUseAuthenticatedCloudApi, connectionScope, hasBrowserAppIdentity, loadOwnAccessRequest]);
  useEffect(() => {
    if (
      latestAccessRequest?.status !== "pending" ||
      connectionScope !== "viewer" ||
      !canUseAuthenticatedCloudApi
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
  }, [
    canUseAuthenticatedCloudApi,
    connectionScope,
    latestAccessRequest?.status,
    loadOwnAccessRequest,
  ]);
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
          busyWorkstationId={busyWorkstationId}
          onAttachWorkstation={onAttachWorkstation}
          onSetDefaultWorkstation={onSetDefaultWorkstation}
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
    hasAppSession: Boolean(appSessionStatus.session),
    hasReadableSnapshot: notebookHasReadableSnapshot,
    status: noticeStatus,
  });
  const notices = hasNotices ? (
    <CloudNotebookNotices
      authState={authState}
      authRenewal={authRenewal}
      connectionError={connectionError}
      diagnostics={accessRequestNotice}
      hasAppSession={Boolean(appSessionStatus.session)}
      hasReadableSnapshot={notebookHasReadableSnapshot}
      status={noticeStatus}
      onResetAuth={resetPrototypeAuth}
      onSignInAgain={authConfig.oidc ? beginNotebookOidcAuth : undefined}
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
