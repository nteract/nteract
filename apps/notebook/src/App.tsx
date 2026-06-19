import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deriveEnvManager,
  deriveRuntimeKind,
  NotebookClient,
  resolveActorDisplay,
  splitNotebookActorPrincipalOperator,
  type ActorDisplayPeer,
  type CommentAnchor,
  type CommentThreadSnapshot,
  type CommentsProjection,
  type ExecuteCellOptions,
  type NotebookResponse,
  type NotebookOutlineItem,
  putBlob,
  type SessionStatus,
} from "runtimed";
import { IsolationTest } from "@/components/isolated";
import { MediaProvider } from "@/components/outputs/media-provider";
import {
  applyWidgetCommBroadcastToStore,
  applyWidgetCommChangesToStore,
} from "@/components/widgets/comm-changes-store-bridge";
import { getCrdtCommWriter, setCrdtCommWriter } from "@/components/widgets/crdt-comm-writer";
import { SavedWidgetStateProvider } from "@/components/widgets/saved-widget-state-context";
import {
  useWidgetStoreRequired,
  WidgetStoreProvider,
} from "@/components/widgets/widget-store-context";
import { parseSavedWidgetModels, parseWidgetViewModelId } from "@/components/widgets/widget-state";
import { type BlobUploader, WidgetUpdateManager } from "@/components/widgets/widget-update-manager";
import { WidgetView } from "@/components/widgets/widget-view";
import { useSyncedTheme } from "@/hooks/useSyncedSettings";
import { ErrorBoundary } from "@/lib/error-boundary";
import { cn } from "@/lib/utils";
import {
  NOTEBOOK_RAIL_TAKEOVER_MEDIA_QUERY,
  NOTEBOOK_RAIL_TAKEOVER_STAGE_CLASS_NAME,
  NotebookPackagesPanel,
  type NotebookRailPanelId,
} from "@/components/notebook-rail";
import {
  navigateNotebookOutlineItem,
  useActiveOutlineItemId,
  useOutlineSelection,
  useOutlineStatusLabel,
  type DaemonStatus,
  DaemonStatusBanner,
  DebugBanner,
  EnvBuildDecisionDialog,
  KernelLaunchErrorBanner,
  NotebookCommentsPanel,
  NotebookConnectionIdentity,
  NotebookDocumentRail,
  NotebookDocumentShell,
  PoolErrorBanner,
  shouldShowKernelLaunchErrorBanner,
  TrustDialog,
  UntrustedBanner,
  type CommentAuthor,
  type NotebookCommentDraftTarget,
} from "@/components/notebook";
import { GlobalFindBar } from "@/components/search";
import { InlineCommentComposer } from "./components/InlineCommentComposer";
import { setSourceCommentThreads, type SourceCommentThread } from "./lib/comment-highlights";
import {
  resolveSourceRangeAnchor,
  type OutputCommentAnchor,
  type SourceCommentSelectionRect,
  type SourceRangeCommentAnchor,
} from "./lib/comment-source-anchor";
import {
  setCommentsProjectionSnapshot,
  useCommentsProjection,
} from "./lib/comments-projection-store";
import { createDesktopConnectionStatusSource } from "./lib/desktop-connection-status";
import {
  CondaDependencyPanel as CondaDependencyHeader,
  DenoDependencyPanel as DenoDependencyHeader,
  UvDependencyPanel as DependencyHeader,
} from "@/components/environment";
import { NotebookToolbar } from "./components/NotebookToolbar";
import { NotebookView } from "./components/NotebookView";
import { PixiDependencyHeader } from "./components/PixiDependencyHeader";
import { PresenceProvider } from "./contexts/PresenceContext";
import { useNotebook } from "./hooks/useNotebook";
import { useCondaDependencies } from "./hooks/useCondaDependencies";
import { CrdtBridgeProvider } from "@/components/notebook";
import { startCursorDispatch } from "@/components/notebook/cursor-registry";
import { useDaemonKernel } from "./hooks/useDaemonKernel";
import { useDenoConfig } from "./hooks/useDenoConfig";
import { type EnvSyncState, useDependencies } from "./hooks/useDependencies";
import { useEnvProgress } from "./hooks/useEnvProgress";
import { useDaemonInfo, useGitInfo } from "./hooks/useGitInfo";
import { useGlobalFind } from "./hooks/useGlobalFind";
import { resolveOutputValue } from "./hooks/useManifestResolver";
import { usePixiDetection } from "./hooks/usePixiDetection";
import { usePoolState } from "./hooks/usePoolState";
import { useTrust } from "./hooks/useTrust";
import { useUpdater } from "./hooks/useUpdater";
import { startAttributionDispatch } from "./lib/attribution-registry";
import { getBlobResolver, useBlobPort } from "./lib/blob-port";
import { useRuntimeState } from "./lib/runtime-state";
import {
  outputCommentAnchorMatchesLiveState,
  useDemoteDetachedOutputCommentThreads,
} from "@/components/notebook/output-comment-demotion";
import {
  flushCellUIState,
  getFocusedCellId,
  setFocusedCellId,
  useFocusedCellId,
  useNotebookCellUIStateBridge,
} from "@/components/notebook/state/cell-ui-state";
import {
  openNotebookRailPanel,
  setNotebookRailCollapsed,
  toggleNotebookRailPanel,
  useNotebookRailUiState,
} from "@/components/notebook/state/rail-ui-state";
import { desktopNotebookShellCapabilities } from "./lib/desktop-shell-capabilities";
import { getTrustApprovalHandoffDisplayStatus, KERNEL_STATUS } from "./lib/kernel-status";
import { useNotebookActionPolicy } from "./lib/notebook-action-policy";
import { useObservable } from "./lib/use-observable";
import { logger } from "./lib/logger";
import {
  attachExecutionPerformanceId,
  installExecutionPerformanceApi,
  markExecutionPerformance,
  startExecutionPerformanceTrace,
} from "./lib/execution-performance";
import { getCellById, getNotebookCellsSnapshot } from "@/components/notebook/state/cell-store";
import { useNotebookViewModel } from "@/components/notebook/state/view-model-store";
import { useDetectRuntime, useNotebookMetadata } from "./lib/notebook-metadata";
import { useNotebookHost } from "@nteract/notebook-host";
import { startWindowFocusHandler } from "./lib/window-focus";
import type { JupyterOutput } from "./types";

/** MIME bundle type for output data */
export type MimeBundle = Record<string, unknown>;

/**
 * Module-level reference for daemon comm sending.
 * Set by AppContent when daemon kernel is initialized.
 */
let daemonCommSender: ((message: unknown) => Promise<void>) | null = null;

function focusActiveRailButtonWhenStageIsHidden(
  railCollapsed: boolean,
  stageHadFocusBeforeTakeover: boolean,
): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const takeoverQuery = window.matchMedia?.(NOTEBOOK_RAIL_TAKEOVER_MEDIA_QUERY);
  if (!takeoverQuery?.matches || railCollapsed) return;

  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return;

  const stage = document.querySelector('[data-slot="notebook-document-stage"]');
  const focusWasInStage = stage?.contains(activeElement);
  const focusWasClearedFromHiddenStage =
    stageHadFocusBeforeTakeover && activeElement === document.body;
  if (!focusWasInStage && !focusWasClearedFromHiddenStage) return;

  const activeRailButton = document.querySelector<HTMLButtonElement>(
    '[data-testid="notebook-rail"] button[aria-pressed="true"]',
  );
  requestAnimationFrame(() => activeRailButton?.focus());
}

/**
 * Update the daemon comm sender reference.
 * Called by AppContent when daemon kernel is initialized.
 *
 * Kept module-private (not exported). Exporting a non-component, non-hook
 * function from this file would break Vite's react-plugin Fast Refresh
 * boundary and force a full page reload on every HMR update, which strands
 * any in-memory closures holding the previous daemon comm sender (visible
 * in Tauri's webview as "Run does nothing" until ⌘Q + relaunch).
 */
function setDaemonCommSender(sender: ((message: unknown) => Promise<void>) | null): void {
  daemonCommSender = sender;
}

/**
 * Send a message to the kernel's shell channel via daemon.
 * Used by the widget store for comm_msg/comm_open/comm_close.
 */
async function sendMessage(message: unknown): Promise<void> {
  try {
    if (daemonCommSender) {
      await daemonCommSender(message);
    } else {
      logger.debug("[widget] sendMessage called but daemon sender not ready");
    }
  } catch (e) {
    logger.error("[widget] send_comm_message failed:", e);
  }
}

function createClientExecutionId(): string {
  return globalThis.crypto.randomUUID();
}

function createLocalCommentEntityId(prefix: "thread" | "message"): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

function canConnectionScopeMutateComments(connectionScope: string | null): boolean {
  return connectionScope === null || connectionScope === "editor" || connectionScope === "owner";
}

function commentAnchorThreadOrderScope(anchor: CommentAnchor): string {
  switch (anchor.kind) {
    case "notebook":
      return "notebook";
    case "cell":
    case "source_range":
      return `cell:${anchor.cell_id}`;
    case "output":
      return `output:${anchor.cell_id}:${anchor.execution_id ?? ""}:${anchor.output_id ?? ""}`;
    case "cell_range":
      return `cell_range:${anchor.start_cell_id}:${anchor.end_cell_id}`;
  }
}

