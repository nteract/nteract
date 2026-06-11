import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  IndexedDbStorageAdapter,
  RUNTIME_STATE_CACHE_KEY_SEGMENT,
  clearPersistedNotebookDoc,
  clearPersistedNotebookRecord,
  loadPersistedNotebookDoc,
  loadPersistedNotebookRecord,
  type BlobResolver,
  type CommChanges,
} from "runtimed";
import {
  applyWidgetCommBroadcastToStore,
  applyWidgetCommChangesToStore,
} from "@/components/widgets/comm-changes-store-bridge";
import { setCrdtCommWriter } from "@/components/widgets/crdt-comm-writer";
import type { WidgetStore } from "@/components/widgets/widget-store";
import {
  cloudConnectionErrorAcceptsAccessDiagnostic,
  diagnoseCloudConnectionAccess,
} from "./connection-diagnostics";
import {
  applyExecutionViewChangeset,
  applyOutputChangeset,
  emitBroadcast,
  emitPresence,
  getCellIdsSnapshot,
  materializeChangeset,
  resetPoolState,
  resetRuntimeState,
  resetRuntimeStoresProjection,
  startCursorDispatch,
  setPoolState,
  setRuntimeState,
  type CellChangeset,
  type JupyterOutput as NotebookStoreJupyterOutput,
} from "../../notebook/src/notebook-surface";
import {
  cloudSyncAuthFromPrototypeAuthState,
  withCloudPrototypeAuthHeaders,
  type CloudPrototypeAuthState,
  type CloudSyncAuth,
} from "./collaborator-auth";
import { materializeCloudNotebookView } from "./cloud-view-model";
import { CloudLivePresenceStore } from "./live-presence";
import {
  CloudConnectionStatusBridge,
  CloudRecoverableRejectionTracker,
  cloudPrincipalFromActorLabel,
  connectCloudSyncRuntime,
  createCloudConnectTarget,
  discardPersistedSeedAfterTeardown,
  isAnonymousCloudPrincipal,
  isRecoverableCloudFrameRejection,
  shouldDiscardPersistedSeedOnRejection,
  type CloudSyncRuntime,
  type CloudWebSocketTransport,
} from "./live-sync";
import { cloudInstantPaintPrincipalMatcher, resolveCloudInstantPaintHandle } from "./instant-paint";
import type { CloudViewerLoadingPolicy } from "./loading-policy";
import { markCloudViewerLoadMilestone } from "./load-milestones";
import {
  createCloudNotebookPersistence,
  type CloudNotebookPersistenceController,
} from "./notebook-persistence";
import {
  projectCloudCellsIntoNotebookViewStores,
  resetCloudProjectionUnlessPreserved,
  resetCloudViewStoreProjection,
} from "./notebook-view-store-bridge";
import { CloudViewerPresenceStore } from "./presence";
import { createOutputResolutionCache, type ResolvedCell } from "./render-resolution";
import { loadRenderSnapshotHandle, loadSnapshotPairHandle } from "./runtimed-wasm-client";
import { isRuntimedWasmAssetFailure } from "./runtimed-wasm-failure";
import { subscribeSerializedCloudCellChanges } from "./serialized-cell-changes";
import { cloudWidgetUpdateManager } from "./widget-runtime";
import { projectCloudWidgetComms } from "./widget-comm-projection";
import type { CloudAppSession } from "./app-session";
import type { CloudAuthRenewalState, ViewerStatus } from "./notice-types";

/**
 * Renderer sidecar filenames from the deploy manifest. Content-hashed
 * names ride immutable caching on the renderer-assets origin; the stable
 * names are the documented fallback when no manifest was deployed.
 */
export interface CloudRendererAssetNames {
  js: string;
  css: string;
  siftWasm: string;
}

export interface CloudViewerConfig {
  notebookId: string;
  headsHash: string | null;
  catalogEndpoint: string;
  snapshotBasePath: string;
  runtimeSnapshotBasePath: string;
  commsSnapshotBasePath: string;
  aclEndpoint: string;
  invitesEndpoint: string;
  accessRequestsEndpoint: string;
  workstationsEndpoint?: string;
  workstationDefaultEndpoint?: string;
  workstationAttachEndpoint?: string;
  hostCapabilities?: {
    canManageSharing?: boolean;
    canSubmitExecutionRequests?: boolean;
  };
  session?: CloudAppSession | null;
  syncEndpoint: string;
  blobBasePath: string;
  rendererAssetsBasePath: string;
  rendererAssets: CloudRendererAssetNames;
  outputDocumentBaseUrl: string | null;
  runtimedWasmModulePath: string;
  runtimedWasmPath: string;
}

export interface CloudViewerSession {
  connectionActorLabel: string | null;
  connectionError: string | null;
  connectionPeerId: string | null;
  connectionScope: string | null;
  /**
   * Stable connection lifecycle across transport replacements (initial
   * connect attempts and escalation teardowns) — the session's
   * CloudConnectionStatusBridge, the slot's connectivity-dot source
   * (subscribe + getCurrent for first paint).
   */
  connectionStatus$: CloudConnectionStatusBridge;
  liveMaterializedRef: MutableRefObject<boolean>;
  liveRuntimeRef: MutableRefObject<CloudSyncRuntime | null>;
  notebookLanguageRef: MutableRefObject<string>;
  notebookMetadata: unknown;
  presenceStore: CloudViewerPresenceStore;
  requestCloudMaterialization: (liveRuntime: CloudSyncRuntime) => void;
  retryLiveConnection: () => void;
  snapshotResolvedRef: MutableRefObject<boolean>;
  status: ViewerStatus;
}

