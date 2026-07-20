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
import { AlertCircle, Check, Info, Loader2, LogIn, PanelLeftOpen, X } from "lucide-react";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import {
  useHasIsolatedOutputs,
  useIsolatedRenderer,
} from "@/components/isolated/isolated-renderer-context";
import type { NotebookRailPanelId } from "@/components/notebook-rail";
import { NotebookNotice } from "@/components/notebook/NotebookNotice";
import {
  markdownProjectionMatchesSource,
  renderedTextForSourceRange,
  resolveMarkdownProjection,
} from "@/lib/markdown-projection";
import {
  NotebookAccessGate,
  NotebookConnectionIdentity,
  NotebookCommentsPanel,
  NotebookDocumentToolbar,
  navigateNotebookOutlineItem,
  NotebookDocumentRail,
  NotebookDocumentShell,
  NotebookPackageSummaryPanel,
  NotebookWorkstationsPanel,
  ComputeDisconnectedNotice,
  KernelLaunchErrorBanner,
  isRuntimePeerDisconnectedErrorDetails,
  projectNotebookCommandRuntimeStatusFromRuntimeState,
  shouldShowKernelLaunchErrorBanner,
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
  type NotebookCommentDraftTarget,
} from "@/components/notebook";
import { resolveCommentsUiSurface } from "@/components/notebook/comments-ui-gate";
import {
  openNotebookRailPanel,
  setActiveNotebookRailPanel,
  setNotebookRailCollapsed,
  useNotebookRailUiState,
} from "@/components/notebook/state/rail-ui-state";
import {
  outputCommentAnchorMatchesLiveState,
  useDemoteDetachedOutputCommentThreads,
} from "@/components/notebook/output-comment-demotion";
import { useWidgetStoreRequired } from "@/components/widgets/widget-store-context";
import { useTheme } from "@/hooks/useTheme";
import { EnvironmentSummary } from "@/components/environment";
import {
  colorForActorIdentity,
  contrastColorForActorIdentity,
  NotebookClient,
  workstationAttachmentCanExecute,
  workstationAttachmentIsConnected,
  type ActorDisplay,
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
  shouldShowCloudHeaderSignIn,
} from "./collaborator-auth";
import type { ConnectionScope } from "../src/auth-shared";