function sourceRangeAnchorMatchesCurrentCell(anchor: CommentAnchor): boolean {
  if (anchor.kind !== "source_range") return false;
  const cell = getCellById(anchor.cell_id);
  if (
    !cell ||
    (cell.cell_type !== "code" && cell.cell_type !== "raw" && cell.cell_type !== "markdown")
  )
    return false;
  return resolveSourceRangeAnchor(cell.source, anchor) !== null;
}

const OUTPUT_COMMENT_STALE_MESSAGE =
  "Selected outputs changed. Comment on the current outputs before submitting.";

function markClientExecuteResponse(
  phase: string,
  cellId: string,
  response: NotebookResponse,
  detail: Record<string, unknown> = {},
  alreadyAttachedExecutionId?: string,
): void {
  const responseDetail: Record<string, unknown> = {
    cellId,
    result: response.result,
    ...detail,
  };

  if (response.result === "cell_queued") {
    responseDetail.executionId = response.execution_id;
    if (response.execution_id !== alreadyAttachedExecutionId) {
      attachExecutionPerformanceId(cellId, response.execution_id);
    }
  } else if (response.result === "execution_id_rejected") {
    responseDetail.executionId = response.execution_id;
    responseDetail.reason = response.reason;
  }

  markExecutionPerformance(phase, responseDetail);
}

// ── Output widget manifest resolution ─────────────────────────────────
// Generation counter per comm to discard stale async results.
const _outputResolveGen = new Map<string, number>();

/**
 * Resolve Output widget manifests and update the WidgetStore.
 *
 * When SyncEngine.commChanges$ emits a comm with `unresolvedOutputs`,
 * this function fetches + resolves the manifests asynchronously and
 * pushes the resolved outputs into the widget store.
 */
function resolveCommOutputs(
  commId: string,
  outputs: unknown[],
  store: import("@/components/widgets/widget-store").WidgetStore,
): void {
  const blobResolver = getBlobResolver();
  if (blobResolver === null) return;

  const gen = (_outputResolveGen.get(commId) ?? 0) + 1;
  _outputResolveGen.set(commId, gen);

  void (async () => {
    const resolved = await Promise.all(outputs.map((o) => resolveOutputValue(o, blobResolver)));
    if (_outputResolveGen.get(commId) !== gen) return;

    const resolvedOutputs = resolved.filter((o): o is JupyterOutput => o !== null);
    if (resolvedOutputs.length > 0) {
      store.updateModel(commId, { outputs: resolvedOutputs });
    }
  })();
}

