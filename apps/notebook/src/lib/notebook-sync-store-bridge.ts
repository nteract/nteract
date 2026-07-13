import type {
  ExecutionViewChangeset,
  SessionStatus,
  SyncEngine,
} from "runtimed";
import { isInitialLoadFailed, isInitialLoadStreaming } from "runtimed";
import { concatMap, from, Subscription } from "rxjs";
import type { JupyterOutput } from "../types";
import type { NotebookHandle } from "../wasm/runtimed-wasm/runtimed_wasm.js";
import {
  materializeChangeset,
  publishProgressiveInitialStructureSlice,
} from "./frame-pipeline";
import { logger } from "./logger";
import { emitBroadcast, emitPresence } from "./notebook-frame-bus";
import { notifyMetadataChanged } from "./notebook-metadata";
import {
  applyExecutionViewChangeset,
  applyOutputChangeset,
  seedOutputStoresFromHandle,
} from "./project-runtime-stores";
import { setPoolState } from "./pool-state";
import { setRuntimeState } from "./runtime-state";

type SyncEngineStoreStreams = Pick<
  SyncEngine,
  | "sessionStatus$"
  | "initialSyncComplete$"
  | "cellChanges$"
  | "broadcasts$"
  | "presence$"
  | "runtimeState$"
  | "executionViewChanges$"
  | "outputIdChanges$"
  | "poolState$"
>;

function initialLoadAllowsMutations(status: SessionStatus | null): boolean {
  return (
    status?.initial_load.phase === "ready" ||
    status?.initial_load.phase === "not_needed"
  );
}

export interface NotebookSyncStoreBridgeOptions {
  engine: SyncEngineStoreStreams;
  getHandle: () => NotebookHandle | null;
  materializeCells: (handle: NotebookHandle) => Promise<void>;
  outputCache: Map<string, JupyterOutput>;
  projectExecutionViewChangeset: (
    handle: NotebookHandle,
  ) => ExecutionViewChangeset | null | undefined;
  refreshCanAcceptCellMutations: (handle?: NotebookHandle) => boolean;
  setInitialLoadReadyForMutations: (ready: boolean) => void;
  setIsLoading: (isLoading: boolean) => void;
  setLoadError: (loadError: string | null) => void;
  bootstrapTimeoutMs?: number;
  onBootstrapTimeout?: () => void;
}

export interface NotebookSyncStoreBridge {
  resetReadiness(): void;
  stop(): void;
}