import { useCloudViewerSession } from "./cloud-viewer-session";
import { NotebookView } from "../../notebook/src/notebook-surface";
import { InlineCommentComposer } from "../../notebook/src/components/InlineCommentComposer";
import {
  setSourceCommentThreads,
  type SourceCommentThread,
} from "../../notebook/src/lib/comment-highlights";
import {
  resolveSourceRangeAnchor,
  type OutputCommentAnchor,
  type SourceCommentSelectionRect,
  type SourceRangeCommentAnchor,
} from "../../notebook/src/lib/comment-source-anchor";
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
import { commentAuthorActorLabels } from "./comment-author-profiles";
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
import { CloudSharingControls } from "./sharing-controls";
import { createCloudNotebookHost } from "./cloud-notebook-host";
import { cloudResponseError } from "./cloud-response";
import { preloadSiftWasmForCells } from "./sift-preload";
import { cloudSourceLanguage } from "./source-language";
import { clearCloudAppSession, readCloudAppSessionStatus } from "./app-session";
import type { CloudAccessRequestNoticeProjection } from "./cloud-access-request-state";
import {
  cloudNotebookCatalogAccessFromCatalogResponse,
  cloudNotebookSyncScopeForCatalogAccess,
  createCloudNotebookCatalogAccessLoader,
} from "./cloud-notebook-catalog-access";
import { applyDocumentTheme, CLOUD_VIEWER_THEME_STORAGE_KEY } from "./theme";
import { replaceCloudNotebookModeInCurrentUrl } from "./cloud-notebook-mode";
import {
  CloudAccessFactsStore,
  type CloudAccessFactsProjection,
  type CloudAccessSourceFacts,
  type CloudCatalogAccessFacts,
} from "./cloud-access-facts";
import { useCloudFactsProjection } from "./cloud-facts-react";
import type {
  CloudNotebookUpdateResponse,
  CloudViewerAuthConfig,
  ViewerRuntime,
} from "./cloud-viewer-types";
import { useCloudAuthStore } from "./cloud-auth-context";
import { useCloudStores } from "./cloud-stores-context";
import {
  useBrowserApiAuthState,
  useCloudAppSession,
  useCloudAuthRenewal,
  useCloudAuthState,
  useCloudSyncAuthConnectionKey,
} from "./use-cloud-auth-store";
import {
  useCloudAccessRequestController,
  useCloudAccessRequestFacts,
  useCloudSelectedMode,
} from "./use-cloud-access-request-controller";
import {
  useCloudCatalogAccessFacts,
  useCloudCatalogController,
  useCloudCatalogLiveRoomPolicy,
  useCloudNotebookTitle,
  useCloudNotebookTitleError,
} from "./use-cloud-catalog-store";
import {
  useCloudUserProfiles,
  useCloudUserStoreController,
  useResolvedActorProfile,
} from "./use-cloud-user-store";
import { useCloudShellCapabilities } from "./use-cloud-shell-capabilities";
import { useCloudWorkstationManager } from "./use-cloud-workstations";
import { cloudSignInMethodForConfig, CloudNotebookSignInButton } from "./cloud-auth-controls";
import { CloudNotebookEditModeButton } from "./cloud-edit-mode-button";
import { CloudNotebookTitle, cloudNotebookRouteTitle } from "./cloud-notebook-title";
import {
  cloudNotebookDocumentTitle,
  cloudNotebookGatedTitle,
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
const CLOUD_EMPTY_ROOM_GRACE_MS = 900;

function mapToCommentAuthor(display: ActorDisplay): CommentAuthor {
  return {
    displayName: display.displayName,
    color: display.color,
    imageUrl: display.imageUrl,
    isAgent: display.isAgent,
    onBehalfOf: display.onBehalfOf,
    onBehalfOfColor: display.onBehalfOfColor,
  };
}

function decodeHashAnchorId(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function useCloudAccessFactsProjection(source: CloudAccessSourceFacts): CloudAccessFactsProjection {
  return useCloudFactsProjection(source, (initial) => new CloudAccessFactsStore(initial));
}

function resolveCloudAppSessionSyncScope(
  catalog: CloudCatalogAccessFacts,
  selectedMode: NotebookInteractionMode,
): Exclude<ConnectionScope, "runtime_peer"> {
  return cloudNotebookSyncScopeForCatalogAccess({
    catalogResolved: catalog.status === "ready",
    catalogScope: catalog.scope,
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
  // Store actions and snapshot reads below resolve through their consumption
  // contexts (the singletons by default) so provider overrides route this
  // component to the same instances it reads and mutates.
  const auth = useCloudAuthStore();
  const { accessRequest, catalog, user } = useCloudStores();
  const routeTitle = useMemo(() => cloudNotebookRouteTitle(), []);
  const [notebookTitleSaving, setNotebookTitleSaving] = useState(false);
  const loadingPolicy = useMemo(() => cloudViewerLoadingPolicy(config), [config.headsHash]);
  const { resolvedTheme } = useTheme(CLOUD_VIEWER_THEME_STORAGE_KEY);
  const commentsUiEnabled = config.featureFlags?.enable_comments === true;
  const { store: widgetStore } = useWidgetStoreRequired();
  // Selected interaction mode and the user's edit-access request are owned by the
  // access-request store; this component reads them through its domain hooks and
  // writes them through store actions (setSelectedMode, requestEditAccess, reset).
  const selectedInteractionMode = useCloudSelectedMode();
  const accessRequestFacts = useCloudAccessRequestFacts();
  const handleSelectInteractionMode = useCallback(
    (mode: NotebookInteractionMode) => {
      accessRequest.setSelectedMode(mode);
    },
    [accessRequest],
  );
  const appSessionStatus = useCloudAppSession();
  const hasAppSession = Boolean(appSessionStatus.session);
  const authState = useCloudAuthState();
  const authRenewal = useCloudAuthRenewal();
  const refreshAuthState = useCallback(() => {
    auth.refreshAuthState();
  }, [auth]);
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
  const [commentDraftTarget, setCommentDraftTarget] = useState<NotebookCommentDraftTarget | null>(
    null,
  );
  const [sourceCommentRequest, setSourceCommentRequest] = useState<{
    anchor: SourceRangeCommentAnchor;
    rect: SourceCommentSelectionRect;
    quote?: string | null;
  } | null>(null);
  const [commentFocus, setCommentFocus] = useState<{ threadId: string; nonce: number } | null>(
    null,
  );
  const [dismissedLaunchError, setDismissedLaunchError] = useState<string | null>(null);
  const handledHeadingHashRef = useRef<string | null>(null);
  const [emptyRoomGraceElapsed, setEmptyRoomGraceElapsed] = useState(false);
  const browserApiAuthState = useBrowserApiAuthState();
  const canUseAuthenticatedCloudApi = cloudBrowserCanUseAuthenticatedApi({
    authState,
    hasAppSession,
  });
  const catalogAccessLoader = useMemo(
    () =>
      createCloudNotebookCatalogAccessLoader({
        notebookId: config.notebookId,
        loadCatalogAccess: async () => {
          const response = await fetchWithCloudPrototypeAuth(
            config.catalogEndpoint,
            {
              cache: "no-store",
              headers: { Accept: "application/json" },
            },
            browserApiAuthState,
          );
          if (!response.ok) {
            throw await cloudResponseError(response, "Unable to load notebook catalog");
          }
          return cloudNotebookCatalogAccessFromCatalogResponse(
            (await response.json()) as CloudNotebookCatalogResponse,
            config.notebookId,
          );
        },
      }),
    [browserApiAuthState, config.catalogEndpoint, config.notebookId],
  );
  // Catalog access and the notebook title are owned by the catalog store. The
  // loader is host-built (it carries the browser API auth identity); the store
  // drives the fetch, projects the access facts and live-room policy, and is the
  // single writer of the title. `loadCatalogAccess` ignores the abort signal to
  // match the loader's coalescing contract; fetchLatest's switchMap drops the
  // superseded result.
  const loadCatalogAccess = useCallback(
    (_signal: AbortSignal) => catalogAccessLoader.load(),
    [catalogAccessLoader],
  );
  useCloudCatalogController({
    canUseAuthenticatedCloudApi,
    loadCatalogAccess,
    initialCatalogAccess: config.initialCatalogAccess,
  });
  useCloudUserStoreController(config.authorProfilesEndpoint ?? null);
  const catalogAccessFacts = useCloudCatalogAccessFacts();
  const catalogAccessScope = catalogAccessFacts.scope;
  const catalogAccessResolved = catalogAccessFacts.status === "ready";
  const catalogLiveRoomPolicy = useCloudCatalogLiveRoomPolicy();
  const catalogNotebookTitle = useCloudNotebookTitle();
  const notebookTitleError = useCloudNotebookTitleError();
  const notebookTitle = useMemo(
    () => cloudNotebookTitleDisplay(catalogNotebookTitle, routeTitle),
    [catalogNotebookTitle, routeTitle],
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
  const syncAuthConnectionKey = useCloudSyncAuthConnectionKey();
  const liveRoomDisabledStatus = loadingPolicy.shouldConnectLiveRoom
    ? catalogLiveRoomPolicy.disabledStatus
    : null;
  const resolveSyncAuth = useCallback(
    async (sessionId: string) => {
      const currentAppSessionStatus = auth.appSessionSnapshot;
      const appSession =
        currentAppSessionStatus.session ??
        (currentAppSessionStatus.status === "loading"
          ? ((await readCloudAppSessionStatus().catch(() => null))?.session ?? null)
          : null);
      if (appSession) {
        const requestedScope = resolveCloudAppSessionSyncScope(
          catalog.catalogAccessFactsSnapshot,
          accessRequest.selectedModeSnapshot,
        );
        return cloudSyncAuthFromAppSessionCookie({
          requestedScope,
          sessionId,
        });
      }
      return cloudSyncAuthFromPrototypeAuthState(auth.authSnapshot);
    },
    [accessRequest, auth, catalog, config.notebookId, syncAuthConnectionKey],
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
  useEffect(
    () => user.connectPresence(presenceStore, () => auth.authSnapshot),
    [auth, presenceStore, user],
  );
  const selfProfile = useResolvedActorProfile(connectionActorLabel);
  useEffect(() => {
    if (!connectionActorLabel || !config.authorProfilesEndpoint) {
      return;
    }
    user.requestResolve([connectionActorLabel]);
  }, [config.authorProfilesEndpoint, connectionActorLabel, user]);
  const selfDisplay = useMemo(() => {
    const label = selfProfile?.displayName?.trim() || null;
    const imageUrl = selfProfile?.avatarUrl?.trim() || null;
    if (!label && !imageUrl) {
      return undefined;
    }
    return { label, imageUrl };
  }, [connectionActorLabel, selfProfile?.avatarUrl, selfProfile?.displayName]);
  // Mirror the desktop app: expose the local author's comment color and a
  // legible foreground as CSS vars the shared affordance and composer styles
  // read. The cloud viewer previously set neither, so cloud create surfaces fell
  // back to the neutral --primary.
  useEffect(() => {
    if (!connectionActorLabel) return;
    const color = colorForActorIdentity(connectionActorLabel);
    const contrast = contrastColorForActorIdentity(connectionActorLabel);
    document.documentElement.style.setProperty("--comment-author-color", color);
    document.documentElement.style.setProperty("--comment-author-contrast", contrast);
    return () => {
      document.documentElement.style.removeProperty("--comment-author-color");
      document.documentElement.style.removeProperty("--comment-author-contrast");
    };
  }, [connectionActorLabel]);
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
  const commentAuthorLabels = useMemo(
    () => commentAuthorActorLabels(commentsProjection),
    [commentsProjection],
  );
  const commentAuthorLabelsKey = commentAuthorLabels.join("\u0000");
  const profilesSnapshot = useCloudUserProfiles();
  useEffect(() => {
    if (commentAuthorLabelsKey === "") {
      return;
    }
    user.requestResolve(commentAuthorLabels);
  }, [commentAuthorLabels, commentAuthorLabelsKey, config.authorProfilesEndpoint, user]);
  const resolveCloudCommentAuthor = useCallback(
    (actorLabel: string): CommentAuthor => mapToCommentAuthor(user.resolve(actorLabel)),
    [profilesSnapshot, user],
  );
  const resolveCloudPresenceActor = useCallback(
    (actorLabel: string): ActorDisplay => user.resolve(actorLabel),
    [profilesSnapshot, user],
  );
  const runtimeState = useRuntimeState();
  const cloudKernelLifecycle = runtimeState.kernel.lifecycle;
  const cloudKernelErrorDetails =
    runtimeState.kernel.error_details && runtimeState.kernel.error_details.length > 0
      ? runtimeState.kernel.error_details
      : null;
  const cloudKernelErrorReason = runtimeState.kernel.error_reason;
  useEffect(() => {
    if (cloudKernelLifecycle.lifecycle !== "Error") {
      setDismissedLaunchError(null);
    }
  }, [cloudKernelLifecycle.lifecycle]);
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

  const getOutlineStatusLabel = useOutlineStatusLabel();
  const notebookViewModel = useNotebookViewModel({
    metadata: notebookMetadata,
    resolveLanguage: cloudSourceLanguage,
    getOutlineStatusLabel,
    includeDocumentAnchors: true,
  });
  const { codeCellCount, documentAnchors, outlineItems } = notebookViewModel;
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
      documentAnchors,
      headingHashTarget: "cell",
    });
  }, [documentAnchors, handleSelectOutlineItem, outlineItems]);
  const handleNavigateOutlineItem = useCallback(
    (item: NotebookOutlineItem, href: string) => {
      handleSelectOutlineItem(item);
      return navigateNotebookOutlineItem(item, href, {
        documentAnchors,
        headingHashTarget: "cell",
      });
    },
    [documentAnchors, handleSelectOutlineItem],
  );
  const handleTogglePackagesRail = useCallback(() => {
    if (activeRailPanel === "packages" && !railCollapsed) {
      setActiveNotebookRailPanel("outline");
      return;
    }
    openNotebookRailPanel("packages");
  }, [activeRailPanel, railCollapsed]);
  const handleRailPanelChange = useCallback(
    (panelId: NotebookRailPanelId) => {
      if (!commentsUiEnabled && panelId === "comments") return;
      setActiveNotebookRailPanel(panelId);
    },
    [commentsUiEnabled],
  );
  const handleOpenMobileRail = useCallback(() => {
    setNotebookRailCollapsed(false);
  }, []);
  const handleOpenWorkstationsRail = useCallback(() => {
    openNotebookRailPanel("workstations");
  }, []);
  const hasBrowserAppIdentity =
    hasAppSession || authState.mode === "dev" || authState.mode === "oidc";
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
      request: accessRequestFacts,
      selectedMode: selectedInteractionMode,
    }),
    [
      accessRequestFacts,
      canUseAuthenticatedCloudApi,
      catalogAccessFacts,
      connectionError,
      connectionPeerId,
      connectionScope,
      hasBrowserAppIdentity,
      selectedInteractionMode,
      status.kind,
    ],
  );
  const cloudAccessFacts = useCloudAccessFactsProjection(cloudAccessSourceFacts);
  const { accessConnectionScope, catalogGrantsDocumentEdit, selectedInteractionModeForAccess } =
    cloudAccessFacts;
  // The access-request store owns the poll, the mode corrections, and the
  // loaded-request transition. It reads this gate/context through the controller
  // seam; connection facts stay React-owned this branch (Phase 6 folds them in).
  useCloudAccessRequestController({
    facts: cloudAccessFacts,
    browserAuth: browserApiAuthState,
    authState: { mode: authState.mode, requestedScope: authState.requestedScope },
    hasAppSession,
    connectionScope,
    catalogAccessScope,
    endpoint: config.accessRequestsEndpoint,
    notebookId: config.notebookId,
    onRetryLiveConnection: retryLiveConnection,
    onRefreshAuth: refreshAuthState,
  });
  const saveCloudNotebookTitle = useCallback(
    async (nextTitle: string): Promise<boolean> => {
      if (!canUseAuthenticatedCloudApi || !catalogGrantsDocumentEdit || notebookTitleSaving) {
        return false;
      }

      try {
        setNotebookTitleSaving(true);
        catalog.clearTitleError();
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
        catalog.applyTitleSaved(body.title ?? null);
        if (body.viewer_url) {
          const nextHref = cloudNotebookUrlAfterRename(window.location.href, body.viewer_url);
          if (nextHref !== window.location.href) {
            window.history.replaceState(window.history.state, "", nextHref);
          }
        }
        return true;
      } catch (error) {
        catalog.applyTitleSaveFailure(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        setNotebookTitleSaving(false);
      }
    },
    [
      browserApiAuthState,
      canUseAuthenticatedCloudApi,
      catalog,
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
    ? workstationAttachmentCanExecute(workstationAttachment) && runtimePeerAvailable
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
  const { shellCapabilities, canAcceptCellMutations, editAccessPending } =
    useCloudShellCapabilities({
      accessConnectionScope,
      authState,
      codeCellCount,
      selfDisplay,
      connectionActorLabel,
      connectionError,
      connectionPeerId,
      connectionPeerLabel,
      connectionScope,
      hasAppSession,
      hostCapabilities: config.hostCapabilities,
      kernelStatusLabel: cloudKernelStatusLabel,
      runtimeLastSeenAt: runtimeState.kernel.last_seen,
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
  useEffect(() => {
    if (!canWriteComments) {
      setCommentDraftTarget(null);
      setSourceCommentRequest(null);
    }
  }, [canWriteComments]);

  const refreshCloudCommentsProjection = useCallback(() => {
    const liveRuntime = liveRuntimeRef.current;
    const projection = liveRuntime?.handle.get_comments_projection?.() as
      | CommentsProjection
      | undefined;
    setCommentsProjection(projection ?? null);
    return projection ?? null;
  }, [liveRuntimeRef]);

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
      refreshCloudCommentsProjection();
      return true;
    },
    [liveRuntimeRef, refreshCloudCommentsProjection],
  );

  const handleCreateAnchoredCommentThread = useCallback(
    async (anchor: CommentAnchor, body: string) => {
      if (!canWriteComments) {
        setCommentsError("Comments are read-only.");
        return;
      }
      const liveRuntime = liveRuntimeRef.current;
      if (!liveRuntime || typeof liveRuntime.handle.create_comment_thread !== "function") {
        setCommentsError("Comments are not ready.");
        return;
      }
      try {
        const projection = refreshCloudCommentsProjection() ?? commentsProjection;
        const orderScope = commentAnchorThreadOrderScope(anchor);
        const afterThreadId =
          projection?.threads
            .filter((thread) => commentAnchorThreadOrderScope(thread.anchor) === orderScope)
            .at(-1)?.id ?? null;
        const event = liveRuntime.handle.create_comment_thread(
          createCloudCommentId("thread"),
          createCloudCommentId("message"),
          anchor,
          body,
          afterThreadId,
          new Date().toISOString(),
        );
        applyLocalCommentEvent(event);
      } catch (error) {
        setCommentsError(error instanceof Error ? error.message : String(error));
      }
    },
    [
      applyLocalCommentEvent,
      canWriteComments,
      commentsProjection,
      liveRuntimeRef,
      refreshCloudCommentsProjection,
    ],
  );

  const handleCreateCommentThread = useCallback(
    async (body: string) => {
      await handleCreateAnchoredCommentThread({ kind: "notebook" }, body);
    },
    [handleCreateAnchoredCommentThread],
  );

  const handleCreatePanelComment = useCallback(
    async (body: string) => {
      if (!commentDraftTarget) {
        await handleCreateCommentThread(body);
        return;
      }
      if (
        commentDraftTarget.anchor.kind === "source_range" &&
        !sourceRangeAnchorMatchesCurrentCell(commentDraftTarget.anchor)
      ) {
        setCommentsError("Selected source changed. Select the text again before commenting.");
        return;
      }
      if (
        commentDraftTarget.anchor.kind === "output" &&
        !outputCommentAnchorMatchesLiveState(commentDraftTarget.anchor)
      ) {
        setCommentsError(OUTPUT_COMMENT_STALE_MESSAGE);
        return;
      }
      await handleCreateAnchoredCommentThread(commentDraftTarget.anchor, body);
      setCommentDraftTarget(null);
    },
    [commentDraftTarget, handleCreateAnchoredCommentThread, handleCreateCommentThread],
  );

  const handleRequestSourceComment = useCallback(
    (
      anchor: SourceRangeCommentAnchor,
      rect: SourceCommentSelectionRect | null,
      quote?: string | null,
    ) => {
      setCommentsError(null);
      if (rect) {
        setSourceCommentRequest({ anchor, rect, quote });
        return;
      }
      setSourceCommentRequest(null);
      setCommentDraftTarget({ anchor, quote: quote ?? anchor.exact_quote ?? null });
      openNotebookRailPanel("comments");
    },
    [],
  );

  const handleRequestOutputComment = useCallback((anchor: OutputCommentAnchor) => {
    setCommentsError(null);
    if (!outputCommentAnchorMatchesLiveState(anchor)) {
      setCommentsError(OUTPUT_COMMENT_STALE_MESSAGE);
      return;
    }
    setSourceCommentRequest(null);
    setCommentDraftTarget({ anchor, quote: null });
    openNotebookRailPanel("comments");
  }, []);

  const handleSubmitSourceComment = useCallback(
    async (body: string) => {
      if (!sourceCommentRequest) return;
      if (!sourceRangeAnchorMatchesCurrentCell(sourceCommentRequest.anchor)) {
        setSourceCommentRequest(null);
        setCommentsError("Selected source changed. Select the text again before commenting.");
        return;
      }
      await handleCreateAnchoredCommentThread(sourceCommentRequest.anchor, body);
      setSourceCommentRequest(null);
    },
    [handleCreateAnchoredCommentThread, sourceCommentRequest],
  );

  const handleCancelSourceComment = useCallback(() => {
    setSourceCommentRequest(null);
  }, []);

  const handleClearCommentDraftTarget = useCallback(() => {
    setCommentDraftTarget(null);
  }, []);

  const sourceCommentThreadsByCell = useMemo(() => {
    const map = new Map<string, SourceCommentThread[]>();
    for (const thread of commentsProjection?.threads ?? []) {
      if (thread.anchor.kind !== "source_range") continue;
      const list = map.get(thread.anchor.cell_id) ?? [];
      const firstMessage = thread.messages[0];
      const author = thread.created_by_actor_label
        ? resolveCloudCommentAuthor(thread.created_by_actor_label)
        : undefined;
      list.push({
        threadId: thread.id,
        anchor: thread.anchor,
        resolved: thread.status === "resolved",
        color: author?.color,
        preview: firstMessage
          ? {
              authorName: author?.displayName ?? "Unknown",
              authorColor: author?.color,
              imageUrl: author?.imageUrl,
              isAgent: author?.isAgent,
              onBehalfOf: author?.onBehalfOf,
              onBehalfOfColor: author?.onBehalfOfColor,
              body: firstMessage.body,
              replyCount: Math.max(0, thread.messages.length - 1),
            }
          : undefined,
      });
      map.set(thread.anchor.cell_id, list);
    }
    return map;
  }, [commentsProjection, resolveCloudCommentAuthor]);

  useEffect(() => {
    setSourceCommentThreads(sourceCommentThreadsByCell);
  }, [sourceCommentThreadsByCell]);

  const handleActivateCommentThread = useCallback((threadId: string) => {
    openNotebookRailPanel("comments");
    setCommentFocus((previous) => ({ threadId, nonce: (previous?.nonce ?? 0) + 1 }));
  }, []);

  const resolveCommentSourceLanguage = useCallback((cellId: string): string | undefined => {
    const cell = getCellById(cellId);
    if (cell?.cell_type !== "code") return undefined;
    const language = typeof cell.metadata.language === "string" ? cell.metadata.language : null;
    return cloudSourceLanguage(language);
  }, []);

  const handleReplyCommentThread = useCallback(
    async (threadId: string, body: string) => {
      if (!canWriteComments) return;
      const liveRuntime = liveRuntimeRef.current;
      if (!liveRuntime || typeof liveRuntime.handle.reply_comment_thread !== "function") {
        setCommentsError("Comments are not ready.");
        return;
      }
      try {
        const projection = refreshCloudCommentsProjection() ?? commentsProjection;
        const afterMessageId =
          projection?.threads.find((thread) => thread.id === threadId)?.messages.at(-1)?.id ?? null;
        const event = liveRuntime.handle.reply_comment_thread(
          threadId,
          createCloudCommentId("message"),
          body,
          afterMessageId,
          new Date().toISOString(),
        );
        applyLocalCommentEvent(event);
      } catch (error) {
        setCommentsError(error instanceof Error ? error.message : String(error));
      }
    },
    [
      applyLocalCommentEvent,
      canWriteComments,
      commentsProjection,
      liveRuntimeRef,
      refreshCloudCommentsProjection,
    ],
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

  const handleDemoteDetachedOutputCommentThread = useCallback(
    (threadId: string): boolean => {
      // Background auto-repair: report success so the hook only stops retrying
      // once the demote commits, and stay quiet on the user-facing error state.
      if (!canWriteComments) return false;
      const liveRuntime = liveRuntimeRef.current;
      if (
        !liveRuntime ||
        typeof liveRuntime.handle.demote_comment_thread_to_notebook !== "function"
      ) {
        return false;
      }
      try {
        liveRuntime.handle.demote_comment_thread_to_notebook(threadId);
        refreshCloudCommentsProjection();
        liveRuntime.engine.scheduleFlush();
        return true;
      } catch {
        return false;
      }
    },
    [canWriteComments, liveRuntimeRef, refreshCloudCommentsProjection],
  );

  useDemoteDetachedOutputCommentThreads({
    commentsProjection,
    enabled: canWriteComments,
    demoteThreadToNotebook: handleDemoteDetachedOutputCommentThread,
  });

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
    accessRequest.reset();
    refreshAuthState();
  }, [accessRequest, refreshAuthState]);
  const beginNotebookAuth = useCallback(async () => {
    const method = cloudSignInMethodForConfig(authConfig);
    if (method === "oidc" && authConfig.oidc) {
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
      return;
    }
    if (method === "localDev" && authConfig.localDev) {
      window.location.assign(authConfig.localDev.authUrl);
      return;
    }
    resetPrototypeAuth();
  }, [authConfig.localDev, authConfig.oidc, resetPrototypeAuth]);
  const requestCloudEditAccess = useCallback(() => {
    accessRequest.requestEditAccess();
  }, [accessRequest]);
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
    !commentsUiEnabled && activeRailPanel === "comments"
      ? "outline"
      : !shouldShowCloudWorkstationsPanel && activeRailPanel === "workstations"
        ? "outline"
        : activeRailPanel;
  const commentsPanelStatus = commentsProjection ? null : "Syncing comments...";
  const resolveSourceQuote = useCallback((anchor: SourceRangeCommentAnchor): string | null => {
    const cell = getCellById(anchor.cell_id);
    if (cell?.cell_type !== "markdown") return anchor.exact_quote ?? null;
    const range = resolveSourceRangeAnchor(cell.source, anchor);
    if (!range) return anchor.exact_quote ?? null;
    const plan = resolveMarkdownProjection(cell.markdownProjection, cell.source);
    if (!plan || !markdownProjectionMatchesSource(plan, cell.source)) {
      return anchor.exact_quote ?? null;
    }
    return renderedTextForSourceRange(plan, range.from, range.to) ?? anchor.exact_quote ?? null;
  }, []);
  const commentsPanel = (
    <NotebookCommentsPanel
      projection={commentsProjection}
      readOnly={!canWriteComments}
      draftTarget={canWriteComments ? commentDraftTarget : null}
      statusMessage={commentsPanelStatus}
      errorMessage={commentsError}
      onClearDraftTarget={commentDraftTarget ? handleClearCommentDraftTarget : undefined}
      onCreateThread={canWriteComments ? handleCreatePanelComment : undefined}
      onReplyThread={canWriteComments ? handleReplyCommentThread : undefined}
      onResolveThread={canWriteComments ? handleResolveCommentThread : undefined}
      onReopenThread={canWriteComments ? handleReopenCommentThread : undefined}
      onFocusThreadAnchor={handleFocusCommentAnchor}
      resolveCommentAuthor={resolveCloudCommentAuthor}
      focusedThreadId={commentFocus?.threadId ?? null}
      focusNonce={commentFocus?.nonce ?? 0}
      resolveSourceLanguage={resolveCommentSourceLanguage}
      resolveSourceQuote={resolveSourceQuote}
    />
  );
  const commentsUiSurface = resolveCommentsUiSurface({
    commentsUiEnabled,
    canCreateComments: canWriteComments,
    commentsPanel,
    onCreateSourceComment: handleRequestSourceComment,
    onCreateOutputComment: handleRequestOutputComment,
    onActivateCommentThread: handleActivateCommentThread,
  });
  const rail = (
    <NotebookDocumentRail
      viewModel={notebookViewModel}
      activePanelId={renderedActiveRailPanel}
      collapsed={railCollapsed}
      outlineCellIds={notebookCellIds}
      activeOutlineItemId={activeOutlineItemId}
      selectedOutlineItemId={selectedOutlineItemId}
      selectedOutlineCellId={focusedCellId}
      commentsPanel={commentsUiSurface.commentsPanel}
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
        <>
          {shouldShowPackageEnvironmentSummary ? (
            <EnvironmentSummary
              capabilities={shellCapabilities}
              packages={notebookViewModel.packages}
              showPackageDetails={false}
              className="cloud-package-summary-header"
            />
          ) : null}
          <NotebookPackageSummaryPanel
            packages={notebookViewModel.packages}
            readOnly={!shellCapabilities.canManagePackages}
          />
        </>
      }
      onActivePanelChange={handleRailPanelChange}
      onCollapsedChange={setNotebookRailCollapsed}
      onSelectOutlineItem={handleSelectOutlineItem}
      onNavigateOutlineItem={handleNavigateOutlineItem}
      className="cloud-notebook-rail"
    />
  );

  const showCloudCommandToolbar = shouldShowNotebookDocumentCommandToolbar(shellCapabilities, {
    reserve: editAccessPending,
  });
  const notebookHasReadableSnapshot =
    notebookCellIds.length > 0 ||
    (!connectionError && snapshotResolvedRef.current && status.kind === "ready");
  // The route has no authenticated identity and the live-room join is retrying
  // without a readable public snapshot: a hard sign-in wall, distinct from stale
  // or expired auth. This owns the whole stage (NotebookAccessGate below) instead
  // of riding the thin notice banner, so the signed-out canvas reads as gated
  // rather than an empty/broken notebook.
  const signedOutNotebookSignInRequired =
    Boolean(authConfig.localDev || authConfig.oidc) &&
    appSessionStatus.status !== "loading" &&
    !hasAppSession &&
    authState.mode === "anonymous" &&
    !isPublicViewer &&
    !notebookHasReadableSnapshot &&
    status.kind === "loading" &&
    Boolean(connectionError && isTransportReconnectError(connectionError));
  const notebookBodyAccessBlocked = cloudConnectionDiagnosticBlocksNotebookBody(connectionError);
  // A signed-out gate blocks the body just like an access diagnostic: quiet the
  // presence/edit/identity chrome so the header does not advertise collaboration
  // affordances behind a sign-in wall.
  const notebookStageGated = notebookBodyAccessBlocked || signedOutNotebookSignInRequired;
  // Behind a gate the catalog title is unknown, so `notebookTitle` falls back to
  // the humanized URL slug — a guessed, CSS-truncated fragment (e.g. "Ob…") that
  // reads as broken. Show a clean intentional label instead until access resolves.
  const gatedNotebookTitle = useMemo(cloudNotebookGatedTitle, []);
  const notebookHeaderChrome = projectCloudNotebookHeaderChrome({
    bodyAccessBlocked: notebookStageGated,
    liveRoomAccessPending: liveRoomDisabledStatus?.kind === "loading",
  });

  const toolbar = (
    <NotebookDocumentToolbar
      capabilities={shellCapabilities}
      frameClassName="z-20"
      headerClassName="cloud-room-toolbar"
      presence={
        <CloudNotebookTitle
          title={notebookStageGated ? gatedNotebookTitle : notebookTitle}
          renameTitle={catalogNotebookTitle?.trim() ?? ""}
          canRename={catalogAccessResolved && catalogGrantsDocumentEdit}
          renameSaving={notebookTitleSaving}
          renameError={notebookTitleError}
          onRename={saveCloudNotebookTitle}
        />
      }
      utilityControls={
        notebookHeaderChrome.showPresenceStatus ? (
          <CloudPresenceStatus
            connectionError={connectionError}
            store={presenceStore}
            resolveActor={resolveCloudPresenceActor}
          />
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
        notebookHeaderChrome.showEditModeControl ? (
          <CloudNotebookEditModeButton
            authState={authState}
            hasAppSession={hasAppSession}
            interaction={shellCapabilities.interaction ?? null}
            accessLevel={shellCapabilities.access.level}
            accessPending={editAccessPending}
            hasSentEditRequest={
              accessRequestFacts.requestedByUser || Boolean(cloudAccessFacts.effectiveAccessRequest)
            }
            reconnecting={sustainedReconnecting}
            onModeChange={handleSelectInteractionMode}
            onRequestEditAccess={requestCloudEditAccess}
          />
        ) : null
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
  const notebookViewSurface = projectCloudNotebookViewSurface({
    // A signed-out gate owns the stage: suppress the empty NotebookView so it
    // does not paint a blank canvas behind the gate.
    bodyAccessBlocked: notebookStageGated,
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
  const cloudKernelRuntime =
    runtimeState.kernel.language === "deno" || notebookLanguageRef.current === "deno"
      ? "deno"
      : "python";
  const shouldRenderKernelLaunchError =
    shouldShowKernelLaunchErrorBanner({
      lifecycle: cloudKernelLifecycle,
      errorDetails: cloudKernelErrorDetails,
      errorReason: cloudKernelErrorReason,
      runtime: cloudKernelRuntime,
    }) && dismissedLaunchError !== cloudKernelErrorDetails;
  const shouldRenderComputeDisconnectedNotice =
    isRuntimePeerDisconnectedErrorDetails(cloudKernelErrorDetails) &&
    dismissedLaunchError !== cloudKernelErrorDetails;
  const computeDisconnectedNotice =
    shouldRenderComputeDisconnectedNotice && cloudKernelErrorDetails ? (
      <ComputeDisconnectedNotice
        errorDetails={cloudKernelErrorDetails}
        onRetry={() => {
          setDismissedLaunchError(null);
          handleCloudRestartRuntime();
        }}
        onDismiss={() => setDismissedLaunchError(cloudKernelErrorDetails)}
      />
    ) : null;
  const kernelLaunchNotice =
    shouldRenderKernelLaunchError && cloudKernelErrorDetails ? (
      <KernelLaunchErrorBanner
        errorDetails={cloudKernelErrorDetails}
        onRetry={() => {
          setDismissedLaunchError(null);
          handleCloudRestartRuntime();
        }}
        onDismiss={() => setDismissedLaunchError(cloudKernelErrorDetails)}
      />
    ) : null;
  const diagnostics =
    computeDisconnectedNotice || kernelLaunchNotice || accessRequestNotice ? (
      <>
        {computeDisconnectedNotice}
        {kernelLaunchNotice}
        {accessRequestNotice}
      </>
    ) : null;
  const hasNotices = cloudNotebookHasNotices({
    authState,
    authRenewal,
    connectionError,
    diagnostics,
    hasAppSession,
    isPublicViewer,
    hasReadableSnapshot: notebookHasReadableSnapshot,
    signInRequired: signedOutNotebookSignInRequired,
    signInRequiredOwnedByStage: signedOutNotebookSignInRequired,
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
      diagnostics={diagnostics}
      hasAppSession={hasAppSession}
      isPublicViewer={isPublicViewer}
      hasReadableSnapshot={notebookHasReadableSnapshot}
      signInRequired={signedOutNotebookSignInRequired}
      signInRequiredOwnedByStage={signedOutNotebookSignInRequired}
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

  // Full-stage sign-in wall for a signed-out private notebook link. Owns the
  // whole canvas (the empty NotebookView is suppressed and the rail hidden) so
  // the surface reads as intentionally gated. The primary action reuses
  // CloudNotebookSignInButton, the single sign-in source of truth, so its copy
  // and OIDC-vs-localDev priority cannot drift from the rest of the app.
  const signedOutGate = signedOutNotebookSignInRequired ? (
    <NotebookAccessGate
      tone="info"
      icon={<LogIn aria-hidden="true" />}
      title="Sign in to open this notebook"
      detail="This notebook is private. Sign in with your account and we'll bring you straight back here."
      primaryAction={
        <div className="cloud-notebook-signed-out-actions cloud-notebook-gate-actions">
          <CloudNotebookSignInButton authConfig={authConfig} authState={authState} />
        </div>
      }
      data-testid="cloud-notebook-signed-out-gate"
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
        rail={notebookStageGated ? undefined : rail}
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
            {signedOutGate}
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
                onCreateSourceComment={commentsUiSurface.onCreateSourceComment}
                onCreateOutputComment={commentsUiSurface.onCreateOutputComment}
                onActivateCommentThread={commentsUiSurface.onActivateCommentThread}
                commentThreadsByCell={commentsUiEnabled ? sourceCommentThreadsByCell : undefined}
                pendingCommentAnchor={sourceCommentRequest?.anchor ?? null}
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
      {commentsUiEnabled && sourceCommentRequest ? (
        <InlineCommentComposer
          rect={sourceCommentRequest.rect}
          quote={sourceCommentRequest.quote ?? sourceCommentRequest.anchor.exact_quote}
          disabled={!canWriteComments}
          onSubmit={handleSubmitSourceComment}
          onCancel={handleCancelSourceComment}
        />
      ) : null}
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

function commentAnchorThreadOrderScope(anchor: CommentAnchor): string {
  switch (anchor.kind) {
    case "notebook":
      return "notebook";
    case "cell":
    case "source_range":
      return `cell:${anchor.cell_id}`;
    case "cell_range":
      return `cell_range:${anchor.start_cell_id}:${anchor.end_cell_id}`;
    case "output":
      return `output:${anchor.cell_id}:${anchor.execution_id ?? ""}:${anchor.output_id ?? ""}`;
  }
}

function sourceRangeAnchorMatchesCurrentCell(anchor: SourceRangeCommentAnchor): boolean {
  const cell = getCellById(anchor.cell_id);
  if (
    !cell ||
    (cell.cell_type !== "code" && cell.cell_type !== "raw" && cell.cell_type !== "markdown")
  ) {
    return false;
  }
  return resolveSourceRangeAnchor(cell.source, anchor) !== null;
}

const OUTPUT_COMMENT_STALE_MESSAGE =
  "Selected outputs changed. Comment on the current outputs before submitting.";

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

  if (projection.kind === "dismissed") {
    return (
      <NotebookNotice
        tone={projection.tone}
        icon={<Info className="h-4 w-4" />}
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
