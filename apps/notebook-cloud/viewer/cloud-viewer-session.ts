import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  notebookShellWorkstationAttachmentCacheKey,
  type BlobResolver,
  type CommChanges,
  type WorkstationAttachmentState,
} from "runtimed";
import {
  applyWidgetCommBroadcastToStore,
  applyWidgetCommChangesToStore,
} from "@/components/widgets/comm-changes-store-bridge";
import { setCrdtCommWriter } from "@/components/widgets/crdt-comm-writer";
import type { WidgetStore } from "@/components/widgets/widget-store";
import { diagnoseCloudConnectionAccess } from "./connection-diagnostics";
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
  connectCloudSyncRuntime,
  isRecoverableCloudFrameRejection,
  type CloudSyncRuntime,
} from "./live-sync";
import type { CloudViewerLoadingPolicy } from "./loading-policy";
import { markCloudViewerLoadMilestone } from "./load-milestones";
import {
  projectCloudCellsIntoNotebookViewStores,
  resetCloudViewStoreProjection,
} from "./notebook-view-store-bridge";
import { CloudViewerPresenceStore } from "./presence";
import { createOutputResolutionCache, type ResolvedCell } from "./render-resolution";
import { loadSnapshotPairHandle } from "./runtimed-wasm-client";
import { subscribeSerializedCloudCellChanges } from "./serialized-cell-changes";
import { cloudWidgetUpdateManager } from "./widget-runtime";
import { projectCloudWidgetComms } from "./widget-comm-projection";
import type { CloudAppSession } from "./app-session";
import type { CloudAuthRenewalState, ViewerStatus } from "./notice-types";

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
  outputDocumentBaseUrl: string | null;
  runtimedWasmModulePath: string;
  runtimedWasmPath: string;
}