interface UseCloudViewerSessionOptions {
  authRenewalKind: CloudAuthRenewalState["kind"];
  authState: CloudPrototypeAuthState;
  blobResolver: BlobResolver;
  config: CloudViewerConfig;
  hasAppSession?: boolean;
  loadingPolicy: CloudViewerLoadingPolicy;
  preloadSiftWasm: (cells: readonly ResolvedCell[]) => void;
  resolveSyncAuth?: (sessionId: string) => Promise<CloudSyncAuth>;
  widgetStore: WidgetStore;
}

interface CloudNotebookCatalogRevision {
  notebook_heads_hash: string;
  runtime_heads_hash: string | null;
  comms_heads_hash: string | null;
  runtime_state_doc_id: string | null;
}

interface CloudNotebookCatalog {
  revisions?: CloudNotebookCatalogRevision[];
}

export function useCloudViewerSession({
  authRenewalKind,
  authState,
  blobResolver,
  config,
  hasAppSession = false,
  loadingPolicy,
  preloadSiftWasm,
  resolveSyncAuth,
  widgetStore,
}: UseCloudViewerSessionOptions): CloudViewerSession {
  const [status, setStatus] = useState<ViewerStatus>({
    kind: "loading",
    message: loadingPolicy.initialStatusMessage,
  });
  const [, setCells] = useState<ResolvedCell[]>([]);
  const [notebookMetadata, setNotebookMetadata] = useState<unknown>(null);
  const notebookLanguageRef = useRef("python");
  const liveRuntimeRef = useRef<CloudSyncRuntime | null>(null);
  const materializeLiveRuntimeRef = useRef<((runtime: CloudSyncRuntime) => void) | null>(null);
  const liveMaterializedRef = useRef(false);
  const snapshotResolvedRef = useRef(false);
  // Set when a seeded session's replayed changes were rejected by the room:
  // the next connect attempt must bootstrap (survives the effect re-run).
  const skipSeedOnceRef = useRef(false);
  // The escalation's dispose-flush → clear chain (never rejects). The next
  // attempt's persistence arming awaits it (clear-then-arm), so a
  // straggling clear can never delete a fresh attempt's first record.
  const pendingSeedDiscardRef = useRef<Promise<void>>(Promise.resolve());
  const projectedWidgetCommIdsRef = useRef(new Set<string>());
  const outputResolutionCacheRef = useRef(createOutputResolutionCache());
  const incrementalOutputCacheRef = useRef(new Map<string, NotebookStoreJupyterOutput>());
  const presenceStoreRef = useRef<CloudViewerPresenceStore | null>(null);
  if (presenceStoreRef.current === null) {
    presenceStoreRef.current = new CloudViewerPresenceStore();
  }
  const presenceStore = presenceStoreRef.current;
  // Stable across effect re-runs: UI subscribers must not re-subscribe when
  // a connect attempt or escalation teardown replaces the transport.
  const connectionStatusBridgeRef = useRef<CloudConnectionStatusBridge | null>(null);
  if (connectionStatusBridgeRef.current === null) {
    connectionStatusBridgeRef.current = new CloudConnectionStatusBridge();
  }
  const connectionStatusBridge = connectionStatusBridgeRef.current;
  const [connectionScope, setConnectionScope] = useState<string | null>(null);
  const [connectionPeerId, setConnectionPeerId] = useState<string | null>(null);
  const [connectionActorLabel, setConnectionActorLabel] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectAttempt, setConnectAttempt] = useState(0);

  // Identity of the notebook whose cells are currently painted into the
  // view stores — the flicker gate's "previous" side (see effect cleanup).
  const paintedNotebookIdentityRef = useRef<string | null>(null);
  const applyResolvedCells = useCallback(
    (resolvedCells: ResolvedCell[]) => {
      projectCloudCellsIntoNotebookViewStores(resolvedCells);
      if (resolvedCells.length > 0) {
        paintedNotebookIdentityRef.current = `id:${config.notebookId}`;
      }
      setCells(resolvedCells);
    },
    [config.notebookId],
  );

  // True unmount: nothing is preserved across a session teardown — clear
  // every store the projection paints (the live effect's cleanup preserves
  // them for same-notebook re-runs, so it cannot be the unmount janitor).
  useEffect(
    () => () => {
      resetCloudViewStoreProjection();
      resetRuntimeState();
      resetRuntimeStoresProjection();
    },
    [],
  );

  useEffect(() => {
    if (authRenewalKind === "refreshing") {
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
              message: "No complete snapshot set is available for these pinned heads.",
            });
          }
          return;
        }

        const commsSnapshotRequest = revision.comms_heads_hash
          ? fetch(
              pinnedSnapshotEndpoint(config.commsSnapshotBasePath, revision.comms_heads_hash),
              withCloudPrototypeAuthHeaders(
                {
                  headers: {
                    Accept: "application/octet-stream",
                    "X-Runtime-State-Doc-Id": revision.runtime_state_doc_id,
                  },
                },
                authState,
              ),
            )
          : Promise.resolve(null);
        const [notebookSnapshotResponse, runtimeSnapshotResponse, commsSnapshotResponse] =
          await Promise.all([
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
            commsSnapshotRequest,
          ]);
        if (
          !notebookSnapshotResponse.ok ||
          !runtimeSnapshotResponse.ok ||
          (commsSnapshotResponse && !commsSnapshotResponse.ok)
        ) {
          if (!cancelled) {
            snapshotResolvedRef.current = true;
            setStatus({
              kind: "error",
              message: `Unable to load pinned snapshot set: notebook ${notebookSnapshotResponse.status}, runtime ${runtimeSnapshotResponse.status}, comms ${commsSnapshotResponse?.status ?? "none"}`,
            });
          }
          return;
        }

        handle = await loadSnapshotPairHandle(
          new Uint8Array(await notebookSnapshotResponse.arrayBuffer()),
          new Uint8Array(await runtimeSnapshotResponse.arrayBuffer()),
          commsSnapshotResponse
            ? new Uint8Array(await commsSnapshotResponse.arrayBuffer())
            : undefined,
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
              preloadSiftWasm(syncCells);
              applyResolvedCells(syncCells);
              setStatus({
                kind: "loading",
                message: `Rendering ${syncCells.length} cells while resolving output payloads...`,
              });
            },
            onCellResolved(resolvedCell, _index, progressiveCells) {
              if (progressiveCells.length === 0) return;
              preloadSiftWasm([resolvedCell]);
              applyResolvedCells(progressiveCells);
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
        applyResolvedCells(resolvedCells);
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
    authRenewalKind,
    authState,
    blobResolver,
    config.catalogEndpoint,
    config.blobBasePath,
    config.headsHash,
    config.runtimeSnapshotBasePath,
    config.commsSnapshotBasePath,
    config.runtimedWasmModulePath,
    config.runtimedWasmPath,
    config.snapshotBasePath,
    loadingPolicy.shouldFetchSnapshotRender,
    preloadSiftWasm,
    widgetStore,
  ]);

  useEffect(() => {
    if (authRenewalKind === "refreshing") {
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
    let pendingTransport: CloudWebSocketTransport | null = null;
    // Recoverable sync rejections on the CURRENT connection (reset on each
    // cloud_room_ready): the first recovers in place, pipelined rejections
    // that cannot have observed the resync absorb, a post-resync repeat
    // escalates.
    const rejectionTracker = new CloudRecoverableRejectionTracker();
    let ranConnectionDiagnostics = false;
    // Local-first persistence is fail-open: no IndexedDB (private mode,
    // SSR) means no adapter and the session runs exactly as before.
    const persistenceAdapter = IndexedDbStorageAdapter.create();
    let notebookPersistence: CloudNotebookPersistenceController | null = null;
    let notebookPersistencePrincipal: string | null = null;
    const persistenceSeed = persistenceAdapter
      ? {
          loadPersisted: () => loadPersistedNotebookDoc(persistenceAdapter, config.notebookId),
          clear: () => clearPersistedNotebookDoc(persistenceAdapter, config.notebookId),
        }
      : undefined;
    // Consume the poison-pill marker: after a seeded session's changes were
    // rejected by the room, the next attempt bootstraps even though the
    // adapter is healthy (the record was cleared, but don't race the clear).
    const skipSeedOnThisAttempt = skipSeedOnceRef.current;
    skipSeedOnceRef.current = false;
    // Shrink the tab-kill loss window: commit pending persistence state
    // when the page hides or unloads.
    const flushPersistence = () => {
      void notebookPersistence?.flushNow();
    };
    const flushPersistenceWhenHidden = () => {
      if (document.visibilityState === "hidden") {
        flushPersistence();
      }
    };
    window.addEventListener("pagehide", flushPersistence);
    document.addEventListener("visibilitychange", flushPersistenceWhenHidden);
    const installCloudWidgetCommWriter = (liveRuntime: CloudSyncRuntime) => {
      setCrdtCommWriter((commId: string, patch: Record<string, unknown>) => {
        if (liveRuntimeRef.current !== liveRuntime) return;
        try {
          liveRuntime.handle.set_comm_state_batch(commId, JSON.stringify(patch));
          liveRuntime.engine.scheduleFlush();
        } catch (error) {
          console.warn("[notebook-cloud] widget state update failed", error);
        }
      });
    };
    const disposeCurrentRuntime = (): Promise<void> => {
      const liveRuntime = liveRuntimeRef.current;
      if (!liveRuntime) return Promise.resolve();
      liveRuntimeRef.current = null;
      setCrdtCommWriter(null);
      // Invalidate in-flight materializations before the handle is freed —
      // their shouldContinue/sequence guards trip instead of touching a
      // freed handle (the unmount path gets this from the disposed flag;
      // mid-effect escalation teardowns need it here).
      materializeSequence += 1;
      // Capture unsaved persistence state before the handle is freed —
      // flushNow reads the snapshot bytes synchronously, and dispose()
      // guarantees no later capture touches the freed handle. The returned
      // promise settles once the teardown write has committed.
      const teardownFlush = notebookPersistence?.flushNow() ?? Promise.resolve();
      notebookPersistence?.dispose();
      notebookPersistence = null;
      notebookPersistencePrincipal = null;
      disposeCloudSyncRuntime(liveRuntime);
      return teardownFlush;
    };
    // Arm (or re-arm) the persistence save loop for the runtime's CURRENT
    // principal. Same-principal reconnects keep the controller; a principal
    // change (auth re-resolution yielded a different account) recreates it
    // so the envelope is never stamped with the wrong principal.
    const armPersistence = (liveRuntime: CloudSyncRuntime) => {
      if (!persistenceAdapter) return;
      // A failed seed read leaves an unread record (possibly the only copy
      // of offline edits) in place — never arm the save loop that would
      // overwrite it, for the whole life of this runtime.
      if (liveRuntime.persistenceSeedOutcome === "read_failed") return;
      const principal = cloudPrincipalFromActorLabel(liveRuntime.actorLabel);
      if (notebookPersistence && notebookPersistencePrincipal === principal) return;
      notebookPersistence?.dispose();
      notebookPersistence = null;
      notebookPersistencePrincipal = null;
      // Anonymous principals are per-connection: their records can never
      // seed and would only churn storage.
      if (isAnonymousCloudPrincipal(principal)) return;
      // Strict clear-then-arm: a previous escalation's dispose-flush → clear
      // chain (never rejects) must settle before this attempt writes its
      // first record, or the straggling clear could delete it.
      void pendingSeedDiscardRef.current.then(() => {
        if (disposed || liveRuntimeRef.current !== liveRuntime) return;
        if (notebookPersistence && notebookPersistencePrincipal === principal) return;
        // Snapshot the raw NotebookHandle on every doc change: the
        // NotebookDoc seed record plus the render-only RuntimeStateDoc
        // paint cache (instant first paint's outputs). The controllers
        // throttle, self-disable after repeated failures, and never throw
        // into the session.
        notebookPersistence = createCloudNotebookPersistence({
          adapter: persistenceAdapter,
          notebookId: config.notebookId,
          principal,
          engine: liveRuntime.engine,
          handle: liveRuntime.handle,
          onError: (error) => console.warn("[notebook-cloud] notebook persistence error", error),
        });
        notebookPersistencePrincipal = notebookPersistence ? principal : null;
      });
    };
    // Transport-level connection losses are informational: the transport
    // owns the retry loop, the preserved handle keeps unflushed local
    // edits, and the rendered projections stay in place until the room
    // re-syncs. No teardown here.
    const handleConnectionLost = (reason: Error) => {
      if (disposed) return;
      console.warn("[notebook-cloud] live room connection lost; transport is reconnecting", reason);
      presenceStore.reduceConnection("disconnected");
      setConnectionError(reason.message);
      if (!liveRuntimeRef.current && !ranConnectionDiagnostics) {
        // First pre-ready failure: surface an actionable access diagnosis
        // while the retry loop keeps running in the background.
        ranConnectionDiagnostics = true;
        void diagnoseCloudConnectionAccess({
          accessRequestsEndpoint: config.accessRequestsEndpoint,
          authState,
          hasAppSession,
        })
          .then((diagnostic) => {
            if (disposed || !diagnostic) return;
            setConnectionError(diagnostic);
          })
          .catch(() => undefined);
      }
    };
    // Escalation-only teardown (repeated sync rejections): dispose the
    // runtime and re-run the effect with a fresh handle. Transport-level
    // drops never come through here anymore.
    const scheduleReconnect = (reason: Error) => {
      if (disposed) return;
      console.warn("[notebook-cloud] live room session teardown; reconnecting", reason);
      // Detach BEFORE disposing: the manual disconnect's terminal "offline"
      // must not surface — the session is retrying, not going offline.
      connectionStatusBridge.noteTeardownRetry();
      presenceStore.reduceConnection("disconnected");
      setConnectionScope(null);
      setConnectionActorLabel(null);
      setConnectionError(reason.message);
      // Workstation attachment lives in the shared runtime-state store;
      // resetRuntimeState() below (via disposeCurrentRuntime/reconnect)
      // clears it through the workstation$ projection.
      resetRuntimeState();
      disposeCurrentRuntime();
      // An in-flight connect (no runtime yet) owns a live transport too.
      pendingTransport?.disconnect();
      pendingTransport = null;
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!disposed) {
          setConnectAttempt((attempt) => attempt + 1);
        }
      }, 1_000);
    };

    const materializedCellCount = () => getCellIdsSnapshot().length;

    const materializeLiveCells = async (liveRuntime: CloudSyncRuntime) => {
      const sequence = ++materializeSequence;
      const previousNotebookLanguage = notebookLanguageRef.current;
      const outputResolutionCache = outputResolutionCacheRef.current;
      const rawCellCount = liveRuntime.handle.cell_count();
      if (rawCellCount === 0 && (!snapshotResolvedRef.current || materializedCellCount() > 0)) {
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
            applyResolvedCells(syncCells);
            setStatus({
              kind: "loading",
              message: `Rendering ${syncCells.length} live cells while resolving output payloads...`,
            });
          },
          onCellResolved(resolvedCell, _index, progressiveCells) {
            if (progressiveCells.length === 0) return;
            liveMaterializedRef.current = true;
            preloadSiftWasm([resolvedCell]);
            applyResolvedCells(progressiveCells);
          },
        },
      });
      if (materialized.rawCellCount === 0) {
        if (!snapshotResolvedRef.current || materializedCellCount() > 0) {
          return;
        }
      }
      if (disposed || sequence !== materializeSequence) return;
      notebookLanguageRef.current = materialized.notebookLanguage;
      setNotebookMetadata(materialized.metadata);
      applyExecutionViewChangeset(liveRuntime.handle.project_execution_view_changeset?.());

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
      applyResolvedCells(resolvedCells);
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

    const materializeLiveChangeset = async (
      changeset: CellChangeset | null,
      liveRuntime: CloudSyncRuntime,
    ) => {
      const sequence = materializeSequence;
      await materializeChangeset(changeset, {
        getHandle: () => liveRuntime.handle,
        materializeCells: async () => materializeLiveCells(liveRuntime),
        outputCache: incrementalOutputCacheRef.current,
        blobResolver,
      });
      if (disposed || sequence !== materializeSequence) return;

      applyExecutionViewChangeset(liveRuntime.handle.project_execution_view_changeset?.());

      const currentCellCount = materializedCellCount();
      if (currentCellCount === 0) {
        if (snapshotResolvedRef.current) {
          setStatus({ kind: "empty", message: "This notebook room has no cells yet." });
        }
        return;
      }

      liveMaterializedRef.current = true;
      setStatus({
        kind: "ready",
        message: `Rendering ${currentCellCount} cells from the live notebook room.`,
      });
    };

    const materializeLiveCellsSafely = (liveRuntime: CloudSyncRuntime) => {
      void materializeLiveCells(liveRuntime).catch((error: unknown) => {
        if (disposed) return;
        console.warn("[notebook-cloud] live room materialization failed", error);
      });
    };
    materializeLiveRuntimeRef.current = materializeLiveCellsSafely;

    // Instant first paint from the persisted snapshot: runs in parallel
    // with the WS dial (never delaying it) and paints cells AND outputs
    // from the local envelope records through a THROWAWAY render handle —
    // the pinned-snapshot path's exact shape, freed after materialization.
    // The race guard (`liveMaterializedRef`) ensures a fast live connect
    // wins: stale cache never overwrites a live materialization, and the
    // live materialization replaces the paint wholesale when sync lands
    // (the preservation gate keeps the paint until then, no blanking).
    const instantPaintFresh = () => !disposed && !liveMaterializedRef.current;
    const paintFromPersistedSnapshot = async () => {
      if (!persistenceAdapter) return;
      const resolved = await resolveCloudInstantPaintHandle({
        // Pre-handshake principal gate from locally stored auth material;
        // null (no derivable principal) skips the paint entirely.
        matchesPrincipal: cloudInstantPaintPrincipalMatcher(authState, { hasAppSession }),
        loadNotebookRecord: () => loadPersistedNotebookDoc(persistenceAdapter, config.notebookId),
        loadRuntimeStateCacheRecord: () =>
          loadPersistedNotebookRecord(
            persistenceAdapter,
            config.notebookId,
            RUNTIME_STATE_CACHE_KEY_SEGMENT,
          ),
        clearRuntimeStateCacheRecord: () =>
          clearPersistedNotebookRecord(
            persistenceAdapter,
            config.notebookId,
            RUNTIME_STATE_CACHE_KEY_SEGMENT,
          ),
        loadRenderHandle: (notebookBytes, runtimeStateBytes) =>
          loadRenderSnapshotHandle(
            notebookBytes,
            runtimeStateBytes,
            config.runtimedWasmModulePath,
            config.runtimedWasmPath,
          ),
        shouldContinue: instantPaintFresh,
        // Asset-load failures do not incriminate the cached bytes: never
        // clear the cache record for them.
        isTransientLoadFailure: (error) =>
          isRuntimedWasmAssetFailure(error instanceof Error ? error.message : String(error)),
      });
      const renderHandle = resolved.handle;
      if (!renderHandle) return;
      try {
        if (!instantPaintFresh()) return;
        const materialized = await materializeCloudNotebookView(renderHandle, {
          blobResolver,
          defaultNotebookLanguage: notebookLanguageRef.current ?? "python",
          outputResolutionCache: outputResolutionCacheRef.current,
          callbacks: {
            shouldContinue: instantPaintFresh,
            onInitialCells(syncCells) {
              if (syncCells.length === 0) return;
              markCloudViewerLoadMilestone("instant-paint-initial-cells");
              preloadSiftWasm(syncCells);
              applyResolvedCells(syncCells);
              setStatus({
                kind: "loading",
                message: `Rendering ${syncCells.length} cells from the local snapshot while connecting...`,
              });
            },
            onCellResolved(resolvedCell, _index, progressiveCells) {
              if (progressiveCells.length === 0) return;
              preloadSiftWasm([resolvedCell]);
              applyResolvedCells(progressiveCells);
            },
          },
        });
        if (!instantPaintFresh()) return;
        // An empty persisted snapshot paints nothing: the room decides
        // what an empty notebook means.
        if (materialized.cells.length === 0) return;
        notebookLanguageRef.current = materialized.notebookLanguage;
        setNotebookMetadata(materialized.metadata);
        await projectCloudWidgetComms(
          widgetStore,
          materialized.widgetComms,
          projectedWidgetCommIdsRef,
          {
            isAllowedBlobUrl: (url) => isConfiguredBlobUrl(url, config.blobBasePath),
            shouldContinue: instantPaintFresh,
          },
        );
        if (!instantPaintFresh()) return;
        preloadSiftWasm(materialized.cells);
        applyResolvedCells(materialized.cells);
        setStatus({
          kind: "ready",
          message: `Rendering ${materialized.cells.length} cells from the locally persisted snapshot while the live room connects.`,
        });
        markCloudViewerLoadMilestone("instant-paint-ready");
      } finally {
        renderHandle.free();
      }
    };

    // Notebook-switch gate (desktop beforeBootstrap placement): the effect
    // CLEANUP closes over its own run's config, so it can only ever compare
    // the painted identity against itself — a real switch is visible only
    // here, to the NEXT run. Before connecting, clear every projected store
    // when the painted cells belong to a different notebook (or nothing
    // usable is painted); a same-notebook re-run's paint survives untouched
    // and is replaced wholesale by this run's materialization.
    const preservedAcrossRuns = resetCloudProjectionUnlessPreserved({
      paintedNotebookIdentity: paintedNotebookIdentityRef.current,
      nextNotebookIdentity: `id:${config.notebookId}`,
    });
    if (!preservedAcrossRuns) {
      paintedNotebookIdentityRef.current = null;
    }

    presenceStore.reset();
    resetRuntimeState();
    setConnectionError(null);
    setConnectionActorLabel(null);
    setConnectionPeerId(null);
    connectCloudSyncRuntime({
      // Per-attempt target: re-resolves auth and mints a fresh operator
      // nonce on every retry (see createCloudConnectTarget).
      connectTarget: createCloudConnectTarget({
        syncEndpoint: config.syncEndpoint,
        resolveAuth: (attemptSessionId) =>
          resolveSyncAuth
            ? resolveSyncAuth(attemptSessionId)
            : cloudSyncAuthFromPrototypeAuthState(authState),
      }),
      runtimedWasmModulePath: config.runtimedWasmModulePath,
      runtimedWasmPath: config.runtimedWasmPath,
      persistence: skipSeedOnThisAttempt ? undefined : persistenceSeed,
      onConnectionLost: handleConnectionLost,
      onTransportCreated: (transport) => {
        pendingTransport = transport;
        // Follow the replacement transport so the stable status source
        // reflects this attempt (and PR-2's reconnect loop within it).
        connectionStatusBridge.attach(transport);
      },
      onControl: (message) => {
        if (disposed) return;
        if (
          message.type === "cloud_room_ready" ||
          message.type === "cloud_peer_joined" ||
          message.type === "cloud_peer_left"
        ) {
          presenceStore.reduceMessage(message);
        }
        if (message.type === "cloud_room_ready") {
          markCloudViewerLoadMilestone("live-room-ready");
          rejectionTracker.reset(); // fresh connection, fresh strike count
          setConnectionError(null);
          setConnectionScope(message.connection_scope);
          setConnectionActorLabel(message.actor_label);
        }
        if (message.type === "cloud_frame_rejected") {
          if (isRecoverableCloudFrameRejection(message)) {
            const liveRuntime = liveRuntimeRef.current;
            const disposition = rejectionTracker.record(liveRuntime !== null);
            if (disposition === "absorb") {
              // Pipelined rejection: it cannot have observed the in-flight
              // strike-1 resync (several AUTOMERGE_SYNC frames are routinely
              // outstanding and acks carry no id) — same divergence event.
              return;
            }
            setStatus({
              kind: "loading",
              message: "Resynchronizing live notebook room after a rejected sync frame...",
            });
            if (disposition === "resync_in_place" && liveRuntime) {
              // First strike: sync state diverged from the room — reset and
              // resync on the live connection, no teardown. The strike only
              // clears once the resync's outbound flush has actually been
              // delivered, so only rejections that could have observed it
              // count toward escalation.
              liveRuntime.engine.resetAndResync();
              void liveRuntime.engine
                .flushAndWait()
                .catch(() => undefined)
                .then(() => rejectionTracker.resyncSettled());
              return;
            }
            const reason = new Error(`Room rejected sync frame: ${message.reason}`);
            const seededRuntime = liveRuntime?.seededFromPersistence === true;
            if (persistenceSeed && shouldDiscardPersistedSeedOnRejection(message, seededRuntime)) {
              // Poison pill: the record replays changes the room will not
              // accept; reseeding it would loop forever. Dispose FIRST —
              // teardown's flushNow re-writes the record with the rejected
              // changes — then clear once that write has settled, and
              // bootstrap the next attempt. The rejected changes are
              // unauthorized; losing them is the intended outcome. The chain
              // is stashed so the next attempt arms strictly clear-then-arm.
              skipSeedOnceRef.current = true;
              connectionStatusBridge.noteTeardownRetry();
              pendingSeedDiscardRef.current = discardPersistedSeedAfterTeardown(
                disposeCurrentRuntime,
                persistenceSeed.clear,
              );
            } else if (!liveRuntime) {
              // A rejection before the runtime resolved means the in-flight
              // bootstrap flush was refused. We cannot tell from here
              // whether that attempt was seeded, so bootstrap the next one
              // either way — a non-seeded attempt bootstraps identically,
              // and a healthy record is re-persisted after convergence.
              skipSeedOnceRef.current = true;
            }
            scheduleReconnect(reason);
            return;
          }
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
        installCloudWidgetCommWriter(liveRuntime);
        armPersistence(liveRuntime);
        const stopWidgetLiveRuntimeDiagnostics =
          installCloudWidgetLiveRuntimeDiagnostics(liveRuntime);
        setConnectionScope(liveRuntime.connectionScope);
        setConnectionActorLabel(liveRuntime.actorLabel);
        setConnectionPeerId(liveRuntime.peerId);
        livePresenceStore = new CloudLivePresenceStore(liveRuntime.peerId);
        let stopCursorDispatch = startCursorDispatch(liveRuntime.peerId);
        subscriptions = [
          // Transport-level reconnects preserve the handle, engine,
          // subscriptions, and store projections; only per-connection state
          // is re-established here.
          liveRuntime.transport.roomReady$.subscribe((ready) => {
            if (disposed || liveRuntimeRef.current !== liveRuntime) return;
            // applyRoomReady runs the synchronous re-establish (set_actor +
            // resetForBootstrap + resetAndResync) — it must complete before
            // this tick yields, ahead of the new connection's first sync
            // frame. Everything after it is async-safe.
            if (!liveRuntime.applyRoomReady(ready)) return;
            setConnectionError(null);
            setConnectionScope(liveRuntime.connectionScope);
            setConnectionActorLabel(liveRuntime.actorLabel);
            setConnectionPeerId(liveRuntime.peerId);
            // Presence identity is per-connection (server-assigned peer id).
            livePresenceStore = new CloudLivePresenceStore(liveRuntime.peerId);
            stopCursorDispatch();
            stopCursorDispatch = startCursorDispatch(liveRuntime.peerId);
            // The persistence principal follows the latest identity;
            // same-principal reconnects keep the controller.
            armPersistence(liveRuntime);
          }),
          liveRuntime.engine.broadcasts$.subscribe((payload) => {
            emitBroadcast(payload);
          }),
          liveRuntime.engine.presence$.subscribe((payload) => {
            emitPresence(payload);
            livePresenceStore?.handlePresence(payload);
          }),
          subscribeSerializedCloudCellChanges({
            cellChanges$: liveRuntime.engine.cellChanges$,
            materializeChangeset: (changeset) => materializeLiveChangeset(changeset, liveRuntime),
            onMaterializationError: (error) => {
              console.warn("[notebook-cloud] live changeset materialization failed", error);
            },
          }),
          // Workstation attachment is consumed via the shared store's
          // deduplicated workstation$ projection (useWorkstationAttachment);
          // no per-host shadow state.
          liveRuntime.engine.runtimeState$.subscribe((state) => {
            setRuntimeState(state);
          }),
          liveRuntime.engine.executionViewChanges$.subscribe((changeset) => {
            applyExecutionViewChangeset(changeset);
          }),
          liveRuntime.engine.outputIdChanges$.subscribe(({ changed, removed_ids }) => {
            void applyOutputChangeset(changed, removed_ids, { blobResolver }).catch(
              (error: unknown) => {
                console.warn("[notebook-cloud] output store projection failed", error);
              },
            );
          }),
          liveRuntime.engine.commChanges$.subscribe((changes) => {
            recordCloudWidgetCommChangesDiagnostic(liveRuntime, changes);
            applyWidgetCommChangesToStore(widgetStore, changes, {
              shouldSuppressEcho: (commId, state) =>
                cloudWidgetUpdateManager.shouldSuppressEcho(commId, state),
              clearComm: (commId) => cloudWidgetUpdateManager.clearComm(commId),
            });
          }),
          liveRuntime.engine.commBroadcasts$.subscribe((broadcast) => {
            applyWidgetCommBroadcastToStore(widgetStore, broadcast);
          }),
          liveRuntime.engine.poolState$.subscribe((state) => {
            setPoolState(state);
          }),
          { unsubscribe: () => stopCursorDispatch() },
          { unsubscribe: stopWidgetLiveRuntimeDiagnostics },
        ];
        liveRuntime.engine.reProjectComms();
        materializeLiveCellsSafely(liveRuntime);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        if (materializedCellCount() === 0) {
          setStatus({
            kind: "error",
            message: `Unable to load live notebook room: ${message}`,
          });
        }
        presenceStore.reduceConnection("disconnected");
        setConnectionScope(null);
        setConnectionActorLabel(null);
        setConnectionPeerId(null);
        resetRuntimeState();
        setConnectionError(message);
        // Terminal WASM asset failures own the notice (Retry affordance):
        // a coinciding access diagnostic must not overwrite them.
        if (cloudConnectionErrorAcceptsAccessDiagnostic(message)) {
          void diagnoseCloudConnectionAccess({
            accessRequestsEndpoint: config.accessRequestsEndpoint,
            authState,
            hasAppSession,
          })
            .then((diagnostic) => {
              if (disposed || !diagnostic) return;
              if (materializedCellCount() === 0) {
                setStatus({
                  kind: "error",
                  message: `Unable to load live notebook room: ${diagnostic}`,
                });
              }
              setConnectionError(diagnostic);
            })
            .catch(() => undefined);
        }
        console.warn("[notebook-cloud] live room connection failed", error);
      });

    // Kicked AFTER the connect call so the WS dial is never delayed, and
    // only on the live-room path (the pinned-revision URL path keeps its
    // snapshot fetch; the two paints are mutually exclusive by policy).
    // A poison-pill attempt (its record discard is in flight) skips the
    // paint along with the seed.
    if (persistenceAdapter && !skipSeedOnThisAttempt) {
      void paintFromPersistedSnapshot().catch((error: unknown) => {
        if (disposed) return;
        console.warn("[notebook-cloud] instant paint from persisted snapshot failed", error);
      });
    }

    return () => {
      disposed = true;
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      window.removeEventListener("pagehide", flushPersistence);
      document.removeEventListener("visibilitychange", flushPersistenceWhenHidden);
      materializeLiveRuntimeRef.current = null;
      // Detach BEFORE the teardown disconnects emit their terminal
      // "offline", and report "reconnecting": a re-running effect usually
      // re-attaches a replacement transport, but the auth-refresh re-run
      // early-returns without attaching — the bridge must read as a
      // transition, not as stale "online", for that window. Harmless at
      // real unmount (no subscribers remain).
      connectionStatusBridge.noteTeardownRetry();
      const teardownFlush = disposeCurrentRuntime();
      // An in-flight connect (runtime not yet resolved) owns a transport
      // whose retry loop would otherwise run forever after unmount.
      pendingTransport?.disconnect();
      pendingTransport = null;
      if (persistenceAdapter) {
        // Connection hygiene across reconnect cycles: close the cached IDB
        // connection once the teardown write has committed. Adapter ops
        // reopen on demand, so a straggling clear still succeeds.
        void teardownFlush.catch(() => undefined).then(() => persistenceAdapter.close());
      }
      setCrdtCommWriter(null);
      // Flicker gate (desktop bootstrap-preservation pattern): the live
      // effect re-runs for reasons that are NOT a notebook switch — OIDC
      // refreshes, manual retries. With IDB seeding, paint #1 lands before
      // those re-runs, and an unconditional clear here blanked a painted
      // notebook into a full→empty→full flicker. The gate covers EVERY
      // projected store together: CodeCell reads outputs and execution
      // counts from the execution/output stores, so preserving cells while
      // wiping those still flickered the dominant visual mass. Within this
      // closure nextNotebookIdentity always equals the painted identity
      // whenever cells are painted, so this honestly reduces to "painted
      // with visible cells ⇒ preserve"; REAL notebook switches are cleared
      // by the next run's body gate, and true unmount clears via the
      // mount-scoped effect above.
      resetCloudProjectionUnlessPreserved({
        paintedNotebookIdentity: paintedNotebookIdentityRef.current,
        nextNotebookIdentity: `id:${config.notebookId}`,
      });
      resetPoolState();
      livePresenceStore = null;
      presenceStore.reduceConnection("disconnected");
      setConnectionPeerId(null);
    };
  }, [
    authRenewalKind,
    authState,
    blobResolver,
    config.accessRequestsEndpoint,
    config.blobBasePath,
    config.runtimedWasmModulePath,
    config.runtimedWasmPath,
    config.syncEndpoint,
    connectAttempt,
    hasAppSession,
    loadingPolicy.shouldConnectLiveRoom,
    presenceStore,
    applyResolvedCells,
    preloadSiftWasm,
    resolveSyncAuth,
    widgetStore,
  ]);

  const requestCloudMaterialization = useCallback((liveRuntime: CloudSyncRuntime) => {
    materializeLiveRuntimeRef.current?.(liveRuntime);
  }, []);

  const retryLiveConnection = useCallback(() => {
    setConnectAttempt((attempt) => attempt + 1);
  }, []);

  return {
    connectionActorLabel,
    connectionError,
    connectionStatus$: connectionStatusBridge,
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
  };
}

