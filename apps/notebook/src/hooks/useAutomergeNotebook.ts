import { startRelayBootstrapCoordinator, useNotebookHost } from "@nteract/notebook-host";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NotebookTransport, SessionStatus, SyncableHandle } from "runtimed";
import { NotebookHandleHost, SyncEngine, isDisplayCapableJupyterOutput } from "runtimed";
import { Observable } from "rxjs";
import { needsPlugin, preWarmForMimes } from "@/components/isolated/iframe-libraries";
import {
  getBlobPort,
  getBlobResolver,
  refreshBlobPort,
  refreshBlobResolver,
} from "../lib/blob-port";
import { logger } from "../lib/logger";
import {
  type CellSnapshot,
  cellSnapshotsToNotebookCells,
  cellSnapshotsToNotebookCellsSync,
} from "../lib/materialize-cells";
import {
  getCellIdsSnapshot,
  replaceNotebookCells,
  resetNotebookCells,
  updateCellById,
  useCellIds,
} from "@/components/notebook/state/cell-store";
import { flushCellUIState, setFocusedCellId } from "@/components/notebook/state/cell-ui-state";
import { createNotebookController } from "@/components/notebook/state/notebook-controller";
import {
  applyExecutionViewChangeset,
  resetRuntimeStoresProjection,
} from "../lib/project-runtime-stores";
import { cloneNotebookFile, openNotebookFile, saveNotebook } from "../lib/notebook-file-ops";
import { setNotebookHandle } from "../lib/notebook-metadata";
import { resetPoolState } from "../lib/pool-state";
import { resetRuntimeState, useRuntimeState } from "../lib/runtime-state";
import {
  notebookReadyIdentity,
  shouldPreserveBootstrapProjection,
} from "../lib/bootstrap-preservation";
import { startNotebookSyncStoreBridge } from "../lib/notebook-sync-store-bridge";
import {
  encode_heartbeat_presence,
  ensureNotebookWasmReady,
  NotebookHandle,
} from "../lib/runtimed-wasm";
import type { JupyterOutput, NotebookCell } from "../types";

/**
 * Matches `notebook_doc::presence::DEFAULT_HEARTBEAT_MS`.
 * The heartbeat is owned by SyncEngine; the encoder is called lazily so React
 * presence stays user-driven and Tauri remains a byte transport.
 */
const PRESENCE_HEARTBEAT_INTERVAL_MS = 15_000;

let loggedWasmReady = false;

function waitForNotebookWasmReady(): Promise<void> {
  return ensureNotebookWasmReady().then(() => {
    if (loggedWasmReady) return;
    loggedWasmReady = true;
    logger.info("[automerge-notebook] WASM initialized");
  });
}

function scopeAllowsNotebookWrite(scope: string | null): boolean {
  return scope === null || scope === "editor" || scope === "owner";
}

let warnedMissingExecutionViewProjector = false;

function projectExecutionViewChangeset(handle: NotebookHandle) {
  const projector = (handle as unknown as SyncableHandle).project_execution_view_changeset;
  if (typeof projector !== "function") {
    if (!warnedMissingExecutionViewProjector) {
      warnedMissingExecutionViewProjector = true;
      logger.warn(
        "[automerge-notebook] WASM handle is missing project_execution_view_changeset; rebuild runtimed-wasm so execution view stores stay current",
      );
    }
    return undefined;
  }
  return projector.call(handle);
}

