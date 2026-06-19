import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { NotebookHostProvider } from "@nteract/notebook-host";
import { AlertCircle, Check, Loader2, PanelLeftOpen, X } from "lucide-react";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import {
  useHasIsolatedOutputs,
  useIsolatedRenderer,
} from "@/components/isolated/isolated-renderer-context";
import { NotebookNotice } from "@/components/notebook/NotebookNotice";
import {
  NotebookConnectionIdentity,
  NotebookCommentsPanel,
  NotebookDocumentToolbar,
  navigateNotebookOutlineItem,
  NotebookDocumentRail,
  NotebookDocumentShell,
  NotebookPackageSummaryPanel,
  NotebookWorkstationsPanel,
  projectNotebookCommandRuntimeStatusFromRuntimeState,
  shouldShowNotebookDocumentCommandToolbar,
  useActiveOutlineItemId,
  useOutlineSelection,
  useOutlineStatusLabel,
  type NotebookCommandToolbarStatus,
  type NotebookEnvironmentManager,
  type NotebookInteractionMode,
  type NotebookPackageSection,
  flushCellUIState,
  getCellById,
  setFocusedCellId,
  useFocusedCellId,
  useNotebookViewModel,
  type CommentAuthor,
  type CommentAnchor,
  type CommentThreadSnapshot,
  type CommentsProjection,
} from "@/components/notebook";
import {
  openNotebookRailPanel,
  setActiveNotebookRailPanel,
  setNotebookRailCollapsed,
  useNotebookRailUiState,
} from "@/components/notebook/state/rail-ui-state";
import { useWidgetStoreRequired } from "@/components/widgets/widget-store-context";
import { useTheme } from "@/hooks/useTheme";
import { EnvironmentSummary } from "@/components/environment";
import {
  NotebookClient,
  resolveActorDisplay,
  workstationAttachmentCanExecute,
  workstationAttachmentIsConnected,
  type CellChangeset,
  type NotebookOutlineItem,
  type SyncEngineLogger,
} from "runtimed";
import { createNotebookCloudBlobResolver } from "../src/blob-resolver";
import {
  clearCloudPrototypeDevAuth,
  cloudBrowserCanUseAuthenticatedApi,
  fetchWithCloudPrototypeAuth,
  cloudSyncAuthFromAppSessionCookie,
  cloudSyncAuthFromPrototypeAuthState,
  prepareCloudOidcViewerLogin,
  storeCloudRequestedScope,
  shouldShowCloudHeaderSignIn,
} from "./collaborator-auth";
import type { ConnectionScope } from "../src/auth-shared";

import { useCloudViewerSession } from "./cloud-viewer-session";
import {
  cloudBrowserApiAuthStateForFetch,
  cloudSyncAuthConnectionKey,
} from "./session-auth-stability";
import { NotebookView } from "../../notebook/src/notebook-surface";
import {
  CrdtBridgeProvider,
  createNotebookCellId,
  createNotebookController,
  PresenceValueProvider,
  type PresenceContextValue,
} from "@/components/notebook";
import {
  useRuntimeState,
  useWorkstationAttachment,
} from "@/components/notebook/state/runtime-state";
import { beginOidcLogin } from "./oidc-auth";
import { cloudViewerLoadingPolicy } from "./loading-policy";
import { markCloudViewerLoadMilestone } from "./load-milestones";
import { cloudPresenceHasRuntimePeer, cloudPresenceRuntimePeerCount } from "./presence";
import type { ResolvedCell } from "./render-resolution";
import {
  CloudNotebookNotices,
  cloudNotebookHasNotices,
  isTransportReconnectError,
  shouldShowCloudAnonymousViewerAuthNotice,
} from "./notices";
import {
  cloudConnectionDiagnosticBlocksNotebookBody,
  isCloudConnectionAccessDiagnostic,
} from "./connection-diagnostics";
import {
  projectCloudNotebookHeaderChrome,
  projectCloudNotebookViewSurface,
} from "./notebook-view-loading";
import { useOfflineMergeNoticeAutoClear } from "./use-offline-merge-notice";
import { useSustainedReconnecting } from "./use-sustained-reconnecting";
import type { ViewerStatus } from "./notice-types";
import type { CloudNotebookAccessRequest } from "./sharing-client";
import { CloudSharingControls } from "./sharing-controls";
import { createCloudNotebookHost } from "./cloud-notebook-host";
import { cloudResponseError } from "./cloud-response";
import { preloadSiftWasmForCells } from "./sift-preload";
import { cloudSourceLanguage } from "./source-language";
import { clearCloudAppSession, readCloudAppSessionStatus } from "./app-session";
import {
  projectCloudAccessRequestTransition,
  type CloudAccessRequestNoticeProjection,
} from "./cloud-access-request-state";
import {
  cloudNotebookSyncScopeForCatalogAccess,
  createCloudNotebookCatalogAccessLoader,
  type CloudNotebookCatalogAccessLoadResult,
  type CloudNotebookCatalogAccessScope,
} from "./cloud-notebook-catalog-access";
import { applyDocumentTheme, CLOUD_VIEWER_THEME_STORAGE_KEY } from "./theme";
import {
  cloudNotebookModeFromSearch,
  replaceCloudNotebookModeInCurrentUrl,
} from "./cloud-notebook-mode";
import {
  CloudAccessFactsStore,
  cloudCatalogAccessFacts,
  projectCloudAccessLiveRoomPolicy,
  type CloudAccessFactsProjection,
  type CloudAccessSourceFacts,
} from "./cloud-access-facts";
import { useCloudFactsProjection } from "./cloud-facts-react";
import type {
  CloudNotebookUpdateResponse,
  CloudViewerAuthConfig,
  ViewerRuntime,
} from "./cloud-viewer-types";
import {
  useCloudAppSessionBridge,
  useCloudAppSessionStatus,
  useCloudPrototypeAuth,
} from "./use-cloud-auth";
import { useCloudShellCapabilities } from "./use-cloud-shell-capabilities";
import { useCloudWorkstationManager } from "./use-cloud-workstations";
import { CloudNotebookSignInButton } from "./cloud-auth-controls";
import { CloudNotebookEditModeButton } from "./cloud-edit-mode-button";
import { CloudNotebookTitle, cloudNotebookRouteTitle } from "./cloud-notebook-title";
import {
  cloudNotebookCatalogResponseTitle,
  cloudNotebookDocumentTitle,
  cloudNotebookTitleDisplay,
  cloudNotebookUrlAfterRename,
  type CloudNotebookCatalogResponse,
} from "./cloud-notebook-title-state";
import { CloudPresenceStatus } from "./cloud-presence-status";

const cloudNotebookClientLogger: SyncEngineLogger = {
  debug: () => {},
  info: () => {},
  warn: (message: string, ...args: unknown[]) => console.warn(message, ...args),
  error: (message: string, ...args: unknown[]) => console.error(message, ...args),
};

const CLOUD_VIEWER_OUTPUT_IFRAME_ROOT_MARGIN = "400px 0px";
const CLOUD_ACCESS_REQUEST_POLL_INTERVAL_MS = 30_000;
const CLOUD_EMPTY_ROOM_GRACE_MS = 900;

