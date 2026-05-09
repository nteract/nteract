import { useNotebookHost, type DaemonReadyPayload } from "@nteract/notebook-host";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NotebookTransport, SessionStatus, SyncableHandle } from "runtimed";
import {
  NotebookHandleHost,
  SyncEngine,
  isDisplayCapableJupyterOutput,
  isInitialLoadFailed,
  isInitialLoadStreaming,
  planCellPointerRefresh,
} from "runtimed";
import { concatMap, from, Observable, switchMap } from "rxjs";
import { needsPlugin, preWarmForMimes } from "@/components/isolated/iframe-libraries";
import {
  getBlobPort,
  getBlobResolver,
  refreshBlobPort,
  refreshBlobResolver,
} from "../lib/blob-port";
import { materializeChangeset } from "../lib/frame-pipeline";
import { logger } from "../lib/logger";
import {
  type CellSnapshot,
  cellSnapshotsToNotebookCells,
  cellSnapshotsToNotebookCellsSync,
} from "../lib/materialize-cells";
import {
  getNotebookCellsSnapshot,
  replaceNotebookCells,
  resetNotebookCells,
  updateCellById,
  updateNotebookCells,
  useCellIds,
} from "../lib/notebook-cells";
import {
  applyOutputChangeset,
  projectRuntimeStateToExecutions,
  resetRuntimeStoresProjection,
  seedOutputStoresFromHandle,
  updateCellExecutionPointersFromHandle,
} from "../lib/project-runtime-stores";
import { updateOutputsByDisplayId } from "../lib/notebook-outputs";
import { cloneNotebookFile, openNotebookFile, saveNotebook } from "../lib/notebook-file-ops";
import { emitBroadcast, emitPresence } from "../lib/notebook-frame-bus";
import { notifyMetadataChanged, setNotebookHandle } from "../lib/notebook-metadata";
import { type PoolState, resetPoolState, setPoolState } from "../lib/pool-state";
import {
  getRuntimeState,
  resetRuntimeState,
  setRuntimeState,
  useRuntimeState,
} from "../lib/runtime-state";
import type { JupyterOutput, NotebookCell } from "../types";
import init, {
  encode_heartbeat_presence,
  NotebookHandle,
} from "../wasm/runtimed-wasm/runtimed_wasm.js";

/**
 * Matches `notebook_doc::presence::DEFAULT_HEARTBEAT_MS`.
 * The heartbeat is owned by SyncEngine; the encoder is called lazily so React
 * presence stays user-driven and Tauri remains a byte transport.
 */
const PRESENCE_HEARTBEAT_INTERVAL_MS = 15_000;

const wasmReady: Promise<void> = init().then(() => {
  logger.info("[automerge-notebook] WASM initialized");
});

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Local-first notebook hook backed by `runtimed-wasm` NotebookHandle.
 *
 * All document mutations execute instantly inside the WASM Automerge
 * document. The external store is derived from the doc. Sync messages
 * flow through the SyncEngine → host.transport to the daemon.
 */
