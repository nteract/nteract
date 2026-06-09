import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { NotebookHostProvider } from "@nteract/notebook-host";
import { AlertCircle, Check, Loader2, X } from "lucide-react";
import { IsolatedRendererProvider } from "@/components/isolated/isolated-renderer-context";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import { NotebookNotice } from "@/components/notebook/NotebookNotice";
import type { NotebookRailPanelId } from "@/components/notebook-rail";
import {
  NotebookDocumentToolbar,
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
  type NotebookPackageSection,
  useNotebookCellUIStateBridge,
  useNotebookViewModel,
} from "@/components/notebook";
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
  fetchWithCloudPrototypeAuth,
  cloudSyncAuthFromAppSessionCookie,
  cloudSyncAuthFromPrototypeAuthState,
  prepareCloudOidcViewerLogin,
  storeCloudRequestedScope,
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
import { beginOidcLogin } from "./oidc-auth";
import { cloudViewerLoadingPolicy } from "./loading-policy";
import { markCloudViewerLoadMilestone } from "./load-milestones";
import { CLOUD_VIEWER_PRIORITY } from "./mime-policy";
import { cloudPresenceHasRuntimePeer, cloudPresenceRuntimePeerCount } from "./presence";
import type { ResolvedCell } from "./render-resolution";
import { CloudNotebookNotices, cloudNotebookHasNotices } from "./notices";
import type { ViewerStatus } from "./notice-types";
import { rendererAssetBasePathForProvider } from "./renderer-assets";
import type { CloudNotebookAccessRequest } from "./sharing-client";
import { CloudSharingControls } from "./sharing-controls";
import { createCloudNotebookHost } from "./cloud-notebook-host";
import { cloudResponseError } from "./cloud-response";
import { preloadSiftWasmForCells } from "./sift-preload";
import { cloudSourceLanguage } from "./source-language";
import { loadSupplementalViewerCss } from "./supplemental-css";
import { clearCloudAppSession, readCloudAppSessionStatus } from "./app-session";
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
  loadViewerRuntime,
  requireElement,
} from "./cloud-viewer-config";
import type {
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
import { CloudHomeView, CloudNotebookListView, OidcCallbackView } from "./cloud-route-views";
import {
  CloudNotebookEditModeButton,
  CloudNotebookSignInButton,
  shouldShowCloudHeaderSignIn,
} from "./cloud-auth-controls";
import { CloudNotebookTitle } from "./cloud-notebook-title";
import { CloudPresenceStatus } from "./cloud-presence-status";
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

function initialCloudRailCollapsed(): boolean {
  return true;
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