function decodeHashAnchorId(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function shouldPollPendingCloudAccessRequest(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function useCloudAccessFactsProjection(source: CloudAccessSourceFacts): CloudAccessFactsProjection {
  return useCloudFactsProjection(source, (initial) => new CloudAccessFactsStore(initial));
}

async function resolveCloudAppSessionSyncScope(
  loadCatalogAccess: () => Promise<CloudNotebookCatalogAccessLoadResult>,
  selectedMode: NotebookInteractionMode,
): Promise<Exclude<ConnectionScope, "runtime_peer">> {
  try {
    return cloudNotebookSyncScopeForCatalogAccess({
      ...(await loadCatalogAccess()),
      selectedMode,
    });
  } catch (error) {
    console.warn("[notebook-cloud] unable to resolve notebook access scope before sync", error);
  }
  return cloudNotebookSyncScopeForCatalogAccess({
    catalogResolved: false,
    selectedMode,
  });
}

export function NotebookViewer({
  runtime,
  authConfig,
}: {
  runtime: ViewerRuntime;
  authConfig: CloudViewerAuthConfig;
}) {
  const { config } = runtime;
  const routeTitle = useMemo(() => cloudNotebookRouteTitle(), []);
  const [catalogNotebookTitle, setCatalogNotebookTitle] = useState<string | null | undefined>(
    undefined,
  );
  const [notebookTitleSaving, setNotebookTitleSaving] = useState(false);
  const [notebookTitleError, setNotebookTitleError] = useState<string | null>(null);
  const notebookTitle = useMemo(
    () => cloudNotebookTitleDisplay(catalogNotebookTitle, routeTitle),
    [catalogNotebookTitle, routeTitle],
  );
  const loadingPolicy = useMemo(() => cloudViewerLoadingPolicy(config), [config.headsHash]);
  const { resolvedTheme } = useTheme(CLOUD_VIEWER_THEME_STORAGE_KEY);
  const { store: widgetStore } = useWidgetStoreRequired();
  const appSessionStatus = useCloudAppSessionStatus(config.session ?? null);
  const hasAppSession = Boolean(appSessionStatus.session);
  const { authState, authRenewal, refreshAuthState } = useCloudPrototypeAuth(authConfig, {
    appSessionRefreshFallback: true,
    appSessionLoading: appSessionStatus.status === "loading",
    appSession: appSessionStatus.session,
  });
  const authStateRef = useRef(authState);
  useEffect(() => {
    authStateRef.current = authState;
  }, [authState]);
  const appSessionStatusRef = useRef(appSessionStatus);
  useEffect(() => {
    appSessionStatusRef.current = appSessionStatus;
  }, [appSessionStatus]);
  useCloudAppSessionBridge(
    authState,
    appSessionStatus.session,
    appSessionStatus.status === "loading",
    appSessionStatus.refreshAppSessionStatus,
  );
  // Cell focus is owned by the shared cell-ui-state store, not host React state.
  // NotebookView already writes and synchronously flushes the interaction target
  // on user focus (publishInteractionTarget, which carries the real
  // cell/editor/output kind), so its onFocusCell is a no-op here. Routing it
  // through the store would double-write: a transient { kind: "cell" } before the
  // real { kind: "editor" | "output" }. The host only writes the store for
  // *programmatic* focus the controller drives (focus-after-add), which has no
  // publishInteractionTarget of its own; that goes through the set+flush path.
  const focusedCellId = useFocusedCellId();
  const focusCellInStore = useCallback((id: string | null) => {
    setFocusedCellId(id);
    flushCellUIState();
  }, []);
  const handleNotebookViewFocus = useCallback(() => {}, []);
  const { activePanelId: activeRailPanel, collapsed: railCollapsed } = useNotebookRailUiState();
  const [commentsProjection, setCommentsProjection] = useState<CommentsProjection | null>(null);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const handledHeadingHashRef = useRef<string | null>(null);
  const [latestAccessRequest, setLatestAccessRequest] = useState<CloudNotebookAccessRequest | null>(
    null,
  );
  const [catalogAccessScope, setCatalogAccessScope] =
    useState<CloudNotebookCatalogAccessScope | null>(null);
  const [catalogAccessResolved, setCatalogAccessResolved] = useState(false);
  const [catalogAccessLoadFailed, setCatalogAccessLoadFailed] = useState(false);
  const [accessRequestError, setAccessRequestError] = useState<string | null>(null);
  const [selectedInteractionMode, setSelectedInteractionMode] = useState<NotebookInteractionMode>(
    () => cloudNotebookModeFromSearch(window.location.search),
  );
  const [editAccessRequestedByUser, setEditAccessRequestedByUser] = useState(false);
  // Scope resolution reads the latest selected mode at connect time, but
  // access-mode correction itself must not rebuild the live-room callback:
  // viewer-owned `?mode=edit` links are corrected to view mode after access is
  // known, and making that correction a dependency tears the room down.
  const selectedInteractionModeRef = useRef(selectedInteractionMode);
  useEffect(() => {
    selectedInteractionModeRef.current = selectedInteractionMode;
  }, [selectedInteractionMode]);
  const [emptyRoomGraceElapsed, setEmptyRoomGraceElapsed] = useState(false);
  const browserApiAuthState = useMemo(
    () => cloudBrowserApiAuthStateForFetch(authState),
    [
      authState.mode,
      authState.mode === "dev" ? authState.token : null,
      authState.mode === "dev" ? authState.user : null,
      authState.mode === "dev" ? authState.requestedScope : null,
      authState.mode === "dev" ? authState.problem : null,
    ],
  );
  const canUseAuthenticatedCloudApi = cloudBrowserCanUseAuthenticatedApi({
    authState,
    hasAppSession,
  });
  const catalogAccessLoader = useMemo(
    () =>
      createCloudNotebookCatalogAccessLoader({
        notebookId: config.notebookId,
        loadNotebooks: async () => {
          const endpoint = new URL("api/n?limit=100", `${window.location.origin}/`);
          const response = await fetchWithCloudPrototypeAuth(
            endpoint.href,
            {
              cache: "no-store",
              headers: { Accept: "application/json" },
            },
            browserApiAuthState,
          );
          if (!response.ok) {
            throw new Error(`Unable to load notebook catalog: ${response.status}`);
          }
          const body = (await response.json()) as { notebooks?: unknown };
          return Array.isArray(body.notebooks) ? body.notebooks : [];
        },
      }),
    [browserApiAuthState, config.notebookId],
  );
  const catalogAccessFacts = useMemo(
    () =>
      cloudCatalogAccessFacts({
        canUseAuthenticatedCloudApi,
        loadFailed: catalogAccessLoadFailed,
        resolved: catalogAccessResolved,
        scope: catalogAccessScope,
      }),
    [
      canUseAuthenticatedCloudApi,
      catalogAccessLoadFailed,
      catalogAccessResolved,
      catalogAccessScope,
    ],
  );
  useEffect(() => {
    if (!canUseAuthenticatedCloudApi) {
      setCatalogNotebookTitle(undefined);
      setNotebookTitleError(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchWithCloudPrototypeAuth(
          config.catalogEndpoint,
          {
            cache: "no-store",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          },
          browserApiAuthState,
        );
        if (!response.ok) {
          throw await cloudResponseError(response, "Unable to load notebook title");
        }
        const body = (await response.json()) as CloudNotebookCatalogResponse;
        const title = cloudNotebookCatalogResponseTitle(body, config.notebookId);
        if (!cancelled) {
          setCatalogNotebookTitle(title);
          setNotebookTitleError(null);
        }
      } catch (error) {
        if (
          cancelled ||
          (typeof DOMException !== "undefined" &&
            error instanceof DOMException &&
            error.name === "AbortError")
        ) {
          return;
        }
        console.warn("[notebook-cloud] unable to load notebook title", error);
        if (!cancelled) {
          setCatalogNotebookTitle(undefined);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [browserApiAuthState, canUseAuthenticatedCloudApi, config.catalogEndpoint, config.notebookId]);
  const catalogLiveRoomPolicy = useMemo(
    () =>
      projectCloudAccessLiveRoomPolicy({
        canUseAuthenticatedCloudApi,
        catalog: catalogAccessFacts,
      }),
    [canUseAuthenticatedCloudApi, catalogAccessFacts],
  );
  const effectiveLoadingPolicy = useMemo(
    () => ({
      ...loadingPolicy,
      shouldConnectLiveRoom:
        loadingPolicy.shouldConnectLiveRoom && catalogLiveRoomPolicy.shouldConnectLiveRoom,
      initialStatusMessage:
        catalogLiveRoomPolicy.disabledStatus?.message ?? loadingPolicy.initialStatusMessage,
    }),
    [catalogLiveRoomPolicy, loadingPolicy],
  );
  const blobResolver = useMemo(
    () =>
      createNotebookCloudBlobResolver({
        baseUrl: location.href,
        blobBasePath: config.blobBasePath,
        fetchImpl: (input, init) => fetchWithCloudPrototypeAuth(input, init, browserApiAuthState),
        authenticatedBinaryDisplayUrls: true,
      }),
    [browserApiAuthState, config.blobBasePath],
  );
  const preloadSiftWasm = useCallback(
    (nextCells: readonly ResolvedCell[]) => {
      preloadSiftWasmForCells(nextCells, {
        blobBasePath: config.blobBasePath,
        rendererAssetsBasePath: config.rendererAssetsBasePath,
        siftWasmAssetName: config.rendererAssets.siftWasm,
        pageUrl: location.href,
      });
    },
    [config.blobBasePath, config.rendererAssetsBasePath, config.rendererAssets.siftWasm],
  );
  const syncAuthConnectionKey = cloudSyncAuthConnectionKey(authState, {
    hasAppSession,
  });
  const liveRoomDisabledStatus = loadingPolicy.shouldConnectLiveRoom
    ? catalogLiveRoomPolicy.disabledStatus
    : null;
  const resolveSyncAuth = useCallback(
    async (sessionId: string) => {
      const currentAppSessionStatus = appSessionStatusRef.current;
      const appSession =
        currentAppSessionStatus.session ??
        (currentAppSessionStatus.status === "loading"
          ? ((await readCloudAppSessionStatus().catch(() => null))?.session ?? null)
          : null);
      if (appSession) {
        const requestedScope = await resolveCloudAppSessionSyncScope(
          catalogAccessLoader.load,
          selectedInteractionModeRef.current,
        );
        return cloudSyncAuthFromAppSessionCookie({
          requestedScope,
          sessionId,
        });
      }
      return cloudSyncAuthFromPrototypeAuthState(authStateRef.current);
    },
    [catalogAccessLoader, config.notebookId, syncAuthConnectionKey],
  );
  const {
    connectionActorLabel,
    connectionError,
    connectionPeerId,
    connectionPeerLabel,
    connectionScope,
    connectionStatus$,
    liveMaterializedRef,
    liveRuntimeRef,
    notebookLanguageRef,
    notebookMetadata,
    offlineMergeNotice,
    clearOfflineMergeNotice,
    noteLocalCellEdit,
    noteLocalCellDelete,
    presenceStore,
    requestCloudMaterialization,
    retryLiveConnection,
    snapshotResolvedRef,
    status,
    syncHealStalled,
  } = useCloudViewerSession({
    authRenewalKind: authRenewal.kind,
    authState,
    blobResolver,
    config,
    hasAppSession,
    loadingPolicy: effectiveLoadingPolicy,
    liveRoomDisabledStatus,
    preloadSiftWasm,
    resolveSyncAuth,
    widgetStore,
  });
  useEffect(() => {
    const liveRuntime = liveRuntimeRef.current;
    if (!liveRuntime) {
      setCommentsProjection(null);
      return;
    }
    const initialProjection = liveRuntime.handle.get_comments_projection?.() as
      | CommentsProjection
      | undefined;
    setCommentsProjection(initialProjection ?? null);
    const subscription = liveRuntime.engine.commentsProjection$.subscribe((projection) => {
      setCommentsProjection(projection);
      setCommentsError(null);
    });
    return () => subscription.unsubscribe();
  }, [connectionPeerId, liveRuntimeRef]);
  const cloudExecutionStartPromiseRef = useRef<Promise<boolean> | null>(null);
  const cloudNotebookHost = useMemo(
    () =>
      createCloudNotebookHost({
        blobResolver,
        getRuntime: () => liveRuntimeRef.current,
        hasRuntimePeer: () => cloudPresenceHasRuntimePeer(presenceStore.getSnapshot()),
      }),
    [blobResolver, liveRuntimeRef, presenceStore],
  );
  // Sustained-outage legibility: the connection/identity slot stays an 8px
  // dot by design, so once "reconnecting" outlives the debounce the notices
  // stack carries the one calm line (and clears it when the room is back).
  const sustainedReconnecting = useSustainedReconnecting(connectionStatus$);
  // The offline-merge notice is a confirmation, not a warning: it clears on
  // the next user action or a short timeout, never demanding a dismissal.
  useOfflineMergeNoticeAutoClear(offlineMergeNotice, clearOfflineMergeNotice);
  // Shared renderer-bundle state from the root IsolatedRendererProvider
  // (CloudNotebookProviders): drives the single asset-health notice below.
  const isolatedRenderer = useIsolatedRenderer();
  // The provider preloads the bundle for every notebook; only surface its
  // failure when something on screen actually renders isolated outputs.
  const hasIsolatedOutputs = useHasIsolatedOutputs();
  const presenceSnapshot = useSyncExternalStore(
    presenceStore.subscribe,
    presenceStore.getSnapshot,
    presenceStore.getSnapshot,
  );
  const commentAuthorPeers = useMemo(
    () =>
      presenceSnapshot.peers.map((peer) => ({
        participantKey: peer.participantKey,
        label: peer.label,
      })),
    [presenceSnapshot.peers],
  );
  const resolveCloudCommentAuthor = useCallback(
    (actorLabel: string): CommentAuthor => {
      const display = resolveActorDisplay({
        actorLabel,
        peers: commentAuthorPeers,
        source: "cloud",
      });

      return {
        displayName: display.displayName,
        color: display.color,
        isAgent: display.isAgent,
        onBehalfOf: display.onBehalfOf,
        onBehalfOfColor: display.onBehalfOf ? display.color : undefined,
      };
    },
    [commentAuthorPeers],
  );
  const runtimeState = useRuntimeState();
  // Deduplicated shared projection — re-renders only when attachment facts
  // change, not on every runtime tick (was per-host shadow state).
  const workstationAttachment = useWorkstationAttachment();
  const runtimePeerCount = cloudPresenceRuntimePeerCount(presenceSnapshot);
  const runtimePeerAvailable = cloudPresenceHasRuntimePeer(presenceSnapshot);
  const outputHostContext = useMemo<NteractEmbedHostContextPatch>(
    () => ({
      nteract: {
        rendererAssetsBaseUrl: new URL(config.rendererAssetsBasePath, location.href).href,
        siftWasmAssetName: config.rendererAssets.siftWasm,
        outputDocumentUrl: config.outputDocumentBaseUrl
          ? new URL(config.outputDocumentBaseUrl, location.href).href
          : undefined,
      },
    }),
    [config.outputDocumentBaseUrl, config.rendererAssetsBasePath, config.rendererAssets.siftWasm],
  );

  useEffect(() => {
    markCloudViewerLoadMilestone("viewer-start");
  }, []);

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);
  useEffect(() => {
    document.title = cloudNotebookDocumentTitle(notebookTitle.title);
  }, [notebookTitle.title]);
  useEffect(() => {
    replaceCloudNotebookModeInCurrentUrl(selectedInteractionMode);
  }, [selectedInteractionMode]);
  useEffect(() => {
    if (selectedInteractionMode !== "edit") {
      setEditAccessRequestedByUser(false);
    }
  }, [selectedInteractionMode]);

  const getOutlineStatusLabel = useOutlineStatusLabel();
  const notebookViewModel = useNotebookViewModel({
    metadata: notebookMetadata,
    resolveLanguage: cloudSourceLanguage,
    getOutlineStatusLabel,
  });
  const { codeCellCount, outlineItems } = notebookViewModel;
  const notebookCellIds = notebookViewModel.cellIds;
  const activeOutlineItemId = useActiveOutlineItemId(
    outlineItems,
    notebookCellIds,
    !railCollapsed && activeRailPanel === "outline",
  );
  const { selectedOutlineItemId, handleSelectOutlineItem } = useOutlineSelection({
    outlineItems,
    focusedCellId,
    setFocusedCellId,
  });
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
    handleSelectOutlineItem(item);
    navigateNotebookOutlineItem(item, hash, {
      behavior: "auto",
      headingHashTarget: "cell",
    });
  }, [handleSelectOutlineItem, outlineItems]);
  const handleNavigateOutlineItem = useCallback(
    (item: NotebookOutlineItem, href: string) => {
      handleSelectOutlineItem(item);
      return navigateNotebookOutlineItem(item, href, { headingHashTarget: "cell" });
    },
    [handleSelectOutlineItem],
  );
  const handleTogglePackagesRail = useCallback(() => {
    if (activeRailPanel === "packages" && !railCollapsed) {
      setActiveNotebookRailPanel("outline");
      return;
    }
    openNotebookRailPanel("packages");
  }, [activeRailPanel, railCollapsed]);
  const handleOpenMobileRail = useCallback(() => {
    setNotebookRailCollapsed(false);
  }, []);
  const handleOpenWorkstationsRail = useCallback(() => {
    openNotebookRailPanel("workstations");
  }, []);
  const hasBrowserAppIdentity =
    hasAppSession || authState.mode === "dev" || authState.mode === "oidc";
  useEffect(() => {
    if (!canUseAuthenticatedCloudApi) {
      setCatalogAccessScope(null);
      setCatalogAccessResolved(false);
      setCatalogAccessLoadFailed(false);
      return;
    }

    let cancelled = false;
    setCatalogAccessScope(null);
    setCatalogAccessResolved(false);
    setCatalogAccessLoadFailed(false);
    void (async () => {
      try {
        const access = await catalogAccessLoader.load();
        if (!cancelled) {
          setCatalogAccessScope(access.catalogScope);
          setCatalogAccessResolved(access.catalogResolved);
          setCatalogAccessLoadFailed(false);
        }
      } catch {
        if (!cancelled) {
          setCatalogAccessScope(null);
          setCatalogAccessResolved(false);
          setCatalogAccessLoadFailed(true);
        }
        return;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [canUseAuthenticatedCloudApi, catalogAccessLoader]);
  const cloudAccessSourceFacts = useMemo<CloudAccessSourceFacts>(
    () => ({
      canUseAuthenticatedCloudApi,
      catalog: catalogAccessFacts,
      connection: {
        error: connectionError,
        peerId: connectionPeerId,
        scope: connectionScope,
        statusKind: status.kind,
      },
      hasBrowserAppIdentity,
      request: {
        error: accessRequestError,
        latest: latestAccessRequest,
        requestedByUser: editAccessRequestedByUser,
      },
      selectedMode: selectedInteractionMode,
    }),
    [
      accessRequestError,
      canUseAuthenticatedCloudApi,
      catalogAccessFacts,
      connectionError,
      connectionPeerId,
      connectionScope,
      editAccessRequestedByUser,
      hasBrowserAppIdentity,
      latestAccessRequest,
      selectedInteractionMode,
      status.kind,
    ],
  );
  const cloudAccessFacts = useCloudAccessFactsProjection(cloudAccessSourceFacts);
  const {
    accessConnectionScope,
    catalogGrantsDocumentEdit,
    effectiveAccessRequest,
    selectedInteractionModeForAccess,
    shouldLoadOwnEditAccessRequest,
  } = cloudAccessFacts;
  useEffect(() => {
    if (cloudAccessFacts.shouldFallbackEditUrlToView) {
      setSelectedInteractionMode("view");
    }
  }, [cloudAccessFacts.shouldFallbackEditUrlToView]);
  const saveCloudNotebookTitle = useCallback(
    async (nextTitle: string): Promise<boolean> => {
      if (!canUseAuthenticatedCloudApi || !catalogGrantsDocumentEdit || notebookTitleSaving) {
        return false;
      }

      try {
        setNotebookTitleSaving(true);
        setNotebookTitleError(null);
        const response = await fetchWithCloudPrototypeAuth(
          config.catalogEndpoint,
          {
            method: "PATCH",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ title: nextTitle.trim() || null }),
          },
          {
            ...browserApiAuthState,
            requestedScope: "editor",
          },
        );
        if (!response.ok) {
          throw await cloudResponseError(response, "Unable to rename notebook");
        }
        const body = (await response.json()) as CloudNotebookUpdateResponse;
        if (body.ok !== true || body.notebook_id !== config.notebookId) {
          throw new Error("Unable to rename notebook: response shape was invalid");
        }
        setCatalogNotebookTitle(body.title ?? null);
        if (body.viewer_url) {
          const nextHref = cloudNotebookUrlAfterRename(window.location.href, body.viewer_url);
          if (nextHref !== window.location.href) {
            window.history.replaceState(window.history.state, "", nextHref);
          }
        }
        return true;
      } catch (error) {
        setNotebookTitleError(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        setNotebookTitleSaving(false);
      }
    },
    [
      browserApiAuthState,
      canUseAuthenticatedCloudApi,
      catalogGrantsDocumentEdit,
      config.catalogEndpoint,
      config.notebookId,
      notebookTitleSaving,
    ],
  );
  const cloudRuntimeConnectedForStatus = workstationAttachment
    ? workstationAttachmentIsConnected(workstationAttachment)
    : runtimePeerAvailable;
  const cloudRuntimeExecutionAvailableForStatus = workstationAttachment
    ? workstationAttachmentCanExecute(workstationAttachment)
    : runtimePeerAvailable;
  const cloudRuntimeStatus = useMemo<NotebookCommandToolbarStatus | null>(() => {
    if (!cloudRuntimeConnectedForStatus && !cloudRuntimeExecutionAvailableForStatus) {
      return null;
    }
    return projectNotebookCommandRuntimeStatusFromRuntimeState(runtimeState, {
      executionAvailable: cloudRuntimeExecutionAvailableForStatus,
    });
  }, [cloudRuntimeConnectedForStatus, cloudRuntimeExecutionAvailableForStatus, runtimeState]);
  const cloudKernelStatusLabel = cloudRuntimeExecutionAvailableForStatus
    ? typeof cloudRuntimeStatus?.label === "string"
      ? cloudRuntimeStatus.label
      : null
    : null;
  useEffect(() => {
    if (cloudAccessFacts.selectedModeCorrection) {
      setSelectedInteractionMode(cloudAccessFacts.selectedModeCorrection);
    }
  }, [cloudAccessFacts.selectedModeCorrection]);
  const { shellCapabilities, canAcceptCellMutations, editAccessPending } =
    useCloudShellCapabilities({
      accessConnectionScope,
      authState,
      codeCellCount,
      connectionActorLabel,
      connectionError,
      connectionPeerId,
      connectionPeerLabel,
      connectionScope,
      hasAppSession,
      hostCapabilities: config.hostCapabilities,
      kernelStatusLabel: cloudKernelStatusLabel,
      runtimePeerAvailable,
      runtimePeerCount,
      selectedMode: selectedInteractionModeForAccess,
      status,
      workstationAttachment,
    });
  const isPublicViewer =
    shellCapabilities.access.isPublic &&
    shellCapabilities.access.level === "viewer" &&
    connectionScope === "viewer" &&
    Boolean(connectionPeerId);
  const showAnonymousViewerAuthNotice = shouldShowCloudAnonymousViewerAuthNotice({
    authState,
    hasAppSession,
    isPublicViewer,
  });
  const {
    busyWorkstationId,
    canStartSelectedWorkstation,
    onAttachWorkstation,
    onSetDefaultWorkstation,
    onStartSelectedWorkstation,
    onStartPairing,
    onCancelPairing,
    workstationAction,
    workstationPairing,
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
        createCellId: createNotebookCellId,
        syncMode: {
          structure: "scheduleFlush",
          outputs: "scheduleFlush",
          visibility: "scheduleFlush",
        },
        applyMutationEvent: (event) => {
          const liveRuntime = liveRuntimeRef.current;
          if (!liveRuntime) return false;
          const applied = liveRuntime.engine.applyLocalMutationEvent(
            event as Parameters<typeof liveRuntime.engine.applyLocalMutationEvent>[0],
          );
          if (!applied) return false;

          const changeset = (event as { changeset?: CellChangeset }).changeset;
          if (changeset) {
            for (const { cell_id } of changeset.changed) {
              noteLocalCellEdit(cell_id, { discountEcho: true });
            }
            for (const cellId of changeset.added) {
              noteLocalCellEdit(cellId, { discountEcho: true });
            }
            for (const cellId of changeset.removed) {
              noteLocalCellDelete(cellId, { discountEcho: true });
            }
          }
          return true;
        },
        afterMutation: (handle) => {
          const liveRuntime = liveRuntimeRef.current;
          if (liveRuntime && liveRuntime.handle === handle) {
            requestCloudMaterialization(liveRuntime);
          }
        },
        onFocusCell: focusCellInStore,
        logPrefix: "[notebook-cloud]",
      }),
    [
      canWriteCellSource,
      focusCellInStore,
      noteLocalCellDelete,
      noteLocalCellEdit,
      requestCloudMaterialization,
      shellCapabilities.canEditStructure,
    ],
  );
  const handleCloudAddCell = useCallback(
    (type: "code" | "markdown", afterCellId?: string | null) => {
      return cloudNotebookController.addCell(type, afterCellId);
    },
    [cloudNotebookController],
  );
  const handleCloudDeleteCell = useCallback(
    (cellId: string) => {
      // The user's own delete must never read as a collaborator removal in
      // the offline-merge notice.
      noteLocalCellDelete(cellId);
      cloudNotebookController.deleteCell(cellId);
    },
    [cloudNotebookController, noteLocalCellDelete],
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
          logger: cloudNotebookClientLogger,
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
  const canRequestCloudCellExecution =
    canStartSelectedWorkstation && shellCapabilities.canEditCells && canAcceptCellMutations;
  const startCloudExecutionWorkstation = useCallback(async () => {
    if (!onStartSelectedWorkstation) {
      return false;
    }
    if (!cloudExecutionStartPromiseRef.current) {
      cloudExecutionStartPromiseRef.current = onStartSelectedWorkstation({
        message: "Starting compute. Run is queued for the selected workstation.",
      }).finally(() => {
        cloudExecutionStartPromiseRef.current = null;
      });
    }
    return cloudExecutionStartPromiseRef.current;
  }, [onStartSelectedWorkstation]);
  const handleCloudRequestExecuteCell = useCallback(
    (cellId: string) => {
      if (!canRequestCloudCellExecution || !onStartSelectedWorkstation) {
        return;
      }
      const runtimeClient = createCloudNotebookClient("start compute and execute cell");
      if (!runtimeClient) return;

      void (async () => {
        const delivered = await runtimeClient.liveRuntime.engine.flushAndWait();
        if (!delivered) {
          console.warn(
            "[notebook-cloud] start compute and execute request skipped; notebook sync failed",
          );
          return;
        }

        const started = await startCloudExecutionWorkstation();
        if (!started) {
          return;
        }

        await runtimeClient.client.executeCell(cellId);
      })().catch((error: unknown) => {
        console.warn("[notebook-cloud] start compute and execute request failed", error);
      });
    },
    [
      canRequestCloudCellExecution,
      createCloudNotebookClient,
      onStartSelectedWorkstation,
      startCloudExecutionWorkstation,
    ],
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
    void onStartSelectedWorkstation?.().catch((error: unknown) => {
      console.warn("[notebook-cloud] start kernel request failed", error);
    });
  }, [onStartSelectedWorkstation]);
  const handleCloudInterruptRuntime = useCallback(() => {
    const runtimeClient = createCloudNotebookClient("interrupt kernel");
    if (!runtimeClient) return;

    void runtimeClient.client.interruptKernel().catch((error: unknown) => {
      console.warn("[notebook-cloud] interrupt kernel request failed", error);
    });
  }, [createCloudNotebookClient]);
  const handleCloudRestartRuntime = useCallback(() => {
    void onStartSelectedWorkstation?.({
      message: "Restarting compute. Waiting for the workstation to replace the runtime peer.",
      replaceExisting: true,
    }).catch((error: unknown) => {
      console.warn("[notebook-cloud] restart kernel request failed", error);
    });
  }, [onStartSelectedWorkstation]);
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

      await onStartSelectedWorkstation?.({
        message: "Restarting compute. Run all is queued for the replacement runtime.",
        replaceExisting: true,
      });
      await runtimeClient.client.runAllCells();
    })().catch((error: unknown) => {
      console.warn("[notebook-cloud] restart kernel and run all cells request failed", error);
    });
  }, [createCloudNotebookClient, onStartSelectedWorkstation]);
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
  const handleSourceSyncNeeded = useCallback(
    (cellId?: string) => {
      if (!shellCapabilities.canEditCells && !shellCapabilities.canEditMarkdown) return;
      if (cellId) {
        // Offline-merge tracking: the bridge only signals after a real
        // handle mutation, so this is an honest "this cell carried a local
        // edit" fact (counted only while the offline window is open).
        noteLocalCellEdit(cellId);
      }
      liveRuntimeRef.current?.engine.scheduleFlush();
    },
    [shellCapabilities.canEditCells, shellCapabilities.canEditMarkdown, noteLocalCellEdit],
  );
  const canWriteComments = connectionScope === "editor" || connectionScope === "owner";
  const applyLocalCommentEvent = useCallback(
    (event: unknown): boolean => {
      const liveRuntime = liveRuntimeRef.current;
      if (!liveRuntime) {
        setCommentsError("Comments are not connected.");
        return false;
      }
      const applied = liveRuntime.engine.applyLocalMutationEvent(
        event as Parameters<typeof liveRuntime.engine.applyLocalMutationEvent>[0],
      );
      if (!applied) {
        setCommentsError("Unable to update comments.");
        return false;
      }
      setCommentsError(null);
      liveRuntime.engine.scheduleFlush();
      return true;
    },
    [liveRuntimeRef],
  );
  const handleCreateCommentThread = useCallback(
    async (body: string) => {
      if (!canWriteComments) return;
      const liveRuntime = liveRuntimeRef.current;
      if (!liveRuntime || typeof liveRuntime.handle.create_comment_thread !== "function") {
        setCommentsError("Comments are not ready.");
        return;
      }
      try {
        const anchor: CommentAnchor = { kind: "notebook" };
        const event = liveRuntime.handle.create_comment_thread(
          createCloudCommentId("thread"),
          createCloudCommentId("message"),
          anchor,
          body,
          null,
          new Date().toISOString(),
        );
        applyLocalCommentEvent(event);
      } catch (error) {
        setCommentsError(error instanceof Error ? error.message : String(error));
      }
    },
    [applyLocalCommentEvent, canWriteComments, liveRuntimeRef],
  );
  const handleReplyCommentThread = useCallback(
    async (threadId: string, body: string) => {
      if (!canWriteComments) return;
      const liveRuntime = liveRuntimeRef.current;
      if (!liveRuntime || typeof liveRuntime.handle.reply_comment_thread !== "function") {
        setCommentsError("Comments are not ready.");
        return;
      }
      try {
        const event = liveRuntime.handle.reply_comment_thread(
          threadId,
          createCloudCommentId("message"),
          body,
          null,
          new Date().toISOString(),
        );
        applyLocalCommentEvent(event);
      } catch (error) {
        setCommentsError(error instanceof Error ? error.message : String(error));
      }
    },
    [applyLocalCommentEvent, canWriteComments, liveRuntimeRef],
  );
  const handleResolveCommentThread = useCallback(
    async (threadId: string) => {
      if (!canWriteComments) return;
      const liveRuntime = liveRuntimeRef.current;
      if (!liveRuntime || typeof liveRuntime.handle.resolve_comment_thread !== "function") {
        setCommentsError("Comments are not ready.");
        return;
      }
      try {
        const event = liveRuntime.handle.resolve_comment_thread(threadId, new Date().toISOString());
        applyLocalCommentEvent(event);
      } catch (error) {
        setCommentsError(error instanceof Error ? error.message : String(error));
      }
    },
    [applyLocalCommentEvent, canWriteComments, liveRuntimeRef],
  );
  const handleReopenCommentThread = useCallback(
    async (threadId: string) => {
      if (!canWriteComments) return;
      const liveRuntime = liveRuntimeRef.current;
      if (!liveRuntime || typeof liveRuntime.handle.reopen_comment_thread !== "function") {
        setCommentsError("Comments are not ready.");
        return;
      }
      try {
        const event = liveRuntime.handle.reopen_comment_thread(threadId);
        applyLocalCommentEvent(event);
      } catch (error) {
        setCommentsError(error instanceof Error ? error.message : String(error));
      }
    },
    [applyLocalCommentEvent, canWriteComments, liveRuntimeRef],
  );
  const handleFocusCommentAnchor = useCallback(
    (thread: CommentThreadSnapshot) => {
      const cellId = thread.badge_cell_ids[0];
      if (cellId) {
        focusCellInStore(cellId);
      }
    },
    [focusCellInStore],
  );
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
  const beginNotebookAuth = useCallback(async () => {
    const localDevAuth = authConfig.localDev;
    if (localDevAuth) {
      window.location.assign(localDevAuth.authUrl);
      return;
    }
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
      console.warn("[notebook-cloud] sign-in start failed", error);
    }
  }, [authConfig.localDev, authConfig.oidc, resetPrototypeAuth]);
  const applyLatestAccessRequest = useCallback(
    (
      request: CloudNotebookAccessRequest | null,
      options?: { selectedMode?: NotebookInteractionMode },
    ) => {
      setLatestAccessRequest(request);
      const transition = projectCloudAccessRequestTransition({
        accessScope: catalogAccessScope,
        authState: {
          mode: authState.mode,
          requestedScope: authState.requestedScope,
        },
        connectionScope,
        hasAppSession,
        request: catalogGrantsDocumentEdit ? null : request,
        selectedMode: options?.selectedMode ?? selectedInteractionMode,
      });
      if (transition.requestedScope) {
        storeCloudRequestedScope(window.localStorage, transition.requestedScope);
      }
      if (transition.selectedMode) {
        setSelectedInteractionMode(transition.selectedMode);
      }
      if (transition.retryLiveConnection) {
        retryLiveConnection();
      }
      if (transition.refreshPrototypeAuth) {
        refreshAuthState();
      }
    },
    [
      authState.mode,
      authState.requestedScope,
      catalogAccessScope,
      catalogGrantsDocumentEdit,
      connectionScope,
      hasAppSession,
      refreshAuthState,
      retryLiveConnection,
      selectedInteractionMode,
    ],
  );
  const loadOwnAccessRequest = useCallback(
    async (options?: { signal?: AbortSignal }) => {
      if (!shouldLoadOwnEditAccessRequest) {
        return;
      }

      try {
        const response = await fetchWithCloudPrototypeAuth(
          config.accessRequestsEndpoint,
          { headers: { Accept: "application/json" }, signal: options?.signal },
          browserApiAuthState,
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
      browserApiAuthState,
      config.accessRequestsEndpoint,
      shouldLoadOwnEditAccessRequest,
    ],
  );
  useEffect(() => {
    if (!shouldLoadOwnEditAccessRequest) {
      setLatestAccessRequest(null);
      return;
    }
    const controller = new AbortController();
    void loadOwnAccessRequest({ signal: controller.signal });
    return () => controller.abort();
  }, [loadOwnAccessRequest, shouldLoadOwnEditAccessRequest]);
  useEffect(() => {
    if (effectiveAccessRequest?.status !== "pending" || !shouldLoadOwnEditAccessRequest) {
      return;
    }

    const controller = new AbortController();
    let pollInFlight = false;
    const poll = () => {
      if (!shouldPollPendingCloudAccessRequest() || pollInFlight) {
        return;
      }
      pollInFlight = true;
      void loadOwnAccessRequest({ signal: controller.signal }).finally(() => {
        pollInFlight = false;
      });
    };
    const intervalId = window.setInterval(() => {
      poll();
    }, CLOUD_ACCESS_REQUEST_POLL_INTERVAL_MS);
    const handleVisibilityChange = () => {
      poll();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      controller.abort();
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [effectiveAccessRequest?.status, loadOwnAccessRequest, shouldLoadOwnEditAccessRequest]);
  const requestCloudEditAccess = useCallback(() => {
    void (async () => {
      setEditAccessRequestedByUser(true);
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
          browserApiAuthState,
        );
        if (!response.ok) {
          throw await cloudResponseError(response, "Unable to request edit access");
        }
        const body = (await response.json()) as {
          access_request?: CloudNotebookAccessRequest | null;
          access_status?: string;
        };
        if (body.access_status === "granted") {
          applyLatestAccessRequest(
            {
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
            },
            { selectedMode: "edit" },
          );
          return;
        }
        applyLatestAccessRequest(body.access_request ?? null, { selectedMode: "edit" });
      } catch (error) {
        setAccessRequestError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [
    applyLatestAccessRequest,
    browserApiAuthState,
    config.accessRequestsEndpoint,
    config.notebookId,
  ]);
  const shouldShowPackageEnvironmentSummary =
    shellCapabilities.canExecute || shellCapabilities.canManagePackages;
  const shouldShowCloudWorkstationsPanel =
    shellCapabilities.access.level === "owner" &&
    shellCapabilities.auth.canUseAuthenticatedIdentity;
  useEffect(() => {
    if (!shouldShowCloudWorkstationsPanel && activeRailPanel === "workstations") {
      setActiveNotebookRailPanel("outline");
    }
  }, [activeRailPanel, shouldShowCloudWorkstationsPanel]);
  const toolbarAddAfterCellId =
    focusedCellId ?? notebookCellIds[notebookCellIds.length - 1] ?? null;
  const publicNotebookLink = useMemo(
    () => new URL(window.location.pathname, window.location.origin).href,
    [],
  );
  const renderedActiveRailPanel =
    !shouldShowCloudWorkstationsPanel && activeRailPanel === "workstations"
      ? "outline"
      : activeRailPanel;
  const commentsPanel = (
    <NotebookCommentsPanel
      projection={commentsProjection}
      readOnly={!canWriteComments}
      statusMessage={commentsProjection ? null : "Syncing comments..."}
      errorMessage={commentsError}
      onCreateThread={canWriteComments ? handleCreateCommentThread : undefined}
      onReplyThread={canWriteComments ? handleReplyCommentThread : undefined}
      onResolveThread={canWriteComments ? handleResolveCommentThread : undefined}
      onReopenThread={canWriteComments ? handleReopenCommentThread : undefined}
      onFocusThreadAnchor={handleFocusCommentAnchor}
      resolveCommentAuthor={resolveCloudCommentAuthor}
    />
  );
  const rail = (
    <NotebookDocumentRail
      viewModel={notebookViewModel}
      activePanelId={renderedActiveRailPanel}
      collapsed={railCollapsed}
      outlineCellIds={notebookCellIds}
      activeOutlineItemId={activeOutlineItemId}
      selectedOutlineItemId={selectedOutlineItemId}
      selectedOutlineCellId={focusedCellId}
      commentsPanel={commentsPanel}
      workstationsPanel={
        shouldShowCloudWorkstationsPanel ? (
          <NotebookWorkstationsPanel
            capabilities={shellCapabilities}
            selection={workstationSelection}
            statusMessage={workstationPanelStatusMessage}
            busyWorkstationId={busyWorkstationId}
            onAttachWorkstation={onAttachWorkstation}
            onSetDefaultWorkstation={onSetDefaultWorkstation}
            pairing={workstationPairing}
            onStartPairing={onStartPairing}
            onCancelPairing={onCancelPairing}
          />
        ) : undefined
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
      onActivePanelChange={setActiveNotebookRailPanel}
      onCollapsedChange={setNotebookRailCollapsed}
      onSelectOutlineItem={handleSelectOutlineItem}
      onNavigateOutlineItem={handleNavigateOutlineItem}
      className="cloud-notebook-rail"
    />
  );

  const showCloudCommandToolbar = shouldShowNotebookDocumentCommandToolbar(shellCapabilities, {
    reserve: editAccessPending,
  });
  const notebookBodyAccessBlocked = cloudConnectionDiagnosticBlocksNotebookBody(connectionError);
  const notebookHeaderChrome = projectCloudNotebookHeaderChrome({
    bodyAccessBlocked: notebookBodyAccessBlocked,
    liveRoomAccessPending: liveRoomDisabledStatus?.kind === "loading",
  });

  const toolbar = (
    <NotebookDocumentToolbar
      capabilities={shellCapabilities}
      frameClassName="z-20"
      headerClassName="cloud-room-toolbar"
      presence={
        <CloudNotebookTitle
          title={notebookTitle}
          renameTitle={catalogNotebookTitle?.trim() ?? ""}
          canRename={catalogAccessResolved && catalogGrantsDocumentEdit}
          renameSaving={notebookTitleSaving}
          renameError={notebookTitleError}
          onRename={saveCloudNotebookTitle}
        />
      }
      utilityControls={
        notebookHeaderChrome.showPresenceStatus ? (
          <CloudPresenceStatus connectionError={connectionError} store={presenceStore} />
        ) : null
      }
      authControls={
        !showAnonymousViewerAuthNotice &&
        shouldShowCloudHeaderSignIn(authState, {
          appSessionLoading: appSessionStatus.status === "loading",
          hasAppSession,
        }) ? (
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
          hasAppSession={hasAppSession}
          interaction={shellCapabilities.interaction ?? null}
          accessLevel={shellCapabilities.access.level}
          accessPending={editAccessPending}
          reconnecting={sustainedReconnecting}
          onModeChange={setSelectedInteractionMode}
          onRequestEditAccess={requestCloudEditAccess}
        />
      }
      identityControls={
        // Connection/identity slot: self-identity avatar + connectivity dot
        // (the stable bridge survives transport replacement; the dot keeps
        // frozen runtime chrome interpretable while reconnecting).
        notebookHeaderChrome.showConnectionIdentity ? (
          <NotebookConnectionIdentity
            capabilities={shellCapabilities}
            connectionStatus$={connectionStatus$}
          />
        ) : null
      }
      reserveCommandToolbar={editAccessPending}
      commandToolbar={{
        leadingControls: (
          <button
            type="button"
            className="cloud-mobile-rail-toggle hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Open notebook panels"
            title="Notebook panels"
            onClick={handleOpenMobileRail}
          >
            <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
          </button>
        ),
        runtime: toolbarRuntime,
        runtimeTarget: shellCapabilities.runtime.target ?? null,
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
  const signedOutNotebookSignInRequired =
    Boolean(authConfig.localDev || authConfig.oidc) &&
    appSessionStatus.status !== "loading" &&
    !hasAppSession &&
    authState.mode === "anonymous" &&
    !isPublicViewer &&
    !notebookHasReadableSnapshot &&
    status.kind === "loading" &&
    Boolean(connectionError && isTransportReconnectError(connectionError));
  const notebookViewSurface = projectCloudNotebookViewSurface({
    bodyAccessBlocked: notebookBodyAccessBlocked,
    cellCount: notebookCellIds.length,
    canEditStructure: shellCapabilities.canEditStructure,
    connectionError,
    editAccessPending,
    emptyRoomGraceElapsed,
    hasAccessDiagnostic: isCloudConnectionAccessDiagnostic(connectionError),
    hasReadableSnapshot: notebookHasReadableSnapshot,
    liveMaterialized: liveMaterializedRef.current,
    status,
  });
  const notebookViewIsLoading = notebookViewSurface.isLoading;
  const noticeStatus: ViewerStatus =
    notebookViewIsLoading && (status.kind === "ready" || status.kind === "empty")
      ? { kind: "loading", message: "Preparing notebook view..." }
      : status;
  const accessRequestNotice = cloudAccessRequestNotice(cloudAccessFacts.accessRequestNotice);
  // Asset health is its own quiet surface: N identical renderer failures
  // collapse into ONE notice (the provider state is module-level shared)
  // plus per-output fallbacks. It never feeds the connection dot or
  // CloudConnectionStatusBridge — that bridge models room transport health.
  // `lastError` keeps the notice steady through an in-flight retry (no
  // per-click flap); the presence gate keeps pure-markdown/text notebooks
  // free of a warning about outputs they do not have.
  const rendererAssetError = hasIsolatedOutputs
    ? (isolatedRenderer.error ?? isolatedRenderer.lastError)
    : null;
  const hasNotices = cloudNotebookHasNotices({
    authState,
    authRenewal,
    connectionError,
    diagnostics: accessRequestNotice,
    hasAppSession,
    isPublicViewer,
    hasReadableSnapshot: notebookHasReadableSnapshot,
    signInRequired: signedOutNotebookSignInRequired,
    offlineMergeNotice,
    rendererAssetError,
    sustainedReconnecting,
    syncHealStalled,
    status: noticeStatus,
  });
  const notices = hasNotices ? (
    <CloudNotebookNotices
      authState={authState}
      authRenewal={authRenewal}
      connectionError={connectionError}
      diagnostics={accessRequestNotice}
      hasAppSession={hasAppSession}
      isPublicViewer={isPublicViewer}
      hasReadableSnapshot={notebookHasReadableSnapshot}
      signInRequired={signedOutNotebookSignInRequired}
      offlineMergeNotice={offlineMergeNotice}
      rendererAssetError={rendererAssetError}
      sustainedReconnecting={sustainedReconnecting}
      syncHealStalled={syncHealStalled}
      status={noticeStatus}
      onResetAuth={resetPrototypeAuth}
      onRetryConnection={retryLiveConnection}
      onRetryRendererAssets={isolatedRenderer.retry}
      onSignInAgain={authConfig.localDev || authConfig.oidc ? beginNotebookAuth : undefined}
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
        <h1 className="sr-only">{notebookTitle.title}</h1>

        <PresenceValueProvider value={cloudPresenceContext}>
          <CrdtBridgeProvider
            getHandle={getLiveNotebookHandle}
            canWriteSource={canWriteCellSource}
            onSyncNeeded={handleSourceSyncNeeded}
            localActor={connectionActorLabel ?? ""}
          >
            {notebookViewSurface.shouldRenderNotebookView ? (
              <NotebookView
                cellIds={notebookCellIds}
                isLoading={notebookViewIsLoading}
                capabilities={shellCapabilities}
                canAcceptCellMutations={canAcceptCellMutations}
                runtime={notebookLanguageRef.current === "deno" ? "deno" : "python"}
                sessionRuntimeState={connectionError ? "error" : "ready"}
                onFocusCell={handleNotebookViewFocus}
                onExecuteCell={handleCloudExecuteCell}
                onRequestExecuteCell={
                  canRequestCloudCellExecution ? handleCloudRequestExecuteCell : undefined
                }
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
            ) : null}
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

function createCloudCommentId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function cloudAccessRequestNotice(
  projection: CloudAccessRequestNoticeProjection | null,
): ReactNode {
  if (!projection) {
    return null;
  }

  if (projection.kind === "error") {
    return (
      <NotebookNotice
        tone={projection.tone}
        icon={<AlertCircle className="h-4 w-4" />}
        title={projection.title}
      >
        {projection.message}
      </NotebookNotice>
    );
  }

  if (projection.kind === "pending") {
    return (
      <NotebookNotice
        tone={projection.tone}
        icon={<Loader2 className="h-4 w-4 animate-spin" />}
        title={projection.title}
      >
        {projection.message}
      </NotebookNotice>
    );
  }

  if (projection.kind === "approved") {
    return (
      <NotebookNotice
        tone={projection.tone}
        icon={<Check className="h-4 w-4" />}
        title={projection.title}
      >
        {projection.message}
      </NotebookNotice>
    );
  }

  if (projection.kind === "denied") {
    return (
      <NotebookNotice
        tone={projection.tone}
        icon={<X className="h-4 w-4" />}
        title={projection.title}
      >
        {projection.message}
      </NotebookNotice>
    );
  }

  return (
    <NotebookNotice
      tone={projection.tone}
      icon={<AlertCircle className="h-4 w-4" />}
      title={projection.title}
    >
      {projection.message}
    </NotebookNotice>
  );
}