export function useAutomergeNotebook() {
  const host = useNotebookHost();
  const cellIds = useCellIds();
  const [focusedCellId, setFocusedCellId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canAcceptCellMutations, setCanAcceptCellMutations] = useState(false);

  const handleRef = useRef<NotebookHandle | null>(null);
  const sessionIdRef = useRef(crypto.randomUUID().slice(0, 8));
  const outputCacheRef = useRef<Map<string, JupyterOutput>>(new Map());
  const interactiveReadyRef = useRef(false);
  const latestSessionStatusRef = useRef<SessionStatus | null>(null);
  const prevPathRef = useRef<string | null>(null);

  const [handleHost] = useState(
    () =>
      new NotebookHandleHost<NotebookHandle>({
        actorLabel: () => `human:${sessionIdRef.current}`,
        createHandle: (actorLabel) => NotebookHandle.create_empty_with_actor(actorLabel),
        getBlobPort,
        publishHandle: setNotebookHandle,
        ready: wasmReady,
        refreshBlobPort,
        slot: handleRef,
      }),
  );

  // SyncEngine and transport refs — stable across re-renders.
  const engineRef = useRef<SyncEngine | null>(null);
  const transportRef = useRef<NotebookTransport | null>(null);

  // Refresh blob port on mount.
  useEffect(() => {
    refreshBlobPort();
  }, []);

  // Mirror `RuntimeStateDoc.path` to Tauri so the window title tracks
  // path renames (untitled→saved, save-as). The doc is daemon-authored
  // and reaches us via normal CRDT sync (frame 0x05).
  const runtimeState = useRuntimeState();
  const runtimePath = runtimeState.path ?? null;
  useEffect(() => {
    if (runtimePath !== prevPathRef.current) {
      prevPathRef.current = runtimePath;
      if (runtimePath != null) {
        host.notebook.applyPathChanged(runtimePath).catch(() => {});
      }
    }
  }, [runtimePath, host]);

  // ── Core helpers ───────────────────────────────────────────────────

  /** Full materialization: WASM doc → resolve manifests → write to store. */
  const materializeCells = useCallback(async (handle: NotebookHandle) => {
    const start = performance.now();
    // Resolve blob port BEFORE reading cells — WASM needs it to
    // convert binary ContentRefs to Url variants in get_cells_json().
    let blobResolver = getBlobResolver();
    if (blobResolver === null) {
      blobResolver = await refreshBlobResolver();
    }
    const blobPort = blobResolver?.port ?? null;
    if (blobPort !== null) {
      handle.set_blob_port(blobPort);
    }
    const json = handle.get_cells_json();
    const snapshots: CellSnapshot[] = JSON.parse(json);
    const newCells = await cellSnapshotsToNotebookCells(
      snapshots,
      blobResolver,
      outputCacheRef.current,
    );
    // Pre-warm plugin cache from output MIME types so iframe rendering
    // doesn't wait for async loads
    const pluginMimes: string[] = [];
    for (const c of newCells) {
      if (c.cell_type === "code") {
        for (const output of c.outputs) {
          if (isDisplayCapableJupyterOutput(output)) {
            for (const mime of Object.keys(output.data)) {
              if (needsPlugin(mime)) pluginMimes.push(mime);
            }
          }
        }
      }
    }
    if (pluginMimes.length > 0) preWarmForMimes(pluginMimes);
    replaceNotebookCells(newCells);
    logger.debug(
      `[automerge-notebook] Full materialization: ${snapshots.length} cells in ${(performance.now() - start).toFixed(1)}ms`,
    );
  }, []);

  /** Sync re-read cells from WASM (cache-only, no blob fetches). */
  const rematerializeCellsSync = useCallback((handle: NotebookHandle) => {
    const json = handle.get_cells_json();
    const snapshots: CellSnapshot[] = JSON.parse(json);
    const newCells = cellSnapshotsToNotebookCellsSync(
      snapshots,
      outputCacheRef.current,
      getBlobResolver(),
    );
    replaceNotebookCells(newCells);
  }, []);

  const refreshCanAcceptCellMutations = useCallback(
    (handle = handleHost.current) => {
      const canAccept = handle?.has_cells_map() ?? false;
      setCanAcceptCellMutations(canAccept);
      return canAccept;
    },
    [handleHost],
  );

  /**
   * Guard + commit helper for WASM mutations.
   * After the mutation callback runs, re-materializes and syncs.
   */
  const commitMutation = useCallback(
    (mutate: (handle: NotebookHandle) => boolean) => {
      const handle = handleHost.current;
      const engine = engineRef.current;
      if (!handle || !engine) {
        logger.debug("[automerge-notebook] commitMutation skipped: no handle/engine");
        return false;
      }
      if (!mutate(handle)) return false;
      rematerializeCellsSync(handle);
      engine.flush();
      return true;
    },
    [handleHost, rematerializeCellsSync],
  );

  // ── Bootstrap ──────────────────────────────────────────────────────

  const bootstrap = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      const bootstrapped = await handleHost.bootstrap(isCancelled);
      if (!bootstrapped) return false;

      interactiveReadyRef.current = false;
      latestSessionStatusRef.current = null;
      setCanAcceptCellMutations(false);
      setLoadError(null);
      setIsLoading(true);

      // Flush initial sync message through the engine.
      const engine = engineRef.current;
      if (engine) {
        engine.resetForBootstrap();
        engine.flush();
      }

      logger.info("[automerge-notebook] Bootstrap: empty handle, awaiting sync");
      return true;
    },
    [handleHost],
  );

  const notifyRelayReady = useCallback(
    (relayGeneration?: number) => {
      if (relayGeneration === undefined) {
        logger.debug(
          "[automerge-notebook] Signaling relay ready without a relay generation; active gates will reject it",
        );
      }
      return host.relay
        .notifySyncReady(relayGeneration)
        .catch((e: unknown) => logger.warn("[automerge-notebook] Failed to signal sync ready:", e));
    },
    [host.relay],
  );

  // ── Lifecycle (single effect) ──────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    // Use the host's transport — shared with the NotebookClient in App.tsx
    // and any other consumer. One socket, one listener path.
    const transport = host.transport;
    const engine = new SyncEngine({
      getHandle: () => handleHost.current as SyncableHandle | null,
      transport,
      presenceHeartbeat: {
        intervalMs: PRESENCE_HEARTBEAT_INTERVAL_MS,
        encode: () => encode_heartbeat_presence("local"),
      },
      logger,
    });

    transportRef.current = transport;
    engineRef.current = engine;

    // Start the engine (subscribes to transport frames).
    engine.start();

    // ── Subscribe to SyncEngine observables ───────────────────────

    const sessionStatusSub = engine.sessionStatus$.subscribe((status) => {
      latestSessionStatusRef.current = status;

      if (isInitialLoadFailed(status.initial_load)) {
        logger.warn("[automerge-notebook] Initial load failed:", status.initial_load.reason);
        setLoadError(status.initial_load.reason);
        setIsLoading(false);
        return;
      }

      setLoadError(null);
      refreshCanAcceptCellMutations();
      if (interactiveReadyRef.current) {
        setIsLoading(isInitialLoadStreaming(status.initial_load));
      }
    });

    // Initial sync completion → full materialization.
    const initialSyncSub = engine.initialSyncComplete$.subscribe(() => {
      logger.info("[automerge-notebook] Notebook interactive, materializing");
      const handle = handleHost.current;
      if (handle) {
        materializeCells(handle)
          .then(() => {
            interactiveReadyRef.current = true;
            // Seed the cell -> execution_id pointer store from the doc.
            // Seed pointers for the current snapshot once the daemon says
            // the notebook replica is interactive.
            const cellIdList = [...handle.get_cell_ids()];
            updateCellExecutionPointersFromHandle(handle, cellIdList);
            // Seed the outputs / executions stores straight from the
            // notebook doc. `initialSyncComplete$` fires when the
            // notebook doc is interactive, not when RuntimeStateDoc is
            // necessarily finished bootstrapping, so this preserves
            // existing eager output visibility until the authoritative
            // runtime-state projection lands.
            seedOutputStoresFromHandle(handle, cellIdList);
            refreshCanAcceptCellMutations(handle);
            // Project whatever RuntimeState snapshot has landed so far
            // on top. If the runtime-state frame arrived first this is
            // the authoritative pass; otherwise it's a no-op that the
            // runtimeState$ subscription will redo on the next tick.
            projectRuntimeStateToExecutions(getRuntimeState());
            const status = latestSessionStatusRef.current;
            setIsLoading(status ? isInitialLoadStreaming(status.initial_load) : false);
            notifyMetadataChanged();
            logger.info("[automerge-notebook] Interactive materialization done");
          })
          .catch((err: unknown) => {
            logger.warn("[automerge-notebook] initial materialize failed:", err);
            setLoadError(err instanceof Error ? err.message : String(err));
            setIsLoading(false);
          });
      } else {
        setIsLoading(false);
      }
    });

    // Steady-state cell changes → incremental materialization.
    // concatMap serializes async work — if a batch awaits blob resolution,
    // subsequent batches queue rather than overlapping store writes.
    const cellChangesSub = engine.cellChanges$
      .pipe(
        concatMap((changeset) =>
          from(
            materializeChangeset(changeset, {
              getHandle: () => handleHost.current,
              materializeCells,
              outputCache: outputCacheRef.current,
            })
              .then(() => {
                // After cells update, refresh per-cell execution_id pointers
                // from the canonical notebook doc so <CellLabel> / future
                // Out[N] readers see the current execution, not whatever
                // RuntimeStateDoc entry happened to land last.
                const handle = handleHost.current;
                if (!handle) return;
                refreshCanAcceptCellMutations(handle);
                const pointerRefresh = planCellPointerRefresh(changeset);
                if (pointerRefresh.kind === "touched") {
                  updateCellExecutionPointersFromHandle(handle, pointerRefresh.cell_ids);
                } else if (pointerRefresh.kind === "all") {
                  updateCellExecutionPointersFromHandle(handle, [...handle.get_cell_ids()]);
                }
              })
              .catch((err: unknown) =>
                logger.warn("[automerge-notebook] materialize changeset failed:", err),
              ),
          ),
        ),
      )
      .subscribe();

    // Broadcasts → frame bus.
    const broadcastsSub = engine.broadcasts$.subscribe((payload) => emitBroadcast(payload));

    // Presence → frame bus.
    const presenceSub = engine.presence$.subscribe((payload) => emitPresence(payload));

    // Runtime state → store + executions projection. The executions store
    // is a narrow per-execution_id projection that lets <CellLabel> /
    // <OutputArea> subscribe at execution granularity instead of at the
    // cell granularity. See lib/notebook-executions.ts.
    const runtimeStateSub = engine.runtimeState$.subscribe((state) => {
      setRuntimeState(state);
      projectRuntimeStateToExecutions(state);
    });

    // Per-output changes → outputs store. WASM narrows each manifest
    // before emitting, so stream appends only touch the affected
    // output's subscribers and no second state-doc walk is needed.
    const outputIdChangesSub = engine.outputIdChanges$.subscribe(({ changed, removed_ids }) => {
      if (changed.length === 0 && removed_ids.length === 0) return;
      void applyOutputChangeset(changed, removed_ids).catch((err) =>
        logger.warn("[automerge-notebook] output store projection failed:", err),
      );
    });

    // Pool state → store.
    const poolStateSub = engine.poolState$.subscribe((state) => setPoolState(state as PoolState));

    // ── Bootstrap ─────────────────────────────────────────────────

    setIsLoading(true);
    void host.daemon
      .getReadyInfo()
      .catch(() => null)
      .then((readyInfo) =>
        bootstrap(() => cancelled).then((bootstrapped) => ({ bootstrapped, readyInfo })),
      )
      .then((bootstrapped) => {
        if (!bootstrapped.bootstrapped || cancelled) return;
        // Signal the Rust relay only after the WASM handle exists and the
        // bootstrap reset has run. Otherwise buffered daemon frames can mark
        // the session interactive, then resetForBootstrap() emits pending
        // afterward with no later status frame to recover.
        return notifyRelayReady(bootstrapped.readyInfo?.relay_generation);
      })
      .catch((error) => {
        logger.error("[automerge-notebook] Bootstrap failed", error);
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
          setIsLoading(false);
        }
      });

    // ── Daemon lifecycle ─────────────────────────────────────────

    const lifecycleSub = new Observable<DaemonReadyPayload>((subscriber) =>
      host.daemonEvents.onReadyLive((payload) => subscriber.next(payload)),
    )
      .pipe(
        switchMap((readyPayload) => {
          logger.info("[automerge-notebook] daemon:ready — re-bootstrapping");
          refreshBlobPort();
          resetNotebookCells();
          resetRuntimeState();
          resetRuntimeStoresProjection();
          resetPoolState();
          setCanAcceptCellMutations(false);
          outputCacheRef.current.clear();
          setIsLoading(true);
          setLoadError(null);
          return from(
            bootstrap(() => cancelled)
              .then((bootstrapped) => {
                if (!bootstrapped || cancelled) return;
                return notifyRelayReady(readyPayload.relay_generation);
              })
              .catch((err: unknown) => {
                logger.error("[automerge-notebook] lifecycle bootstrap failed:", err);
                if (!cancelled) {
                  setLoadError(err instanceof Error ? err.message : String(err));
                  setIsLoading(false);
                }
              }),
          );
        }),
      )
      .subscribe();

    return () => {
      cancelled = true;
      logger.info("[automerge-notebook] Cleanup: flushing and stopping engine");

      // Flush pending local changes before stopping.
      engine.flush();
      engine.stop();
      // Do NOT call `transport.disconnect()`. The transport is owned by
      // the host (one shared instance across NotebookClient, SyncEngine,
      // frame-types outbound helpers, etc.) and must outlive this hook's
      // rehearsal unmount under React StrictMode. `engine.stop()` already
      // unsubscribes the frame listener this hook installed.

      initialSyncSub.unsubscribe();
      sessionStatusSub.unsubscribe();
      cellChangesSub.unsubscribe();
      broadcastsSub.unsubscribe();
      presenceSub.unsubscribe();
      runtimeStateSub.unsubscribe();
      outputIdChangesSub.unsubscribe();
      poolStateSub.unsubscribe();
      lifecycleSub.unsubscribe();

      engineRef.current = null;
      transportRef.current = null;

      resetNotebookCells();
      resetRuntimeState();
      resetRuntimeStoresProjection();
      resetPoolState();
      setCanAcceptCellMutations(false);
      handleHost.clear();
    };
  }, [
    bootstrap,
    handleHost,
    host,
    materializeCells,
    notifyRelayReady,
    refreshCanAcceptCellMutations,
  ]);

  // ── Cell mutations ─────────────────────────────────────────────────

  const updateCellSource = useCallback((cellId: string, source: string) => {
    const handle = handleHost.current;
    const engine = engineRef.current;
    if (!handle || !engine) return;

    const updated = handle.update_source(cellId, source);
    if (!updated) return;

    updateCellById(cellId, (c) => ({ ...c, source }));
    engine.scheduleFlush();
  }, []);

  const addCell = useCallback(
    (cellType: "code" | "markdown" | "raw", afterCellId?: string | null): NotebookCell | null => {
      const handle = handleHost.current;
      const engine = engineRef.current;

      if (!handle || !engine) {
        logger.debug("[automerge-notebook] addCell skipped: no handle/engine");
        return null;
      }

      if (!handle.has_cells_map()) {
        logger.debug("[automerge-notebook] addCell skipped: cells map not synced yet");
        setCanAcceptCellMutations(false);
        return null;
      }

      const cellId = crypto.randomUUID();
      try {
        handle.add_cell_after(cellId, cellType, afterCellId ?? null);
      } catch (error) {
        logger.warn("[automerge-notebook] addCell failed:", error);
        refreshCanAcceptCellMutations(handle);
        return null;
      }
      rematerializeCellsSync(handle);
      engine.flush();
      setFocusedCellId(cellId);

      const cell = getNotebookCellsSnapshot().find((c) => c.id === cellId);
      if (cell) return cell;
      if (cellType === "code") {
        return {
          cell_type: "code",
          id: cellId,
          source: "",
          outputs: [],
          execution_count: null,
          metadata: {},
        };
      }
      return {
        cell_type: cellType,
        id: cellId,
        source: "",
        metadata: {},
      };
    },
    [refreshCanAcceptCellMutations, rematerializeCellsSync],
  );

  const moveCell = useCallback(
    (cellId: string, afterCellId?: string | null) => {
      commitMutation((handle) => {
        handle.move_cell(cellId, afterCellId ?? null);
        return true;
      });
    },
    [commitMutation],
  );

  const deleteCell = useCallback(
    (cellId: string) => {
      commitMutation((handle) => {
        if (handle.cell_count() <= 1) return false;
        return !!handle.delete_cell(cellId);
      });
    },
    [commitMutation],
  );

  const clearOutputs = useCallback(
    (cellIds: string | string[]) => {
      const ids = Array.isArray(cellIds) ? cellIds : [cellIds];
      if (ids.length === 0) return false;
      const handle = handleHost.current;
      const engine = engineRef.current;
      if (!handle || !engine) {
        logger.debug("[automerge-notebook] clearOutputs skipped: no handle/engine");
        return false;
      }

      let changed = false;
      for (const cellId of ids) {
        changed = !!handle.clear_outputs(cellId) || changed;
      }
      if (!changed) return false;

      rematerializeCellsSync(handle);
      updateCellExecutionPointersFromHandle(handle, ids);
      engine.flush();
      return true;
    },
    [rematerializeCellsSync],
  );

  const setCellSourceHidden = useCallback(
    (cellId: string, hidden: boolean) => {
      commitMutation((handle) => {
        return !!handle.set_cell_source_hidden(cellId, hidden);
      });
    },
    [commitMutation],
  );

  const setCellOutputsHidden = useCallback(
    (cellId: string, hidden: boolean) => {
      commitMutation((handle) => {
        return !!handle.set_cell_outputs_hidden(cellId, hidden);
      });
    },
    [commitMutation],
  );

  // ── Sync flush ─────────────────────────────────────────────────────

  /**
   * Flush pending sync immediately (call before execute/save).
   *
   * Delegates to the SyncEngine's `flushAndWait()` which:
   * 1. Awaits any in-flight debounced flush (prevents race where the debounce
   *    timer claims changes but its IPC hasn't completed yet).
   * 2. Flushes remaining local changes and awaits delivery.
   */
  const flushSync = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) {
      logger.debug("[flushSync] skipped: no engine");
      return true;
    }
    return await engine.flushAndWait();
  }, []);

  // ── File operations ────────────────────────────────────────────────

  const save = useCallback(async () => {
    // `runtimeState.path` is the authoritative source: the daemon writes
    // it on save / save-as / untitled promotion. Reading it here avoids
    // a Tauri round-trip to the WindowNotebookRegistry.
    const hasPath = runtimePath != null;
    await saveNotebook(host, flushSync, hasPath);
  }, [host, flushSync, runtimePath]);

  const openNotebook = useCallback(() => openNotebookFile(host), [host]);

  const cloneNotebook = useCallback(() => cloneNotebookFile(host), [host]);

  // ── Output overlays (optimistic, pre-sync) ─────────────────────────

  const updateOutputByDisplayId = useCallback(
    (
      displayId: string,
      newData: Record<string, unknown>,
      newMetadata?: Record<string, unknown>,
    ) => {
      // Keep the cell snapshot in sync for cross-cell readers that still
      // inspect `cell.outputs` directly.
      updateNotebookCells((prev) =>
        prev.map((c) => {
          if (c.cell_type !== "code") return c;
          let changed = false;
          const updatedOutputs = c.outputs.map((output) => {
            if (isDisplayCapableJupyterOutput(output) && output.display_id === displayId) {
              changed = true;
              return { ...output, data: newData, metadata: newMetadata };
            }
            return output;
          });
          return changed ? { ...c, outputs: updatedOutputs } : c;
        }),
      );
      // Per-output store projection. Patches every matching output so
      // <OutputArea> repaints instantly without waiting for the next
      // runtime_state sync to flow through the projection.
      updateOutputsByDisplayId(displayId, newData, newMetadata);
    },
    [],
  );

  const applyExecutionCountFromDaemon = useCallback((cellId: string, count: number) => {
    updateCellById(cellId, (c) => (c.cell_type === "code" ? { ...c, execution_count: count } : c));
  }, []);

  // ── Public interface ───────────────────────────────────────────────

  const getHandle = useCallback(() => handleHost.current, [handleHost]);
  const triggerSync = useCallback(() => engineRef.current?.scheduleFlush(), []);
  const localActor = `human:${sessionIdRef.current}`;

  /** Accessor for the SyncEngine (for subscribing to commChanges$ etc.). */
  const getEngine = useCallback(() => engineRef.current, []);

  /**
   * Stable `sessionStatus$` proxy. The underlying engine is constructed
   * in this hook's `useEffect`, so subscribers must survive the "engine
   * not yet ready" window. The proxy is built once at hook-init; on each
   * subscribe it attaches to whichever engine is current. Subscribers
   * that call in before the engine exists get the ReplaySubject(1)'s
   * latest as soon as the engine wires itself up — no drop.
   *
   * Child `useEffect`s run before parent's in React, so in practice any
   * component consuming `sessionStatus$` via `useObservable` attaches
   * after this hook's effect has populated `engineRef`. The null guard
   * is a safety net for unusual render orders (e.g. StrictMode).
   */
  const sessionStatus$ = useMemo(
    () =>
      new Observable<SessionStatus>((subscriber) => {
        const engine = engineRef.current;
        if (!engine) {
          // Extremely narrow window. The next mount cycle will re-subscribe.
          return;
        }
        return engine.sessionStatus$.subscribe(subscriber);
      }),
    [],
  );

  return {
    cellIds,
    isLoading,
    canAcceptCellMutations,
    focusedCellId,
    setFocusedCellId,
    updateCellSource,
    addCell,
    moveCell,
    deleteCell,
    clearOutputs,
    save,
    openNotebook,
    cloneNotebook,
    loadError,
    updateOutputByDisplayId,
    applyExecutionCountFromDaemon,
    setCellSourceHidden,
    setCellOutputsHidden,
    flushSync,
    // CRDT bridge context deps
    getHandle,
    getEngine,
    sessionStatus$,
    triggerSync,
    localActor,
  };
}