function preWarmCellRenderers(cells: readonly NotebookCell[]) {
  const pluginMimes = new Set<string>();
  for (const cell of cells) {
    if (cell.cell_type === "markdown" && cell.source.trim().length > 0) {
      pluginMimes.add("text/markdown");
      continue;
    }
    if (cell.cell_type !== "code") continue;
    for (const output of cell.outputs) {
      if (!isDisplayCapableJupyterOutput(output)) continue;
      for (const mime of Object.keys(output.data)) {
        if (needsPlugin(mime)) pluginMimes.add(mime);
      }
    }
  }
  if (pluginMimes.size > 0) preWarmForMimes(pluginMimes);
}

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
export function useNotebook() {
  const host = useNotebookHost();
  const cellIds = useCellIds();
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canAcceptCellMutations, setCanAcceptCellMutations] = useState(false);

  const handleRef = useRef<NotebookHandle | null>(null);
  const sessionIdRef = useRef(crypto.randomUUID().slice(0, 8));
  const outputCacheRef = useRef<Map<string, JupyterOutput>>(new Map());
  const prevPathRef = useRef<string | null>(null);
  const actorLabelRef = useRef(`desktop:${sessionIdRef.current}`);
  const commentsDocIdRef = useRef<string | null>(null);
  const commentsAuthorityActorLabelRef = useRef<string | null>(null);
  const [localActor, setLocalActor] = useState(actorLabelRef.current);
  const [connectionScope, setConnectionScope] = useState<string | null>(null);
  const canWriteNotebookRef = useRef(true);
  const readyNotebookIdentityRef = useRef<string | null>(null);

  const [handleHost] = useState(
    () =>
      new NotebookHandleHost<NotebookHandle>({
        actorLabel: () => actorLabelRef.current,
        createHandle: (actorLabel) => {
          const commentsDocId = commentsDocIdRef.current;
          const commentsAuthority = commentsAuthorityActorLabelRef.current;
          if (commentsDocId && commentsAuthority) {
            return NotebookHandle.create_bootstrap_with_comments(
              actorLabel,
              commentsDocId,
              commentsAuthority,
            );
          }
          return NotebookHandle.create_empty_with_actor(actorLabel);
        },
        getBlobPort,
        publishHandle: setNotebookHandle,
        ready: waitForNotebookWasmReady,
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
    // Pre-warm renderer plugins before cells paint so document-like markdown
    // and output iframes do not wait for async chunk loads on first render.
    preWarmCellRenderers(newCells);
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
    preWarmCellRenderers(newCells);
    replaceNotebookCells(newCells);
  }, []);

  const refreshCanAcceptCellMutations = useCallback(
    (handle = handleHost.current) => {
      const canAccept = canWriteNotebookRef.current && (handle?.has_cells_map() ?? false);
      setCanAcceptCellMutations(canAccept);
      return canAccept;
    },
    [handleHost],
  );

  const focusCellInStore = useCallback((cellId: string) => {
    setFocusedCellId(cellId);
    flushCellUIState();
  }, []);

  const notebookController = useMemo(
    () =>
      createNotebookController<NotebookHandle>({
        getHandle: () => handleHost.current,
        getEngine: () => engineRef.current,
        canWriteCellSource: () => canWriteNotebookRef.current,
        canEditStructure: () => canWriteNotebookRef.current,
        canAcceptStructure: (handle) => handle.has_cells_map(),
        applyMutationEvent: (event) => {
          const engine = engineRef.current;
          return engine
            ? engine.applyLocalMutationEvent(
                event as Parameters<typeof engine.applyLocalMutationEvent>[0],
              )
            : false;
        },
        afterMutation: (handle, kind) => {
          rematerializeCellsSync(handle);
          if (kind === "outputs" || kind === "visibility" || kind === "structure") {
            applyExecutionViewChangeset(projectExecutionViewChangeset(handle));
          }
        },
        refreshCanAcceptCellMutations,
        onFocusCell: focusCellInStore,
        logPrefix: "[automerge-notebook]",
      }),
    [focusCellInStore, handleHost, refreshCanAcceptCellMutations, rematerializeCellsSync],
  );

  // ── Bootstrap ──────────────────────────────────────────────────────

  const bootstrap = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      const bootstrapped = await handleHost.bootstrap(isCancelled);
      if (!bootstrapped) return false;

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
      return host.relay.notifySyncReady(relayGeneration);
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

    const storeBridge = startNotebookSyncStoreBridge({
      engine,
      getHandle: () => handleHost.current,
      materializeCells,
      outputCache: outputCacheRef.current,
      projectExecutionViewChangeset,
      refreshCanAcceptCellMutations,
      setIsLoading,
      setLoadError,
    });

    // ── Bootstrap / daemon lifecycle ─────────────────────────────

    const relayBootstrap = startRelayBootstrapCoordinator({
      onReady: host.daemonEvents.onReady,
      requiresReadyGeneration: host.relay.requiresReadyGeneration,
      beforeBootstrap: (trigger) => {
        if (trigger.kind !== "ready") return;

        logger.info("[automerge-notebook] daemon:ready — bootstrapping relay generation");
        if (trigger.payload.actor_label) {
          actorLabelRef.current = trigger.payload.actor_label;
          setLocalActor(trigger.payload.actor_label);
        }
        commentsDocIdRef.current = trigger.payload.comments_doc_id ?? null;
        commentsAuthorityActorLabelRef.current =
          trigger.payload.comments_authority_actor_label ?? null;
        const connectionScope = trigger.payload.connection_scope ?? null;
        setConnectionScope(connectionScope);
        canWriteNotebookRef.current = scopeAllowsNotebookWrite(connectionScope);
        const nextNotebookIdentity = notebookReadyIdentity(trigger.payload);
        const preserveProjection = shouldPreserveBootstrapProjection({
          previousIdentity: readyNotebookIdentityRef.current,
          nextIdentity: nextNotebookIdentity,
          visibleCellCount: getCellIdsSnapshot().length,
        });
        readyNotebookIdentityRef.current = nextNotebookIdentity;
        storeBridge.resetReadiness();
        refreshBlobPort();
        if (preserveProjection) {
          logger.info(
            "[automerge-notebook] preserving notebook projection across same-room rebootstrap",
          );
        } else {
          resetNotebookCells();
          resetRuntimeState();
          resetRuntimeStoresProjection();
          outputCacheRef.current.clear();
        }
        resetPoolState();
        setCanAcceptCellMutations(false);
        setIsLoading(true);
        setLoadError(null);
      },
      bootstrap: (isCancelled) => bootstrap(() => cancelled || isCancelled()),
      prepareRelay: host.relay.prepareSync,
      notifyRelayReady,
      onMissingGeneration: () => {
        logger.debug(
          "[automerge-notebook] daemon:ready payload had no relay generation; relay ack skipped",
        );
      },
      onBootstrapError: (error) => {
        logger.error("[automerge-notebook] Bootstrap failed", error);
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
          setIsLoading(false);
        }
      },
      onNotifyError: (error) => {
        logger.warn("[automerge-notebook] Failed to signal sync ready:", error);
      },
    });

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

      storeBridge.stop();
      relayBootstrap.stop();

      engineRef.current = null;
      transportRef.current = null;

      resetNotebookCells();
      resetRuntimeState();
      resetRuntimeStoresProjection();
      resetPoolState();
      canWriteNotebookRef.current = false;
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

  const updateCellSource = useCallback(
    (cellId: string, source: string) => {
      notebookController.updateCellSource(cellId, source);
    },
    [notebookController],
  );

  const addCell = useCallback(
    (cellType: "code" | "markdown" | "raw", afterCellId?: string | null): NotebookCell | null => {
      return notebookController.addCell(cellType, afterCellId);
    },
    [notebookController],
  );

  const moveCell = useCallback(
    (cellId: string, afterCellId?: string | null) => {
      notebookController.moveCell(cellId, afterCellId);
    },
    [notebookController],
  );

  const deleteCell = useCallback(
    (cellId: string) => {
      notebookController.deleteCell(cellId);
    },
    [notebookController],
  );

  const clearOutputs = useCallback(
    (cellIds: string | string[]) => {
      return notebookController.clearOutputs(cellIds);
    },
    [notebookController],
  );

  const setCellSourceHidden = useCallback(
    (cellId: string, hidden: boolean) => {
      notebookController.setCellSourceHidden(cellId, hidden);
    },
    [notebookController],
  );

  const setCellOutputsHidden = useCallback(
    (cellId: string, hidden: boolean) => {
      notebookController.setCellOutputsHidden(cellId, hidden);
    },
    [notebookController],
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

  const applyExecutionCountFromDaemon = useCallback((cellId: string, count: number) => {
    updateCellById(cellId, (c) => (c.cell_type === "code" ? { ...c, execution_count: count } : c));
  }, []);

  // ── Public interface ───────────────────────────────────────────────

  const getHandle = useCallback(() => handleHost.current, [handleHost]);
  const triggerSync = useCallback(() => engineRef.current?.scheduleFlush(), []);

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
    updateCellSource,
    addCell,
    moveCell,
    deleteCell,
    clearOutputs,
    save,
    openNotebook,
    cloneNotebook,
    loadError,
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
    connectionScope,
  };
}

/**
 * @deprecated Use `useNotebook`. The hook still owns an Automerge-backed
 * notebook handle, but the product-facing API should be host-neutral.
 */
export const useAutomergeNotebook = useNotebook;