function disposeCloudSyncRuntime(liveRuntime: CloudSyncRuntime): void {
  liveRuntime.engine.stop();
  liveRuntime.transport.disconnect();
  liveRuntime.handle.free();
}

function recordCloudWidgetCommChangesDiagnostic(
  liveRuntime: CloudSyncRuntime,
  changes: CommChanges,
): void {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage?.getItem("nteract:notebook-cloud:widget-diagnostics") !== "1") {
      return;
    }
  } catch {
    return;
  }

  const target = window as unknown as {
    __nteractCloudWidgetCommEvents?: unknown[];
  };
  const events = target.__nteractCloudWidgetCommEvents ?? [];
  target.__nteractCloudWidgetCommEvents = events;

  events.push({
    at: Date.now(),
    peerId: liveRuntime.peerId,
    opened: changes.opened.map(summarizeResolvedCommDiagnostic),
    updated: changes.updated.map(summarizeResolvedCommDiagnostic),
    closed: changes.closed,
    runtimeComms: summarizeRuntimeCommsDiagnostic(
      readHandleSnapshot(liveRuntime, "get_runtime_state"),
    ),
    commsDoc: summarizeCommsDocDiagnostic(readHandleSnapshot(liveRuntime, "get_comms_state")),
  });

  if (events.length > 100) {
    events.splice(0, events.length - 100);
  }
}