function AppContent() {
  const host = useNotebookHost();
  const blobUploader = useMemo<BlobUploader>(
    () => (bytes, mediaType, durability) => putBlob(host.transport, bytes, mediaType, durability),
    [host],
  );
  _blobUploaderRef = blobUploader;
  useEffect(
    () => () => {
      if (_blobUploaderRef === blobUploader) {
        _blobUploaderRef = null;
      }
    },
    [blobUploader],
  );
  const gitInfo = useGitInfo();
  const daemonInfo = useDaemonInfo();

  // Apply theme to this window
  const { defaultPythonEnv } = useSyncedTheme();

  // Stable peer ID for presence (generated once per window lifetime)
  const peerIdRef = useRef(crypto.randomUUID());

  // OS username for presence labels (injected by Tauri initialization_script)
  const peerLabel = (window as unknown as Record<string, string>).__NTERACT_USERNAME__ ?? "";

  // Start dispatching presence events to CodeMirror EditorViews
  useEffect(() => {
    return startCursorDispatch(peerIdRef.current);
  }, []);

  // Start dispatching text attribution events to CodeMirror EditorViews
  useEffect(() => {
    return startAttributionDispatch();
  }, []);

  // Re-establish CodeMirror input context on window reactivation.
  // Without this, WKWebView may drop the first few keystrokes after Cmd+Tab.
  useEffect(() => {
    return startWindowFocusHandler(host);
  }, [host]);

  const {
    cellIds,
    isLoading,
    canAcceptCellMutations,
    loadError,
    updateCellSource,
    addCell,
    moveCell,
    deleteCell,
    clearOutputs,
    save,
    openNotebook,
    cloneNotebook,

    applyExecutionCountFromDaemon,
    setCellSourceHidden,
    setCellOutputsHidden,
    flushSync,
    getHandle,
    getEngine,
    sessionStatus$,
    triggerSync,
    localActor,
    connectionScope,
  } = useNotebook();

  // Daemon sync status. Drives the kernel-action gate: until the daemon
  // has confirmed the first RuntimeStateSync round-trip (`runtime_state ==
  // "ready"`), trust state is unknown and kernel-modifying actions must
  // fail-closed. `sessionStatus$` is a ReplaySubject(1) on the engine;
  // `useObservable` seeds with `null` until the engine emits.
  const sessionStatus = useObservable<SessionStatus | null>(sessionStatus$, null);
  const sessionReady = sessionStatus?.runtime_state === "ready";
  const commentsProjection = useCommentsProjection();
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [commentDraftTarget, setCommentDraftTarget] = useState<NotebookCommentDraftTarget | null>(
    null,
  );
  const [sourceCommentRequest, setSourceCommentRequest] = useState<{
    anchor: SourceRangeCommentAnchor;
    rect: SourceCommentSelectionRect;
  } | null>(null);
  const [commentFocus, setCommentFocus] = useState<{ threadId: string; nonce: number } | null>(
    null,
  );

  const refreshCommentsProjection = useCallback(() => {
    const projection =
      (getHandle()?.get_comments_projection?.() as CommentsProjection | undefined) ?? null;
    setCommentsProjectionSnapshot(projection);
    return projection;
  }, [getHandle]);

  useEffect(() => {
    refreshCommentsProjection();
    const engine = getEngine();
    if (!engine) return;
    const subscription = engine.commentsProjection$.subscribe((projection) => {
      setCommentsProjectionSnapshot(projection);
      setCommentsError(null);
    });
    return () => subscription.unsubscribe();
  }, [getEngine, refreshCommentsProjection, sessionStatus?.notebook_doc]);

  // Global find (Cmd+F)
  const globalFind = useGlobalFind(cellIds);

  const { activePanelId: activeRailPanel, collapsed: railCollapsed } = useNotebookRailUiState();
  const stageHadFocusBeforeRailTakeoverRef = useRef(false);
  const [showIsolationTest, setShowIsolationTest] = useState(false);
  const [envBuildDialogOpen, setEnvBuildDialogOpen] = useState(false);
  const [dismissedEnvBuildDetails, setDismissedEnvBuildDetails] = useState<string | null>(null);
  const [clearingDeps, setClearingDeps] = useState(false);
  // Per-error-instance dismissal for the kernel-launch error banner.
  // Stores the `errorDetails` string the user dismissed; cleared
  // whenever the kernel transitions out of Error (so the next failure
  // shows the banner fresh) or a different details string arrives.
  const [dismissedLaunchError, setDismissedLaunchError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const handleFocusIn = (event: FocusEvent) => {
      const stage = document.querySelector('[data-slot="notebook-document-stage"]');
      stageHadFocusBeforeRailTakeoverRef.current = Boolean(
        event.target instanceof Node && stage?.contains(event.target),
      );
    };

    document.addEventListener("focusin", handleFocusIn);
    return () => {
      document.removeEventListener("focusin", handleFocusIn);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const takeoverQuery = window.matchMedia?.(NOTEBOOK_RAIL_TAKEOVER_MEDIA_QUERY);
    if (!takeoverQuery) return;

    const handleTakeoverChange = () => {
      focusActiveRailButtonWhenStageIsHidden(
        railCollapsed,
        stageHadFocusBeforeRailTakeoverRef.current,
      );
    };

    handleTakeoverChange();
    takeoverQuery.addEventListener("change", handleTakeoverChange);
    window.addEventListener("resize", handleTakeoverChange);
    return () => {
      takeoverQuery.removeEventListener("change", handleTakeoverChange);
      window.removeEventListener("resize", handleTakeoverChange);
    };
  }, [railCollapsed]);

  // Daemon startup status (installing, starting, failed, etc.)
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatus>(null);
  // Track ready timeout so we can cancel it if status changes
  const readyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Trust verification for notebook dependencies
  const {
    trustInfo,
    typosquatWarnings,
    loading: trustLoading,
    approvalError,
    needsApproval,
    checkTrust,
    approveTrust,
  } = useTrust();

  // Full runtime state from the daemon. Feeds the env-manager + runtime
  // derivers below and the path read further down. Single subscription
  // point; the derivers are pure and don't add re-renders.
  const runtimeState = useRuntimeState();

  // Notebook runtime type — reactive read from WASM Automerge doc.
  // Re-renders automatically when metadata changes (bootstrap, sync, writes).
  const detectedRuntime = useDetectRuntime();
  // Runtime hint from daemon:ready payload — available before metadata syncs,
  // prevents momentary flicker of wrong runtime UI (e.g. Python for Deno notebooks).
  const [runtimeHint, setRuntimeHint] = useState<string | null>(null);
  const runtime = deriveRuntimeKind(runtimeState, detectedRuntime, runtimeHint);

  // `true` when the room is in-memory only (untitled); reported by the daemon
  // via `daemon:ready`. Drives the always-dirty titlebar asterisk. Null until
  // the first ready event lands — treated conservatively as "unknown, assume
  // persisted" so we don't flash an asterisk on open-from-disk notebooks.
  const [ephemeral, setEphemeral] = useState<boolean | null>(null);

  // Canonical window-title base. Bootstrapped from the host on mount (Rust
  // sets it to the filename or "Untitled.ipynb" at window creation), then
  // updated on `path_changed` broadcasts. Used to compute the title asterisk
  // without a getTitle-then-setTitle round-trip that would race with the
  // concurrent Rust-side title update from `applyPathChanged`.
  const [titleBase, setTitleBase] = useState<string | null>(null);

  // UV Dependency management
  const {
    dependencies,
    hasDependencies: hasUvDependencies,
    isUvConfigured,
    loading: depsLoading,
    addDependency,
    removeDependency,
    setRequiresPython,
    clearAllDependencies: clearAllUvDeps,
    pyprojectInfo,
    pyprojectDeps,
    importFromPyproject,
  } = useDependencies();

  // Conda Dependency management
  const {
    dependencies: condaDependencies,
    hasDependencies: hasCondaDependencies,
    isCondaConfigured,
    loading: condaDepsLoading,
    addDependency: addCondaDependency,
    removeDependency: removeCondaDependency,
    clearAllDependencies: clearAllCondaDeps,
    setChannels: setCondaChannels,
    setPython: setCondaPython,
    environmentYmlInfo,
    environmentYmlDeps,
  } = useCondaDependencies();

  // Pixi project detection
  const { pixiInfo } = usePixiDetection();

  // Deno config detection and settings
  const { denoConfigInfo, flexibleNpmImports, setFlexibleNpmImports } = useDenoConfig();

  // Get widget store for CRDT → WidgetStore projection.
  // Set the module-level ref so the updateManager can access it.
  const { store: widgetStore } = useWidgetStoreRequired();
  _widgetStoreRef = widgetStore;

  const handleExecutionCount = useCallback(
    (cellId: string, count: number) => {
      applyExecutionCountFromDaemon(cellId, count);
    },
    [applyExecutionCountFromDaemon],
  );

  // Execution completion is handled by the daemon queue via broadcast events
  const handleExecutionDone = useCallback((_cellId: string) => {
    // Daemon queue handles execution tracking via broadcasts
  }, []);

  // NotebookClient for sending kernel commands via transport. The host's
  // transport is the single instance shared with the SyncEngine in
  // useNotebook — no more separate connection per consumer.
  const notebookClient = useMemo(
    () =>
      new NotebookClient({
        transport: host.transport,
        getRequiredHeads: () => {
          const heads = getHandle()?.get_heads_hex() ?? [];
          markExecutionPerformance("sync.required_heads.captured", {
            headCount: heads.length,
          });
          return heads;
        },
        flushBeforeRequiredHeadsRequest: () => {
          markExecutionPerformance("sync.flush.dispatched.start");
          getEngine()?.flush();
          markExecutionPerformance("sync.flush.dispatched.end");
        },
      }),
    [host, getHandle, getEngine],
  );

  // Daemon-owned kernel execution
  const {
    kernelStatus,
    statusKey,
    lifecycle,
    errorReason,
    errorDetails,
    kernelInfo,
    envSyncState,
    launchKernel,
    executeCell,
    executeCellGuarded,
    interruptKernel,
    shutdownKernel,
    syncEnvironment,
    approveProjectEnvironment,
    runAllCells: daemonRunAllCells,
    runAllCellsGuarded,
    sendCommMessage,
  } = useDaemonKernel({
    client: notebookClient,
    onExecutionCount: handleExecutionCount,
    onExecutionDone: handleExecutionDone,
  });

  // Derive values from daemon kernel
  const envSource = kernelInfo.envSource ?? null;
  const shellCapabilities = useMemo(
    () =>
      desktopNotebookShellCapabilities({
        canAcceptCellMutations,
        sessionReady,
        localActor,
        connectionScope,
        notebookPath: runtimeState.path,
        kernelStatusKey: statusKey,
        kernelErrorReason: errorReason,
      }),
    [
      canAcceptCellMutations,
      connectionScope,
      errorReason,
      localActor,
      runtimeState.path,
      sessionReady,
      statusKey,
    ],
  );
  const canMutateComments =
    Boolean(commentsProjection) && canConnectionScopeMutateComments(connectionScope);
  const commentsPanelStatus =
    commentsProjection === null
      ? "Comments sync unavailable."
      : canMutateComments
        ? null
        : "Read-only connection.";
  const failCommentAction = useCallback((message: string): never => {
    setCommentsError(message);
    throw new Error(message);
  }, []);

  useEffect(() => {
    if (!canMutateComments) {
      setCommentDraftTarget(null);
      setSourceCommentRequest(null);
    }
  }, [canMutateComments]);

  const applyLocalCommentEvent = useCallback(
    (event: unknown): boolean => {
      const engine = getEngine();
      if (!engine) {
        setCommentsError("Comments are not connected.");
        return false;
      }
      const applied = engine.applyLocalMutationEvent(
        event as Parameters<typeof engine.applyLocalMutationEvent>[0],
      );
      if (!applied) {
        setCommentsError("Unable to update comments.");
        return false;
      }
      setCommentsError(null);
      engine.scheduleFlush();
      refreshCommentsProjection();
      return true;
    },
    [getEngine, refreshCommentsProjection],
  );

  const handleCreateCommentThread = useCallback(
    async (anchor: CommentAnchor, body: string) => {
      if (!canMutateComments) {
        return failCommentAction("Comments are read-only.");
      }
      const handle = getHandle();
      if (!handle || typeof handle.create_comment_thread !== "function") {
        return failCommentAction("Comments sync unavailable.");
      }
      setCommentsError(null);
      const projection = refreshCommentsProjection() ?? commentsProjection;
      const orderScope = commentAnchorThreadOrderScope(anchor);
      const afterThreadId =
        projection?.threads
          .filter((thread) => commentAnchorThreadOrderScope(thread.anchor) === orderScope)
          .at(-1)?.id ?? null;
      try {
        const event = handle.create_comment_thread(
          createLocalCommentEntityId("thread"),
          createLocalCommentEntityId("message"),
          anchor,
          body,
          afterThreadId,
          new Date().toISOString(),
        );
        if (!applyLocalCommentEvent(event)) {
          throw new Error("Unable to update comments.");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Create comment failed.";
        setCommentsError(message);
        throw error instanceof Error ? error : new Error(message);
      }
    },
    [
      applyLocalCommentEvent,
      canMutateComments,
      commentsProjection,
      failCommentAction,
      getHandle,
      refreshCommentsProjection,
    ],
  );

  const handleCreateDocumentComment = useCallback(
    (body: string) => handleCreateCommentThread({ kind: "notebook" }, body),
    [handleCreateCommentThread],
  );

  const handleCreatePanelComment = useCallback(
    async (body: string) => {
      if (!commentDraftTarget) {
        await handleCreateDocumentComment(body);
        return;
      }
      if (
        commentDraftTarget.anchor.kind === "source_range" &&
        !sourceRangeAnchorMatchesCurrentCell(commentDraftTarget.anchor)
      ) {
        failCommentAction("Selected source changed. Select the text again before commenting.");
        return;
      }
      if (
        commentDraftTarget.anchor.kind === "output" &&
        !outputCommentAnchorMatchesLiveState(commentDraftTarget.anchor)
      ) {
        failCommentAction(OUTPUT_COMMENT_STALE_MESSAGE);
        return;
      }
      await handleCreateCommentThread(commentDraftTarget.anchor, body);
      setCommentDraftTarget(null);
    },
    [commentDraftTarget, failCommentAction, handleCreateCommentThread, handleCreateDocumentComment],
  );

  const handleRequestSourceComment = useCallback(
    (anchor: SourceRangeCommentAnchor, rect: SourceCommentSelectionRect | null) => {
      setCommentsError(null);
      if (rect) {
        setSourceCommentRequest({ anchor, rect });
        return;
      }
      setSourceCommentRequest(null);
      setCommentDraftTarget({ anchor, quote: anchor.exact_quote ?? null });
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
      await handleCreateCommentThread(sourceCommentRequest.anchor, body);
      setSourceCommentRequest(null);
    },
    [handleCreateCommentThread, sourceCommentRequest],
  );

  const handleCancelSourceComment = useCallback(() => {
    setSourceCommentRequest(null);
  }, []);

  // The OS full name only labels the local author. We feed it through a peers
  // entry keyed by the local principal, mirroring the cloud presence model, so
  // synced peers and agents resolve their own labels instead of inheriting this
  // machine's user name.
  const commentAuthorPeers = useMemo<ActorDisplayPeer[]>(() => {
    const label = peerLabel.trim();
    if (!localActor || !label) return [];
    const [localPrincipal] = splitNotebookActorPrincipalOperator(localActor);
    return [{ participantKey: localPrincipal, label }];
  }, [localActor, peerLabel]);

  const resolveCommentAuthor = useCallback(
    (actorLabel: string): CommentAuthor => {
      const display = resolveActorDisplay({
        actorLabel,
        peers: commentAuthorPeers,
        source: connectionScope ? "cloud" : "local",
      });
      return {
        displayName: display.displayName,
        color: display.color,
        imageUrl: display.imageUrl,
        isAgent: display.isAgent,
        onBehalfOf: display.onBehalfOf,
        onBehalfOfColor: display.onBehalfOfColor,
      };
    },
    [commentAuthorPeers, connectionScope],
  );

  const resolveSourceLanguage = useCallback(
    (cellId: string): string | undefined => {
      const cell = getCellById(cellId);
      if (cell?.cell_type !== "code") return undefined;
      return runtime === "python" ? "python" : runtime === "deno" ? "typescript" : undefined;
    },
    [runtime],
  );

  const sourceCommentThreadsByCell = useMemo(() => {
    const map = new Map<string, SourceCommentThread[]>();
    for (const thread of commentsProjection?.threads ?? []) {
      if (thread.anchor.kind !== "source_range") continue;
      const list = map.get(thread.anchor.cell_id) ?? [];
      const firstMessage = thread.messages[0];
      const author = thread.created_by_actor_label
        ? resolveCommentAuthor(thread.created_by_actor_label)
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
  }, [commentsProjection, resolveCommentAuthor]);

  useEffect(() => {
    setSourceCommentThreads(sourceCommentThreadsByCell);
  }, [sourceCommentThreadsByCell]);

  const handleActivateCommentThread = useCallback((threadId: string) => {
    openNotebookRailPanel("comments");
    setCommentFocus((previous) => ({ threadId, nonce: (previous?.nonce ?? 0) + 1 }));
  }, []);

  const handleClearCommentDraftTarget = useCallback(() => {
    setCommentDraftTarget(null);
  }, []);

  const handleReplyCommentThread = useCallback(
    async (threadId: string, body: string) => {
      if (!canMutateComments) return;
      const handle = getHandle();
      if (!handle || typeof handle.reply_comment_thread !== "function") {
        return failCommentAction("Comments sync unavailable.");
      }
      setCommentsError(null);
      const projection = refreshCommentsProjection() ?? commentsProjection;
      const afterMessageId =
        projection?.threads.find((thread) => thread.id === threadId)?.messages.at(-1)?.id ?? null;
      try {
        const event = handle.reply_comment_thread(
          threadId,
          createLocalCommentEntityId("message"),
          body,
          afterMessageId,
          new Date().toISOString(),
        );
        if (!applyLocalCommentEvent(event)) {
          throw new Error("Unable to update comments.");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Reply failed.";
        setCommentsError(message);
        throw error instanceof Error ? error : new Error(message);
      }
    },
    [
      applyLocalCommentEvent,
      canMutateComments,
      commentsProjection,
      failCommentAction,
      getHandle,
      refreshCommentsProjection,
    ],
  );

  const handleResolveCommentThread = useCallback(
    async (threadId: string) => {
      if (!canMutateComments) return;
      const handle = getHandle();
      if (!handle || typeof handle.resolve_comment_thread !== "function") {
        return failCommentAction("Comments sync unavailable.");
      }
      try {
        const event = handle.resolve_comment_thread(threadId, new Date().toISOString());
        if (!applyLocalCommentEvent(event)) {
          throw new Error("Unable to update comments.");
        }
      } catch (error) {
        setCommentsError(error instanceof Error ? error.message : String(error));
      }
    },
    [applyLocalCommentEvent, canMutateComments, failCommentAction, getHandle],
  );

  const handleReopenCommentThread = useCallback(
    async (threadId: string) => {
      if (!canMutateComments) return;
      const handle = getHandle();
      if (!handle || typeof handle.reopen_comment_thread !== "function") {
        return failCommentAction("Comments sync unavailable.");
      }
      try {
        const event = handle.reopen_comment_thread(threadId);
        if (!applyLocalCommentEvent(event)) {
          throw new Error("Unable to update comments.");
        }
      } catch (error) {
        setCommentsError(error instanceof Error ? error.message : String(error));
      }
    },
    [applyLocalCommentEvent, canMutateComments, failCommentAction, getHandle],
  );

  const handleDemoteDetachedOutputCommentThread = useCallback(
    (threadId: string) => {
      if (!canMutateComments) return;
      const handle = getHandle();
      if (!handle || typeof handle.demote_comment_thread_to_notebook !== "function") {
        setCommentsError("Comments sync unavailable.");
        return;
      }
      try {
        handle.demote_comment_thread_to_notebook(threadId);
        setCommentsError(null);
        refreshCommentsProjection();
        getEngine()?.scheduleFlush();
      } catch (error) {
        setCommentsError(error instanceof Error ? error.message : String(error));
      }
    },
    [canMutateComments, getEngine, getHandle, refreshCommentsProjection],
  );

  useDemoteDetachedOutputCommentThreads({
    commentsProjection,
    enabled: canMutateComments,
    demoteThreadToNotebook: handleDemoteDetachedOutputCommentThread,
  });

  const handleFocusCommentThreadAnchor = useCallback((thread: CommentThreadSnapshot) => {
    const cellId = thread.badge_cell_ids[0];
    if (cellId) {
      setFocusedCellId(cellId);
      flushCellUIState();
    }
  }, []);

  const commentsPanel = (
    <NotebookCommentsPanel
      projection={commentsProjection}
      readOnly={!canMutateComments}
      draftTarget={canMutateComments ? commentDraftTarget : null}
      statusMessage={commentsPanelStatus}
      errorMessage={commentsError}
      onClearDraftTarget={commentDraftTarget ? handleClearCommentDraftTarget : undefined}
      onCreateThread={canMutateComments ? handleCreatePanelComment : undefined}
      onReplyThread={canMutateComments ? handleReplyCommentThread : undefined}
      onResolveThread={canMutateComments ? handleResolveCommentThread : undefined}
      onReopenThread={canMutateComments ? handleReopenCommentThread : undefined}
      onFocusThreadAnchor={handleFocusCommentThreadAnchor}
      resolveCommentAuthor={resolveCommentAuthor}
      focusedThreadId={commentFocus?.threadId ?? null}
      focusNonce={commentFocus?.nonce ?? 0}
      resolveSourceLanguage={resolveSourceLanguage}
    />
  );

  // Connection/identity slot source: daemon lifecycle, stable for the
  // app's lifetime (the dot must transition on daemon restarts).
  const desktopConnectionStatus = useMemo(
    () => createDesktopConnectionStatusSource(host.daemonEvents),
    [host],
  );
  useEffect(() => () => desktopConnectionStatus.dispose(), [desktopConnectionStatus]);

  useEffect(() => {
    installExecutionPerformanceApi();
  }, []);

  useEffect(() => {
    if (lifecycle.lifecycle !== "AwaitingEnvBuild") {
      setEnvBuildDialogOpen(false);
      setDismissedEnvBuildDetails(null);
      return;
    }
    if (errorDetails !== dismissedEnvBuildDetails) {
      setEnvBuildDialogOpen(true);
    }
  }, [dismissedEnvBuildDetails, errorDetails, lifecycle.lifecycle]);

  // Clear banner dismissal whenever the kernel leaves Error or the
  // details text changes, so the next failure re-presents the banner
  // even if the user dismissed an earlier identical-looking one.
  useEffect(() => {
    if (lifecycle.lifecycle !== "Error") {
      setDismissedLaunchError(null);
    }
  }, [lifecycle.lifecycle]);

  // Set up daemon comm sender for widget messages
  useEffect(() => {
    setDaemonCommSender(async (message: unknown) => {
      const msg = message as {
        header: { msg_type: string };
        content: Record<string, unknown>;
        buffers?: ArrayBuffer[];
      };
      await sendCommMessage(msg);
    });

    return () => {
      setDaemonCommSender(null);
    };
  }, [sendCommMessage]);

  // Set up CRDT comm writer for widget state updates.
  // Writes directly to CommsDoc via WASM — no SendComm round-trip.
  useEffect(() => {
    setCrdtCommWriter((commId: string, patch: Record<string, unknown>) => {
      const handle = getHandle();
      if (!handle) return;
      handle.set_comm_state_batch(commId, JSON.stringify(patch));
      triggerSync();
    });
    return () => {
      setCrdtCommWriter(null);
    };
  }, [getHandle, triggerSync]);

  // E2E-only bridge for driving widget updates through the real pipeline
  // (WidgetUpdateManager → debounced CRDT write → daemon → kernel) from
  // a WebDriver spec, without reaching into the security-isolated iframe.
  // Gated on `VITE_E2E` — `cargo xtask e2e build` sets it, production
  // builds don't, so these globals aren't exposed to end users.
  useEffect(() => {
    if (!import.meta.env.VITE_E2E) return;
    const w = window as unknown as Record<string, unknown>;
    w.__nteractWidgetUpdate = (commId: string, patch: Record<string, unknown>) => {
      updateManager.updateAndPersist(commId, patch);
    };
    w.__nteractWidgetStore = widgetStore;
    w.__nteractWidgetTest = {
      selectionCountForComm(commId: string | null): number | null {
        const models =
          commId === null
            ? Array.from(widgetStore.getSnapshot().values())
            : [widgetStore.getModel(commId)];
        for (const model of models) {
          const selection = model?.state.selection as
            | { view?: { byteLength?: number }; shape?: unknown }
            | undefined;
          const shape = selection?.shape;
          if (Array.isArray(shape) && typeof shape[0] === "number") return shape[0];
          const byteLength = selection?.view?.byteLength;
          if (typeof byteLength === "number") return byteLength;
        }
        return null;
      },
    };
    return () => {
      delete w.__nteractWidgetUpdate;
      delete w.__nteractWidgetStore;
      delete w.__nteractWidgetTest;
    };
  }, [widgetStore]);

  // ── CRDT → WidgetStore projection via SyncEngine.commChanges$ ──────
  // Replaces the old Jupyter message synthesis path. The SyncEngine diffs
  // RuntimeStateDoc topology plus CommsDoc state, resolves ContentRefs via
  // WASM, and emits opened/updated/closed events. We drive the WidgetStore
  // directly.
  useEffect(() => {
    const engine = getEngine();
    if (!engine) return;

    const commSub = engine.commChanges$.subscribe((changes) => {
      applyWidgetCommChangesToStore(widgetStore, changes, {
        // Suppress CRDT echoes for keys with pending optimistic values
        // (e.g. slider being dragged — don't clobber with stale echo).
        shouldSuppressEcho: (commId, state) => updateManager.shouldSuppressEcho(commId, state),
        clearComm: (commId) => updateManager.clearComm(commId),
        resolveOutputs: resolveCommOutputs,
      });
    });

    // Custom comm messages (buttons, model.send()) are ephemeral events
    // delivered via broadcast, not CRDT state. Route to WidgetStore.
    const customSub = engine.commBroadcasts$.subscribe((broadcast) => {
      applyWidgetCommBroadcastToStore(widgetStore, broadcast);
    });

    return () => {
      commSub.unsubscribe();
      customSub.unsubscribe();
    };
  }, [getEngine, widgetStore]);

  // Reset the update manager when kernel restarts so fresh echoes
  // from the new session aren't suppressed by stale optimistic state.
  useEffect(() => {
    if (
      kernelStatus === KERNEL_STATUS.NOT_STARTED ||
      kernelStatus === KERNEL_STATUS.AWAITING_TRUST ||
      kernelStatus === KERNEL_STATUS.AWAITING_ENV_BUILD
    ) {
      updateManager.reset();
    }
  }, [kernelStatus]);

  // Re-project comms when blob_port changes (deferred comms retry).
  const blobPort = useBlobPort();
  useEffect(() => {
    if (blobPort !== null) {
      getEngine()?.reProjectComms();
    }
  }, [blobPort, getEngine]);

  const focusedCellId = useFocusedCellId();
  const focusCellInStore = useCallback((cellId: string) => {
    setFocusedCellId(cellId);
    flushCellUIState();
  }, []);
  const handleNotebookViewFocus = useCallback(() => {}, []);

  const getOutlineStatusLabel = useOutlineStatusLabel();
  const notebookViewModel = useNotebookViewModel({ getOutlineStatusLabel });
  const outlineItems = notebookViewModel.outlineItems;
  const markdownHeadingAnchorsByCellId = notebookViewModel.markdownHeadingAnchorsByCellId;
  const activeOutlineItemId = useActiveOutlineItemId(
    outlineItems,
    cellIds,
    !railCollapsed && activeRailPanel === "outline",
  );
  const { selectedOutlineItemId, handleSelectOutlineItem } = useOutlineSelection({
    outlineItems,
    focusedCellId,
    setFocusedCellId: focusCellInStore,
  });

  // ── Sync host-owned transient search state into shared cell UI store ─
  useNotebookCellUIStateBridge({
    searchQuery: globalFind.query,
    searchCurrentMatch: globalFind.currentMatch,
  });

  // Env manager (uv / conda / pixi) — drives the toolbar badge and
  // which dep header renders. Derived from RuntimeState + WASM-metadata
  // signals in priority order: running kernel's env_source, inline
  // deps, detected project file. See `deriveEnvManager` in runtimed.
  const envType = deriveEnvManager(runtimeState, {
    isUvConfigured,
    isCondaConfigured,
    environmentYmlHasDeps: Boolean(environmentYmlInfo?.has_dependencies),
    pixiHasDeps: Boolean(pixiInfo?.has_dependencies || pixiInfo?.has_pypi_dependencies),
  });

  // Pre-start hint for the env badge: same answer as envType when the
  // daemon hasn't yet reported env_source (kernel still launching).
  // Once envSource is set, toolbar renders the real label off it.
  const envTypeHint = envSource ? null : envType;

  // Pool state - prewarm pool errors from daemon (typo'd default packages, etc.).
  const activePoolManager = envType ?? defaultPythonEnv;
  const {
    uvError: poolUvError,
    condaError: poolCondaError,
    pixiError: poolPixiError,
    dismissUvError: dismissPoolUvError,
    dismissCondaError: dismissPoolCondaError,
    dismissPixiError: dismissPoolPixiError,
  } = usePoolState(activePoolManager);
  const handleOpenPoolSettings = useCallback(() => {
    host.settings.openWindow().catch((e) => {
      console.error("Failed to open settings:", e);
    });
  }, [host]);

  // Auto-updater
  const {
    status: updateStatus,
    version: updateVersion,
    checkForUpdate,
    restartToUpdate,
  } = useUpdater();

  // Environment preparation progress
  const envProgress = useEnvProgress();

  // Reset progress error when dependencies change (allows retry after fixing issues)
  const progressError = envProgress.error;
  const progressReset = envProgress.reset;
  useEffect(() => {
    if (envSyncState && !envSyncState.inSync && progressError) {
      progressReset();
    }
  }, [envSyncState, progressError, progressReset]);

  // Derive sync state from daemon's envSyncState for inline environments
  // Also shows for prewarmed kernels when user adds inline deps (prewarmed->inline drift)
  const uvDerivedSyncState: EnvSyncState | null = useMemo(() => {
    // Show for uv:inline or uv:prewarmed (when user adds deps to prewarmed kernel)
    const isUvEnv = envSource === "uv:inline" || envSource === "uv:prewarmed" || !envSource;
    if (!isUvEnv || !envSyncState) return null;
    // Only show dirty state for prewarmed if there's actually a diff with UV deps
    if (envSource === "uv:prewarmed" && !envSyncState.diff?.added?.length) return null;
    if (envSyncState.inSync) return { status: "synced" };
    return {
      status: "dirty",
      added: envSyncState.diff?.added ?? [],
      removed: envSyncState.diff?.removed ?? [],
    };
  }, [envSource, envSyncState]);

  const condaDerivedSyncState: EnvSyncState | null = useMemo(() => {
    // Show for conda:inline or conda:prewarmed (when user adds deps to prewarmed kernel)
    const isCondaEnv = envSource === "conda:inline" || envSource === "conda:prewarmed";
    if (!isCondaEnv || !envSyncState) return null;
    // Only show dirty state for prewarmed if there's actually a diff with conda deps
    if (envSource === "conda:prewarmed" && !envSyncState.diff?.added?.length) return null;
    if (envSyncState.inSync) return { status: "synced" };
    return {
      status: "dirty",
      added: envSyncState.diff?.added ?? [],
      removed: envSyncState.diff?.removed ?? [],
    };
  }, [envSource, envSyncState]);

  const pixiDerivedSyncState: EnvSyncState | null = useMemo(() => {
    const isPixiEnv = envSource?.startsWith("pixi:");
    if (!isPixiEnv || !envSyncState) return null;
    if (envSource === "pixi:prewarmed" && !envSyncState.diff?.added?.length) return null;
    if (envSyncState.inSync) return { status: "synced" };
    return {
      status: "dirty",
      added: envSyncState.diff?.added ?? [],
      removed: envSyncState.diff?.removed ?? [],
    };
  }, [envSource, envSyncState]);

  // Derive sync state for Deno kernels
  const denoDerivedSyncState: {
    status: "synced" | "dirty";
  } | null = useMemo(() => {
    // Only show for Deno kernels (env_source is "deno")
    if (envSource !== "deno" || !envSyncState) return null;
    // Check if deno config has drifted
    if (envSyncState.inSync) return { status: "synced" };
    if (envSyncState.diff?.denoChanged) return { status: "dirty" };
    return null;
  }, [envSource, envSyncState]);

  const packagesRailOpen = !railCollapsed && activeRailPanel === "packages";

  const handleRailPanelChange = useCallback((panelId: NotebookRailPanelId) => {
    openNotebookRailPanel(panelId);
  }, []);

  const handleTogglePackagesRail = useCallback(() => {
    if (!shellCapabilities.canViewPackages) {
      logger.debug("[App] handleTogglePackagesRail: package view capability unavailable, skipping");
      return;
    }
    toggleNotebookRailPanel("packages");
  }, [shellCapabilities.canViewPackages]);

  const handleNavigateOutlineItem = useCallback((item: NotebookOutlineItem, href: string) => {
    return navigateNotebookOutlineItem(item, href, { headingHashTarget: "cell" });
  }, []);

  const getObservedHeads = useCallback(() => getHandle()?.get_heads_hex() ?? [], [getHandle]);

  const resetDismissedEnvBuildDetails = useCallback(() => {
    setDismissedEnvBuildDetails(null);
  }, []);

  const showEnvBuildDialog = useCallback(() => {
    resetDismissedEnvBuildDetails();
    setEnvBuildDialogOpen(true);
  }, [resetDismissedEnvBuildDetails]);

  const getProjectEnvironmentFilePath = useCallback(() => {
    if (
      runtimeState.project_context.state === "Detected" &&
      runtimeState.project_context.project_file.kind === "EnvironmentYml"
    ) {
      return runtimeState.project_context.project_file.absolute_path;
    }
    return undefined;
  }, [runtimeState.project_context]);

  const executeCellWithPerf = useCallback(
    async (cellId: string) => {
      const executionId = createClientExecutionId();
      const options: ExecuteCellOptions = { executionId };
      markExecutionPerformance("client.execute.request.start", {
        cellId,
        executionId,
        clientGeneratedExecutionId: true,
      });
      attachExecutionPerformanceId(cellId, executionId);

      let response = await executeCell(cellId, options);
      markClientExecuteResponse(
        "client.execute.response",
        cellId,
        response,
        { clientGeneratedExecutionId: true },
        executionId,
      );

      if (response.result === "execution_id_rejected") {
        logger.warn(
          "[App] client-generated execution_id rejected; retrying with daemon-generated id",
          response.reason,
        );
        markExecutionPerformance("client.execute.retry_without_execution_id", {
          cellId,
          executionId,
          reason: response.reason,
        });
        response = await executeCell(cellId);
        markClientExecuteResponse("client.execute.retry_response", cellId, response, {
          retryWithoutClientExecutionId: true,
        });
      }
      return response;
    },
    [executeCell],
  );

  const executeCellGuardedWithPerf = useCallback(
    async (cellId: string, provenance: Parameters<typeof executeCellGuarded>[1]) => {
      const executionId = createClientExecutionId();
      const options: ExecuteCellOptions = { executionId };
      markExecutionPerformance("client.execute_guarded.request.start", {
        cellId,
        executionId,
        clientGeneratedExecutionId: true,
      });
      attachExecutionPerformanceId(cellId, executionId);

      let response = await executeCellGuarded(cellId, provenance, options);
      markClientExecuteResponse(
        "client.execute_guarded.response",
        cellId,
        response,
        { clientGeneratedExecutionId: true },
        executionId,
      );

      if (response.result === "execution_id_rejected") {
        logger.warn(
          "[App] client-generated guarded execution_id rejected; retrying with daemon-generated id",
          response.reason,
        );
        markExecutionPerformance("client.execute_guarded.retry_without_execution_id", {
          cellId,
          executionId,
          reason: response.reason,
        });
        response = await executeCellGuarded(cellId, provenance);
        markClientExecuteResponse("client.execute_guarded.retry_response", cellId, response, {
          retryWithoutClientExecutionId: true,
        });
      }
      return response;
    },
    [executeCellGuarded],
  );

  const {
    envBuildCreating,
    handleEnvBuildCreate,
    handleExecuteCell: handleExecuteCellAction,
    handleRestartAndRunAll,
    handleRestartKernel,
    handleRunAllCells,
    handleStartKernel,
    handleStartKernelWithPyproject,
    handleSyncDeps,
    handleTrustApprove,
    handleTrustApproveOnly,
    handleTrustDecline,
    handleTrustDialogOpenChange,
    hasPendingTrustAction,
    justSynced,
    openTrustDialogForKernelStart,
    setTrustActionNotice,
    trustActionNotice,
    trustApprovalHandoffPending,
    trustApproveLabel,
    trustApproveOnlyLabel,
    trustDialogDescription,
    trustDialogOpen,
    tryStartKernel,
  } = useNotebookActionPolicy({
    canExecute: shellCapabilities.canExecute,
    sessionReady,
    kernelStatus,
    envSource,
    envSyncState,
    getObservedHeads,
    resetEnvProgress: envProgress.reset,
    flushSync,
    checkTrust,
    approveTrust,
    launchKernel,
    executeCell: executeCellWithPerf,
    executeCellGuarded: executeCellGuardedWithPerf,
    shutdownKernel,
    syncEnvironment,
    approveProjectEnvironment,
    runAllCells: daemonRunAllCells,
    runAllCellsGuarded,
    getProjectEnvironmentFilePath,
    resetDismissedEnvBuildDetails,
    showEnvBuildDialog,
  });

  const handleExecuteCell = useCallback(
    (cellId: string) => {
      startExecutionPerformanceTrace(cellId, { source: "NotebookView" });
      void Promise.resolve(handleExecuteCellAction(cellId)).finally(() => {
        markExecutionPerformance("app.execute.handler.settled", { cellId });
      });
    },
    [handleExecuteCellAction],
  );

  const handleEnvBuildDialogOpenChange = useCallback(
    (open: boolean) => {
      setEnvBuildDialogOpen(open);
      if (!open) {
        setDismissedEnvBuildDetails(errorDetails);
      }
    },
    [errorDetails],
  );

  const { kernelStatus: displayKernelStatus, statusKey: displayStatusKey } =
    getTrustApprovalHandoffDisplayStatus({
      pending: trustApprovalHandoffPending,
      kernelStatus,
      statusKey,
    });

  const handleAddCell = useCallback(
    (type: "code" | "markdown" | "raw", afterCellId?: string | null) => {
      if (!shellCapabilities.canEditStructure) {
        logger.debug("[App] handleAddCell: structure edit capability unavailable, skipping");
        return null;
      }
      return addCell(type, afterCellId);
    },
    [addCell, shellCapabilities.canEditStructure],
  );

  // Cmd+S keyboard shortcut. The native menu item is routed through
  // host.commands.run("notebook.save") by the Tauri menu bridge.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [save]);

  // Derive a filename + ephemeral flag from a path (or its absence). Shared
  // between the mount-time `getReadyInfo` pull, the `daemon:ready` event, and
  // the `path_changed` broadcast. Keeping all three paths identical prevents
  // "one of them forgot to update titleBase" bugs.
  const applyNotebookPath = useCallback((path: string | null | undefined) => {
    if (path) {
      const parts = path.split(/[\\/]/);
      setTitleBase(parts[parts.length - 1] || "Untitled.ipynb");
      setEphemeral(false);
    } else {
      setTitleBase("Untitled.ipynb");
      setEphemeral(true);
    }
  }, []);

  // Path transitions are driven by `RuntimeStateDoc.path` (frame 0x05).
  // A non-null value means the room is file-backed; a null value (only
  // really at first mount before sync catches up) keeps the room in
  // untitled state. The runtime state hook returns the same default
  // until the daemon's first state sync arrives, so this effect is a
  // straight projection.
  const runtimePath = runtimeState.path;
  useEffect(() => {
    applyNotebookPath(runtimePath);
  }, [applyNotebookPath, runtimePath]);

  // Title is purely a function of `ephemeral`. Untitled notebooks get
  // the `*` prefix; saved notebooks render their filename. Autosave
  // (2s quiet, 10s max) keeps the file current within seconds of any
  // edit, so the file-backed case never shows an unsaved-changes dot.
  useEffect(() => {
    if (titleBase == null) return;
    const next = ephemeral === true ? `* ${titleBase}` : titleBase;
    host.window.setTitle(next).catch(() => {
      // Window may have been closed mid-render.
    });
  }, [host, ephemeral, titleBase]);

  // Cmd+F to open global find
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        globalFind.open();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [globalFind.open]);

  // Cmd+O keyboard shortcut. Menu item routes through
  // host.commands.run("notebook.open") via the Tauri menu bridge.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "o") {
        e.preventDefault();
        openNotebook();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openNotebook]);

  // Route all notebook-level commands to their latest implementations via
  // a single ref. The ref is updated every render; the host-level registration
  // below runs only once per host, so a native menu event that lands during
  // a state-driven re-render never finds the slot empty — the previous
  // design re-registered every command on focused cell changes, which
  // opened a "no handler" window any menu click could fall into.
  const commandHandlersRef = useRef({
    save,
    openNotebook,
    cloneNotebook,
    handleAddCell,
    clearOutputs,
    handleRunAllCells,
    handleRestartAndRunAll,
    checkForUpdate,
  });
  commandHandlersRef.current = {
    save,
    openNotebook,
    cloneNotebook,
    handleAddCell,
    clearOutputs,
    handleRunAllCells,
    handleRestartAndRunAll,
    checkForUpdate,
  };

  useEffect(() => {
    const disposables = [
      host.commands.register("notebook.save", () => {
        commandHandlersRef.current.save();
      }),
      host.commands.register("notebook.open", () => {
        commandHandlersRef.current.openNotebook();
      }),
      host.commands.register("notebook.clone", () => {
        commandHandlersRef.current.cloneNotebook();
      }),
      host.commands.register("notebook.insertCell", ({ type }) => {
        const h = commandHandlersRef.current;
        h.handleAddCell(type, getFocusedCellId());
      }),
      host.commands.register("notebook.clearOutputs", async () => {
        const h = commandHandlersRef.current;
        const focusedCellId = getFocusedCellId();
        if (!focusedCellId) return;
        const cell = getNotebookCellsSnapshot().find((c) => c.id === focusedCellId);
        if (!cell || cell.cell_type !== "code") return;
        await h.clearOutputs(focusedCellId);
      }),
      host.commands.register("notebook.clearAllOutputs", async () => {
        const h = commandHandlersRef.current;
        const codeCells = getNotebookCellsSnapshot().filter((c) => c.cell_type === "code");
        if (codeCells.length === 0) return;
        await h.clearOutputs(codeCells.map((cell) => cell.id));
      }),
      host.commands.register("notebook.runAll", () => {
        commandHandlersRef.current.handleRunAllCells();
      }),
      host.commands.register("notebook.restartAndRunAll", () => {
        commandHandlersRef.current.handleRestartAndRunAll();
      }),
      host.commands.register("updater.check", () => {
        commandHandlersRef.current.checkForUpdate();
      }),
    ];
    return () => disposables.forEach((d) => d());
  }, [host]);

  // Listen for daemon startup progress events
  useEffect(() => {
    // Helper to cancel any pending ready timeout
    const cancelReadyTimeout = () => {
      if (readyTimeoutRef.current) {
        clearTimeout(readyTimeoutRef.current);
        readyTimeoutRef.current = null;
      }
    };

    const unlistenProgress = host.daemonEvents.onProgress((payload) => {
      const status = payload as DaemonStatus;

      // Cancel any pending ready timeout before setting new status
      cancelReadyTimeout();
      setDaemonStatus(status);

      // Clear status after a short delay when daemon is ready
      if (status?.status === "ready") {
        readyTimeoutRef.current = setTimeout(() => {
          // Only clear if still in ready state (use functional update)
          setDaemonStatus((prev) => (prev?.status === "ready" ? null : prev));
          readyTimeoutRef.current = null;
        }, 1000);
      }
    });

    // Listen for daemon disconnection (mid-session)
    const unlistenDisconnect = host.daemonEvents.onDisconnected(() => {
      cancelReadyTimeout();
      setDaemonStatus({
        status: "failed",
        error: "Runtime disconnected. Attempting to reconnect...",
      });
    });

    // Listen for daemon unavailable (startup failure, fires after sync timeout)
    const unlistenUnavailable = host.daemonEvents.onUnavailable((payload) => {
      cancelReadyTimeout();
      setDaemonStatus({
        status: "failed",
        error: `${payload.message} ${payload.guidance}`,
      });
    });

    // Shared handler for both the live event and the cached backfill below.
    // Factored out so the two paths can never drift.
    const handleReady = (
      payload:
        | {
            runtime?: string;
            ephemeral?: boolean;
            notebook_path?: string | null;
          }
        | null
        | undefined,
    ) => {
      cancelReadyTimeout();
      setDaemonStatus(null);
      // Set or clear the runtime hint — clearing prevents stale hints
      // when a window is reused to open a different notebook (Open path
      // sends runtime: null).
      setRuntimeHint(payload?.runtime ?? null);
      // Sync titlebar: derive filename + ephemeral from the path carried
      // on the ready payload.
      if (payload) {
        if (typeof payload.ephemeral === "boolean") {
          applyNotebookPath(payload.ephemeral ? null : (payload.notebook_path ?? null));
        } else if (payload.notebook_path !== undefined) {
          applyNotebookPath(payload.notebook_path);
        }
      }
    };

    // Listen for daemon ready (reconnection success, Finder-reuse of an
    // untitled window into a file-backed one, etc.). `onReady` internally
    // also backfills from the Rust-side cache, so a `daemon:ready` that
    // fired before this subscription still hydrates the state.
    const unlistenReady = host.daemonEvents.onReady(handleReady);

    // Check daemon status on mount (in case events fired before React was ready)
    // Small delay to let initial events settle
    const checkTimeout = setTimeout(() => {
      host.daemon.isConnected().then((connected) => {
        if (!connected) {
          setDaemonStatus((prev) => {
            // Only set if no status is already shown
            if (!prev) {
              return {
                status: "failed",
                error: "Runtime daemon not available. Click Retry to connect.",
              };
            }
            return prev;
          });
        }
      });
    }, 500);

    return () => {
      clearTimeout(checkTimeout);
      cancelReadyTimeout();
      unlistenProgress();
      unlistenDisconnect();
      unlistenUnavailable();
      unlistenReady();
    };
  }, [host, applyNotebookPath]);

  // Cmd+Shift+I to toggle isolation test panel (dev only)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "i") {
        e.preventDefault();
        setShowIsolationTest((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <PresenceProvider peerId={peerIdRef.current} peerLabel={peerLabel} actorLabel={localActor}>
      <div className="flex h-full flex-col bg-background overflow-hidden">
        {gitInfo && (
          <DebugBanner
            branch={gitInfo.branch}
            commit={gitInfo.commit}
            description={gitInfo.description}
            daemonVersion={daemonInfo?.version}
            isDevMode={daemonInfo?.is_dev_mode}
          />
        )}
        <DaemonStatusBanner
          status={daemonStatus}
          onDismiss={() => setDaemonStatus(null)}
          onRetry={() => {
            setDaemonStatus({ status: "checking" });
            host.daemon
              .reconnect()
              .then(() => {
                // Success - daemon:ready event will clear the banner
              })
              .catch((e) => {
                setDaemonStatus({
                  status: "failed",
                  error: `Reconnection failed: ${e}`,
                });
              });
          }}
        />
        <PoolErrorBanner
          uvError={poolUvError}
          condaError={poolCondaError}
          pixiError={poolPixiError}
          onDismissUv={dismissPoolUvError}
          onDismissConda={dismissPoolCondaError}
          onDismissPixi={dismissPoolPixiError}
          onOpenSettings={handleOpenPoolSettings}
        />
        {needsApproval &&
          !trustApprovalHandoffPending &&
          (kernelStatus === KERNEL_STATUS.NOT_STARTED ||
            kernelStatus === KERNEL_STATUS.AWAITING_TRUST) && (
            <UntrustedBanner onReviewClick={openTrustDialogForKernelStart} />
          )}
        {trustActionNotice && (
          <div className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
            <span>{trustActionNotice}</span>
            <button
              type="button"
              className="text-xs font-medium text-amber-800 hover:text-amber-950 dark:text-amber-200 dark:hover:text-amber-50"
              onClick={() => setTrustActionNotice(null)}
            >
              Dismiss
            </button>
          </div>
        )}
        {shouldShowKernelLaunchErrorBanner({
          lifecycle,
          errorDetails,
          errorReason,
          runtime,
        }) &&
          dismissedLaunchError !== errorDetails && (
            <KernelLaunchErrorBanner
              errorDetails={errorDetails as string}
              onRetry={() => {
                setDismissedLaunchError(null);
                tryStartKernel();
              }}
              onDismiss={() => setDismissedLaunchError(errorDetails)}
            />
          )}
        <NotebookToolbar
          kernelStatus={displayKernelStatus}
          statusKey={displayStatusKey}
          lifecycle={lifecycle}
          errorReason={errorReason}
          kernelErrorMessage={errorDetails}
          envSource={envSource}
          condaPython={condaDependencies?.python ?? null}
          condaChannels={condaDependencies?.channels ?? null}
          projectContext={runtimeState.project_context}
          envTypeHint={envTypeHint}
          envProgress={envProgress.isActive || envProgress.error ? envProgress : null}
          runtime={runtime}
          onStartKernel={handleStartKernel}
          onInterruptKernel={interruptKernel}
          onRestartKernel={handleRestartKernel}
          onRunAllCells={handleRunAllCells}
          onRestartAndRunAll={handleRestartAndRunAll}
          focusedCellId={focusedCellId}
          lastCellId={cellIds.length > 0 ? cellIds[cellIds.length - 1] : null}
          onAddCell={handleAddCell}
          onToggleDependencies={handleTogglePackagesRail}
          isDepsOpen={packagesRailOpen}
          capabilities={shellCapabilities}
          depsOutOfSync={envSyncState ? !envSyncState.inSync : false}
          updateStatus={updateStatus}
          updateVersion={updateVersion}
          onRestartToUpdate={restartToUpdate}
          trailingControls={
            // Connection/identity slot: renders nothing for a purely local
            // session (isRemoteNotebookContext) — conditionality is the
            // point. The source derives from daemon lifecycle events (the
            // IPC transport's status is constant in practice), and the
            // copy is scoped to the link it measures.
            <NotebookConnectionIdentity
              capabilities={shellCapabilities}
              connectionStatus$={desktopConnectionStatus}
              connectionLabel="Daemon connection"
            />
          }
        />
        {globalFind.isOpen && (
          <GlobalFindBar
            query={globalFind.query}
            matchCount={globalFind.matches.length}
            currentMatchIndex={globalFind.currentMatchIndex}
            onQueryChange={globalFind.setQuery}
            onNextMatch={globalFind.nextMatch}
            onPrevMatch={globalFind.prevMatch}
            onClose={globalFind.close}
          />
        )}
        {showIsolationTest && <IsolationTest />}
        <TrustDialog
          open={trustDialogOpen}
          onOpenChange={handleTrustDialogOpenChange}
          trustInfo={trustInfo}
          typosquatWarnings={typosquatWarnings}
          onApprove={handleTrustApprove}
          onApproveOnly={hasPendingTrustAction ? handleTrustApproveOnly : undefined}
          onDecline={handleTrustDecline}
          loading={trustLoading}
          daemonMode={true}
          approveLabel={trustApproveLabel}
          approveOnlyLabel={trustApproveOnlyLabel}
          description={trustDialogDescription}
          approvalError={approvalError}
        />
        <EnvBuildDecisionDialog
          open={envBuildDialogOpen}
          onOpenChange={handleEnvBuildDialogOpenChange}
          errorDetails={errorDetails}
          onCreate={handleEnvBuildCreate}
          creating={envBuildCreating}
        />
        <NotebookDocumentShell
          capabilities={shellCapabilities}
          stageLabel="Notebook editor"
          stageClassName={cn(
            "flex-row min-w-0 flex-1",
            !railCollapsed && NOTEBOOK_RAIL_TAKEOVER_STAGE_CLASS_NAME,
          )}
          rail={
            <NotebookDocumentRail
              viewModel={notebookViewModel}
              activePanelId={activeRailPanel}
              collapsed={railCollapsed}
              outlineCellIds={cellIds}
              activeOutlineItemId={activeOutlineItemId}
              selectedOutlineItemId={selectedOutlineItemId}
              selectedOutlineCellId={focusedCellId}
              onActivePanelChange={handleRailPanelChange}
              onCollapsedChange={setNotebookRailCollapsed}
              onSelectOutlineItem={handleSelectOutlineItem}
              onNavigateOutlineItem={handleNavigateOutlineItem}
              commentsPanel={commentsPanel}
              packagesPanel={
                <NotebookPackagesPanel readOnly={!shellCapabilities.canManagePackages}>
                  {runtime === "python" && hasUvDependencies && hasCondaDependencies && (
                    <div className="rounded-md border border-amber-300 bg-amber-50/60 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
                      <div className="mb-2 flex items-center gap-2 font-medium">
                        <span className="shrink-0">&#9888;</span>
                        <span>This notebook has both uv and conda dependencies.</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          disabled={clearingDeps || !shellCapabilities.canManagePackages}
                          onClick={async () => {
                            setClearingDeps(true);
                            try {
                              await clearAllCondaDeps();
                            } finally {
                              setClearingDeps(false);
                            }
                          }}
                          className="rounded border border-fuchsia-300 bg-fuchsia-100 px-2 py-0.5 text-xs font-medium text-fuchsia-800 transition-colors hover:bg-fuchsia-200 disabled:cursor-not-allowed disabled:opacity-50 dark:border-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-300 dark:hover:bg-fuchsia-800/50"
                        >
                          Use uv ({dependencies?.dependencies?.length ?? 0}{" "}
                          {(dependencies?.dependencies?.length ?? 0) === 1 ? "package" : "packages"}
                          )
                        </button>
                        <button
                          disabled={clearingDeps || !shellCapabilities.canManagePackages}
                          onClick={async () => {
                            setClearingDeps(true);
                            try {
                              await clearAllUvDeps();
                            } finally {
                              setClearingDeps(false);
                            }
                          }}
                          className="rounded border border-emerald-300 bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 transition-colors hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 dark:hover:bg-emerald-800/50"
                        >
                          Use conda ({condaDependencies?.dependencies?.length ?? 0}{" "}
                          {(condaDependencies?.dependencies?.length ?? 0) === 1
                            ? "package"
                            : "packages"}
                          )
                        </button>
                      </div>
                    </div>
                  )}
                  {runtime === "deno" && (
                    <DenoDependencyHeader
                      variant="rail"
                      denoConfigInfo={denoConfigInfo}
                      flexibleNpmImports={flexibleNpmImports}
                      onSetFlexibleNpmImports={setFlexibleNpmImports}
                      readOnly={!shellCapabilities.canManagePackages}
                      syncState={denoDerivedSyncState}
                      syncing={kernelStatus === KERNEL_STATUS.STARTING}
                      onSyncNow={handleSyncDeps}
                      justSynced={justSynced}
                    />
                  )}
                  {runtime === "python" && envType === "conda" && (
                    <CondaDependencyHeader
                      variant="rail"
                      dependencies={condaDependencies?.dependencies ?? []}
                      channels={condaDependencies?.channels ?? []}
                      python={condaDependencies?.python ?? null}
                      loading={condaDepsLoading}
                      envSource={envSource}
                      readOnly={!shellCapabilities.canManagePackages}
                      syncState={condaDerivedSyncState}
                      onAdd={addCondaDependency}
                      onRemove={removeCondaDependency}
                      onSetChannels={setCondaChannels}
                      onSetPython={setCondaPython}
                      onSyncNow={handleSyncDeps}
                      onRetryLaunch={tryStartKernel}
                      envProgress={envProgress.envType === "conda" ? envProgress : null}
                      onResetProgress={envProgress.reset}
                      environmentYmlInfo={environmentYmlInfo}
                      environmentYmlDeps={environmentYmlDeps}
                      justSynced={justSynced}
                    />
                  )}
                  {runtime === "python" && envType === "pixi" && (
                    <PixiDependencyHeader
                      variant="rail"
                      pixiInfo={pixiInfo}
                      envSource={envSource}
                      readOnly={!shellCapabilities.canManagePackages}
                      syncState={pixiDerivedSyncState}
                      onSyncNow={handleSyncDeps}
                      justSynced={justSynced}
                    />
                  )}
                  {runtime === "python" && envType !== "conda" && envType !== "pixi" && (
                    <DependencyHeader
                      variant="rail"
                      dependencies={dependencies?.dependencies ?? []}
                      requiresPython={dependencies?.requires_python ?? null}
                      loading={depsLoading}
                      readOnly={!shellCapabilities.canManagePackages}
                      onAdd={addDependency}
                      onRemove={removeDependency}
                      onSetRequiresPython={setRequiresPython}
                      syncState={uvDerivedSyncState}
                      onSyncNow={handleSyncDeps}
                      pyprojectInfo={pyprojectInfo}
                      pyprojectDeps={pyprojectDeps}
                      onImportFromPyproject={importFromPyproject}
                      onUseProjectEnv={handleStartKernelWithPyproject}
                      isUsingProjectEnv={envSource === "uv:pyproject"}
                      justSynced={justSynced}
                    />
                  )}
                  {runtime === null && (
                    <div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
                      Runtime metadata is still loading.
                    </div>
                  )}
                  {runtime !== null && runtime !== "python" && runtime !== "deno" && (
                    <div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
                      No package controls for this runtime.
                    </div>
                  )}
                </NotebookPackagesPanel>
              }
            />
          }
        >
          <div className="flex min-w-0 flex-1">
            <CrdtBridgeProvider
              getHandle={getHandle}
              onSyncNeeded={triggerSync}
              localActor={localActor}
            >
              <NotebookView
                cellIds={cellIds}
                isLoading={isLoading}
                capabilities={shellCapabilities}
                canAcceptCellMutations={canAcceptCellMutations}
                loadError={loadError}
                runtime={runtime}
                sessionRuntimeState={sessionStatus?.runtime_state ?? null}
                onFocusCell={handleNotebookViewFocus}
                onExecuteCell={handleExecuteCell}
                onInterruptKernel={interruptKernel}
                onDeleteCell={deleteCell}
                onUpdateCellSource={updateCellSource}
                onAddCell={handleAddCell}
                onMoveCell={moveCell}
                onReportOutputMatchCount={globalFind.reportOutputMatchCount}
                onSetCellSourceHidden={setCellSourceHidden}
                onSetCellOutputsHidden={setCellOutputsHidden}
                onCreateSourceComment={canMutateComments ? handleRequestSourceComment : undefined}
                onCreateOutputComment={canMutateComments ? handleRequestOutputComment : undefined}
                onActivateCommentThread={handleActivateCommentThread}
                commentThreadsByCell={sourceCommentThreadsByCell}
                markdownHeadingAnchorsByCellId={markdownHeadingAnchorsByCellId}
              />
            </CrdtBridgeProvider>
          </div>
        </NotebookDocumentShell>
      </div>
      {sourceCommentRequest ? (
        <InlineCommentComposer
          rect={sourceCommentRequest.rect}
          quote={sourceCommentRequest.anchor.exact_quote}
          disabled={!canMutateComments}
          onSubmit={handleSubmitSourceComment}
          onCancel={handleCancelSourceComment}
        />
      ) : null}
    </PresenceProvider>
  );
}

function AppErrorFallback(_error: Error, resetErrorBoundary: () => void) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-background p-8">
      <div className="text-center">
        <h1 className="text-lg font-semibold text-foreground">Something went wrong</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The notebook encountered an unexpected error.
        </p>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={resetErrorBoundary}
          className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 transition-opacity"
        >
          Reload
        </button>
      </div>
    </div>
  );
}