export interface CloudViewerSession {
  connectionActorLabel: string | null;
  connectionError: string | null;
  connectionPeerId: string | null;
  connectionScope: string | null;
  liveMaterializedRef: MutableRefObject<boolean>;
  liveRuntimeRef: MutableRefObject<CloudSyncRuntime | null>;
  notebookLanguageRef: MutableRefObject<string>;
  notebookMetadata: unknown;
  presenceStore: CloudViewerPresenceStore;
  requestCloudMaterialization: (liveRuntime: CloudSyncRuntime) => void;
  retryLiveConnection: () => void;
  snapshotResolvedRef: MutableRefObject<boolean>;
  status: ViewerStatus;
  workstationAttachment: WorkstationAttachmentState | null;
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
  const [workstationAttachment, setWorkstationAttachment] =
    useState<WorkstationAttachmentState | null>(null);
  const notebookLanguageRef = useRef("python");
  const workstationAttachmentKeyRef = useRef(notebookShellWorkstationAttachmentCacheKey(null));
  const liveRuntimeRef = useRef<CloudSyncRuntime | null>(null);
  const materializeLiveRuntimeRef = useRef<((runtime: CloudSyncRuntime) => void) | null>(null);
  const liveMaterializedRef = useRef(false);
  const snapshotResolvedRef = useRef(false);
  const projectedWidgetCommIdsRef = useRef(new Set<string>());
  const outputResolutionCacheRef = useRef(createOutputResolutionCache());
  const incrementalOutputCacheRef = useRef(new Map<string, NotebookStoreJupyterOutput>());
  const presenceStoreRef = useRef<CloudViewerPresenceStore | null>(null);
  if (presenceStoreRef.current === null) {
    presenceStoreRef.current = new CloudViewerPresenceStore();
  }
  const presenceStore = presenceStoreRef.current;
  const [connectionScope, setConnectionScope] = useState<string | null>(null);
  const [connectionPeerId, setConnectionPeerId] = useState<string | null>(null);
  const [connectionActorLabel, setConnectionActorLabel] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectAttempt, setConnectAttempt] = useState(0);

  const applyResolvedCells = useCallback((resolvedCells: ResolvedCell[]) => {
    projectCloudCellsIntoNotebookViewStores(resolvedCells);
    setCells(resolvedCells);
  }, []);

  useEffect(() => resetCloudViewStoreProjection, []);

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
    const sessionId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    const installCloudWidgetCommWriter = (liveRuntime: CloudSyncRuntime) => {
      setCrdtCommWriter((commId: string, patch: Record<string, unknown>) => {
        if (liveRuntimeRef.current !== liveRuntime) return;
        try {
          const changed = liveRuntime.handle.set_comm_state_batch(commId, JSON.stringify(patch));
          if (changed) {
            liveRuntime.engine.scheduleFlush();
          } else {
            console.warn("[notebook-cloud] widget state update did not mutate CommsDoc", {
              commId,
              keys: Object.keys(patch),
            });
          }
        } catch (error) {
          console.warn("[notebook-cloud] widget state update failed", error);
        }
      });
    };
    const disposeCurrentRuntime = () => {
      const liveRuntime = liveRuntimeRef.current;
      if (!liveRuntime) return;
      liveRuntimeRef.current = null;
      setCrdtCommWriter(null);
      disposeCloudSyncRuntime(liveRuntime);
    };
    const scheduleReconnect = (reason: Error) => {
      if (disposed) return;
      console.warn("[notebook-cloud] live room connection closed", reason);
      presenceStore.reduceConnection("disconnected");
      setConnectionScope(null);
      setConnectionActorLabel(null);
      setConnectionError(reason.message);
      setWorkstationAttachment(null);
      workstationAttachmentKeyRef.current = notebookShellWorkstationAttachmentCacheKey(null);
      disposeCurrentRuntime();
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

    presenceStore.reset();
    setWorkstationAttachment(null);
    workstationAttachmentKeyRef.current = notebookShellWorkstationAttachmentCacheKey(null);
    setConnectionError(null);
    setConnectionActorLabel(null);
    setConnectionPeerId(null);
    void (async () =>
      connectCloudSyncRuntime({
        syncEndpoint: config.syncEndpoint,
        runtimedWasmModulePath: config.runtimedWasmModulePath,
        runtimedWasmPath: config.runtimedWasmPath,
        sessionId,
        auth: resolveSyncAuth
          ? await resolveSyncAuth(sessionId)
          : cloudSyncAuthFromPrototypeAuthState(authState),
        onDisconnect: scheduleReconnect,
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
            setConnectionError(null);
            setConnectionScope(message.connection_scope);
            setConnectionActorLabel(message.actor_label);
          }
          if (message.type === "cloud_frame_rejected") {
            if (isRecoverableCloudFrameRejection(message)) {
              const reason = new Error(`Room rejected sync frame: ${message.reason}`);
              setStatus({
                kind: "loading",
                message: "Resynchronizing live notebook room after a rejected sync frame...",
              });
              scheduleReconnect(reason);
              return;
            }
            setStatus({ kind: "error", message: `Room rejected a frame: ${message.reason}` });
          }
        },
      }))()
      .then((liveRuntime) => {
        if (disposed) {
          disposeCloudSyncRuntime(liveRuntime);
          return;
        }
        liveRuntimeRef.current = liveRuntime;
        installCloudWidgetCommWriter(liveRuntime);
        const stopWidgetLiveRuntimeDiagnostics =
          installCloudWidgetLiveRuntimeDiagnostics(liveRuntime);
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
          subscribeSerializedCloudCellChanges({
            cellChanges$: liveRuntime.engine.cellChanges$,
            materializeChangeset: (changeset) => materializeLiveChangeset(changeset, liveRuntime),
            onMaterializationError: (error) => {
              console.warn("[notebook-cloud] live changeset materialization failed", error);
            },
          }),
          liveRuntime.engine.runtimeState$.subscribe((state) => {
            setRuntimeState(state);
            const nextAttachment = state.workstation ?? null;
            const nextKey = notebookShellWorkstationAttachmentCacheKey(nextAttachment);
            if (nextKey !== workstationAttachmentKeyRef.current) {
              workstationAttachmentKeyRef.current = nextKey;
              setWorkstationAttachment(nextAttachment);
            }
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
          { unsubscribe: stopCursorDispatch },
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
        setWorkstationAttachment(null);
        workstationAttachmentKeyRef.current = notebookShellWorkstationAttachmentCacheKey(null);
        setConnectionError(message);
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
      setCrdtCommWriter(null);
      resetCloudViewStoreProjection();
      resetRuntimeState();
      resetRuntimeStoresProjection();
      resetPoolState();
      livePresenceStore = null;
      presenceStore.reduceConnection("disconnected");
      setConnectionPeerId(null);
      setWorkstationAttachment(null);
      workstationAttachmentKeyRef.current = notebookShellWorkstationAttachmentCacheKey(null);
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