function installCloudWidgetLiveRuntimeDiagnostics(liveRuntime: CloudSyncRuntime): () => void {
  if (typeof window === "undefined") return () => {};
  try {
    if (window.localStorage?.getItem("nteract:notebook-cloud:widget-diagnostics") !== "1") {
      return () => {};
    }
  } catch {
    return () => {};
  }

  const target = window as unknown as {
    __nteractCloudLiveRuntimeSnapshot?: () => unknown;
  };
  target.__nteractCloudLiveRuntimeSnapshot = () => ({
    peerId: liveRuntime.peerId,
    cellCount: safeCallNumber(() => liveRuntime.handle.cell_count()),
    runtimeComms: summarizeRuntimeCommsDiagnostic(
      readHandleSnapshot(liveRuntime, "get_runtime_state"),
    ),
    commsDoc: summarizeCommsDocDiagnostic(readHandleSnapshot(liveRuntime, "get_comms_state")),
  });

  return () => {
    if (target.__nteractCloudLiveRuntimeSnapshot) {
      delete target.__nteractCloudLiveRuntimeSnapshot;
    }
  };
}

function safeCallNumber(read: () => number): number | null {
  try {
    const value = read();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function readHandleSnapshot(
  liveRuntime: CloudSyncRuntime,
  method: "get_runtime_state" | "get_comms_state",
): unknown {
  const maybeHandle = liveRuntime.handle as unknown as Record<string, unknown>;
  const fn = maybeHandle[method];
  if (typeof fn !== "function") return null;
  try {
    return fn.call(liveRuntime.handle);
  } catch {
    return null;
  }
}

function summarizeResolvedCommDiagnostic(comm: CommChanges["opened"][number]): unknown {
  return {
    commId: comm.commId,
    targetName: comm.targetName,
    modelModule: comm.modelModule,
    modelName: comm.modelName,
    state: summarizeWidgetStateDiagnostic(comm.state),
  };
}

function summarizeRuntimeCommsDiagnostic(snapshot: unknown): unknown {
  if (!isRecord(snapshot) || !isRecord(snapshot.comms)) return null;
  return Object.fromEntries(
    Object.entries(snapshot.comms).map(([commId, entry]) => [
      commId,
      isRecord(entry)
        ? {
            modelModule: entry.model_module,
            modelName: entry.model_name,
            state: summarizeWidgetStateDiagnostic(entry.state),
          }
        : null,
    ]),
  );
}

function summarizeCommsDocDiagnostic(snapshot: unknown): unknown {
  if (!isRecord(snapshot) || !isRecord(snapshot.comms)) return null;
  return Object.fromEntries(
    Object.entries(snapshot.comms).map(([commId, state]) => [
      commId,
      summarizeWidgetStateDiagnostic(state),
    ]),
  );
}

function summarizeWidgetStateDiagnostic(state: unknown): unknown {
  if (!isRecord(state)) return state;
  const summary: Record<string, unknown> = {};
  for (const key of [
    "_model_module",
    "_model_name",
    "value",
    "description",
    "min",
    "max",
    "step",
  ]) {
    const value = state[key];
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      summary[key] = value;
    }
  }
  summary.__keys = Object.keys(state).sort();
  return summary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