// Module-level ref for the widget store (set by AppContent, read by updateManager).
// This avoids a chicken-and-egg: the manager is created before the store exists.
let _widgetStoreRef: import("@/components/widgets/widget-store").WidgetStore | null = null;
let _blobUploaderRef: BlobUploader | null = null;

const updateManager = new WidgetUpdateManager({
  getStore: () => _widgetStoreRef,
  getCrdtWriter: getCrdtCommWriter,
  getBlobUploader: () => _blobUploaderRef,
});

function WidgetViewRenderer({ data }: { data: unknown }) {
  const modelId = parseWidgetViewModelId(data);
  return modelId ? <WidgetView modelId={modelId} /> : null;
}

const MEDIA_RENDERERS = {
  "application/vnd.jupyter.widget-view+json": WidgetViewRenderer,
};

function NotebookSavedWidgetStateProvider({ children }: { children: ReactNode }) {
  const metadata = useNotebookMetadata();
  const savedWidgetModels = useMemo(() => parseSavedWidgetModels(metadata), [metadata]);

  return <SavedWidgetStateProvider models={savedWidgetModels}>{children}</SavedWidgetStateProvider>;
}

export default function App() {
  return (
    <ErrorBoundary fallback={AppErrorFallback}>
      <WidgetStoreProvider sendMessage={sendMessage} updateManager={updateManager}>
        <NotebookSavedWidgetStateProvider>
          <MediaProvider renderers={MEDIA_RENDERERS}>
            <AppContent />
          </MediaProvider>
        </NotebookSavedWidgetStateProvider>
      </WidgetStoreProvider>
    </ErrorBoundary>
  );
}