export function startNotebookSyncStoreBridge(
  options: NotebookSyncStoreBridgeOptions,
): NotebookSyncStoreBridge {
  let interactiveReady = false;
  let initialMaterializeDeferred = false;
  let initialMaterializeInFlight = false;
  let initialLoadCurrentlyStreaming = false;
  let initialLoadWasStreaming = false;
  let latestSessionStatus: SessionStatus | null = null;
  let stopped = false;
  let bootstrapTimeout: ReturnType<typeof setTimeout> | null = null;
  let bootstrapTimeoutFired = false;
  const subscription = new Subscription();
  const bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? 90_000;

  const clearBootstrapTimeout = (resetFired = false) => {
    if (bootstrapTimeout !== null) {
      clearTimeout(bootstrapTimeout);
      bootstrapTimeout = null;
    }
    if (resetFired) {
      bootstrapTimeoutFired = false;
    }
  };

  const armBootstrapTimeout = () => {
    clearBootstrapTimeout();
    if (bootstrapTimeoutMs <= 0 || bootstrapTimeoutFired) return;
    bootstrapTimeout = setTimeout(() => {
      bootstrapTimeout = null;
      if (stopped || interactiveReady || initialLoadCurrentlyStreaming) return;
      bootstrapTimeoutFired = true;
      logger.warn(
        `[automerge-notebook] Bootstrap timed out after ${bootstrapTimeoutMs}ms before notebook became interactive`,
      );
      options.setLoadError(
        "Timed out waiting for notebook sync to become interactive. Reconnecting runtime...",
      );
      options.setIsLoading(false);
      options.onBootstrapTimeout?.();
    }, bootstrapTimeoutMs);
  };

  const ensureBootstrapTimeout = () => {
    if (bootstrapTimeout !== null) return;
    armBootstrapTimeout();
  };

  const resetReadiness = () => {
    if (stopped) return;
    interactiveReady = false;
    initialMaterializeDeferred = false;
    initialLoadCurrentlyStreaming = false;
    initialLoadWasStreaming = false;
    latestSessionStatus = null;
    bootstrapTimeoutFired = false;
    options.setInitialLoadReadyForMutations(false);
    armBootstrapTimeout();
  };

  const runInitialMaterialize = () => {
    if (initialMaterializeInFlight) return;

    logger.info("[automerge-notebook] Notebook interactive, materializing");
    const handle = options.getHandle();
    if (!handle) {
      initialMaterializeDeferred = false;
      options.setInitialLoadReadyForMutations(false);
      options.setIsLoading(false);
      return;
    }

    initialMaterializeInFlight = true;
    const shouldPublishInitialSlice = initialLoadWasStreaming;
    const publishInitialSlice = shouldPublishInitialSlice
      ? publishProgressiveInitialStructureSlice(handle, {
          outputCache: options.outputCache,
          progressiveStructuralBatchSize: 3,
        })
      : Promise.resolve(false);

    publishInitialSlice
      .then(() => {
        if (stopped || options.getHandle() !== handle) return;
        return options.materializeCells(handle);
      })
      .then(() => {
        initialMaterializeInFlight = false;
        if (stopped) return;
        // A daemon restart can free this handle during the await (gen1 -> gen2
        // relay reset). Bail if the live handle was replaced; the gen2
        // bootstrap drives its own initialSyncComplete materialize cycle.
        if (options.getHandle() !== handle) return;
        interactiveReady = true;
        initialMaterializeDeferred = false;
        initialLoadCurrentlyStreaming = false;
        initialLoadWasStreaming = false;
        const cellIdList = [...handle.get_cell_ids()];
        // `initialSyncComplete$` fires when the notebook doc is interactive,
        // not when RuntimeStateDoc has finished bootstrapping. Seeding the
        // outputs/executions stores from the notebook handle here preserves
        // eager output visibility until the authoritative runtime-state
        // projection lands via `executionViewChanges$` / `outputIdChanges$`.
        applyExecutionViewChangeset(
          options.projectExecutionViewChangeset(handle),
        );
        seedOutputStoresFromHandle(handle, cellIdList);
        options.setInitialLoadReadyForMutations(
          initialLoadAllowsMutations(latestSessionStatus),
        );
        options.setLoadError(null);
        options.setIsLoading(
          latestSessionStatus
            ? isInitialLoadStreaming(latestSessionStatus.initial_load)
            : false,
        );
        notifyMetadataChanged();
        logger.info("[automerge-notebook] Interactive materialization done");
      })
      .catch((err: unknown) => {
        initialMaterializeInFlight = false;
        if (stopped) return;
        logger.warn("[automerge-notebook] initial materialize failed:", err);
        options.setInitialLoadReadyForMutations(false);
        options.setLoadError(err instanceof Error ? err.message : String(err));
        options.setIsLoading(false);
      });
  };

  subscription.add(
    options.engine.sessionStatus$.subscribe((status) => {
      latestSessionStatus = status;

      if (isInitialLoadFailed(status.initial_load)) {
        clearBootstrapTimeout(true);
        logger.warn(
          "[automerge-notebook] Initial load failed:",
          status.initial_load.reason,
        );
        initialMaterializeDeferred = false;
        initialLoadCurrentlyStreaming = false;
        initialLoadWasStreaming = false;
        options.setInitialLoadReadyForMutations(false);
        options.setLoadError(status.initial_load.reason);
        options.setIsLoading(false);
        return;
      }

      const initialLoadStreaming = isInitialLoadStreaming(status.initial_load);
      if (bootstrapTimeout !== null || interactiveReady || initialLoadStreaming) {
        options.setLoadError(null);
      }
      if (initialLoadStreaming) {
        initialLoadCurrentlyStreaming = true;
        initialLoadWasStreaming = true;
        options.setInitialLoadReadyForMutations(false);
        clearBootstrapTimeout(true);
      } else if (
        !interactiveReady &&
        !initialMaterializeDeferred &&
        !initialMaterializeInFlight
      ) {
        initialLoadCurrentlyStreaming = false;
        ensureBootstrapTimeout();
      }
      options.refreshCanAcceptCellMutations();
      if (initialMaterializeDeferred && !initialLoadStreaming) {
        initialLoadCurrentlyStreaming = false;
        runInitialMaterialize();
        return;
      }
      if (interactiveReady) {
        options.setInitialLoadReadyForMutations(
          initialLoadAllowsMutations(latestSessionStatus),
        );
        options.setIsLoading(initialLoadStreaming);
      }
    }),
  );

  subscription.add(
    options.engine.initialSyncComplete$.subscribe(() => {
      clearBootstrapTimeout(true);
      if (
        latestSessionStatus &&
        isInitialLoadStreaming(latestSessionStatus.initial_load)
      ) {
        logger.info(
          "[automerge-notebook] Notebook interactive during streaming load; deferring full materialization",
        );
        initialMaterializeDeferred = true;
        return;
      }
      runInitialMaterialize();
    }),
  );

  // `concatMap` serializes the async work: if a batch awaits blob resolution,
  // subsequent batches queue rather than overlapping store writes.
  subscription.add(
    options.engine.cellChanges$
      .pipe(
        concatMap((changeset) =>
          from(
            materializeChangeset(changeset, {
              getHandle: options.getHandle,
              materializeCells: options.materializeCells,
              outputCache: options.outputCache,
              ...(initialLoadWasStreaming && !interactiveReady
                ? { progressiveStructuralBatchSize: 3 }
                : {}),
            })
              .then(() => {
                if (stopped) return;
                const handle = options.getHandle();
                if (!handle) return;
                options.refreshCanAcceptCellMutations(handle);
                applyExecutionViewChangeset(
                  options.projectExecutionViewChangeset(handle),
                );
              })
              .catch((err: unknown) => {
                if (stopped) return;
                logger.warn(
                  "[automerge-notebook] materialize changeset failed:",
                  err,
                );
              }),
          ),
        ),
      )
      .subscribe(),
  );

  subscription.add(
    options.engine.broadcasts$.subscribe((payload) => emitBroadcast(payload)),
  );
  subscription.add(
    options.engine.presence$.subscribe((payload) => emitPresence(payload)),
  );

  subscription.add(
    options.engine.runtimeState$.subscribe((state) => {
      setRuntimeState(state);
    }),
  );

  subscription.add(
    options.engine.executionViewChanges$.subscribe((changeset) => {
      applyExecutionViewChangeset(changeset);
    }),
  );

  subscription.add(
    options.engine.outputIdChanges$.subscribe(({ changed, removed_ids }) => {
      void applyOutputChangeset(changed, removed_ids).catch((err) =>
        logger.warn(
          "[automerge-notebook] output store projection failed:",
          err,
        ),
      );
    }),
  );

  subscription.add(
    options.engine.poolState$.subscribe((state) => setPoolState(state)),
  );

  armBootstrapTimeout();

  return {
    resetReadiness,
    stop() {
      stopped = true;
      clearBootstrapTimeout();
      subscription.unsubscribe();
    },
  };
}
