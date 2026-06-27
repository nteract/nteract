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

export interface NotebookSyncStoreBridgeOptions {
  engine: SyncEngineStoreStreams;
  getHandle: () => NotebookHandle | null;
  materializeCells: (handle: NotebookHandle) => Promise<void>;
  outputCache: Map<string, JupyterOutput>;
  projectExecutionViewChangeset: (
    handle: NotebookHandle,
  ) => ExecutionViewChangeset | null | undefined;
  refreshCanAcceptCellMutations: (handle?: NotebookHandle) => boolean;
  setIsLoading: (isLoading: boolean) => void;
  setLoadError: (loadError: string | null) => void;
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
  let initialLoadWasStreaming = false;
  let latestSessionStatus: SessionStatus | null = null;
  let stopped = false;
  const subscription = new Subscription();

  const resetReadiness = () => {
    interactiveReady = false;
    initialMaterializeDeferred = false;
    initialLoadWasStreaming = false;
    latestSessionStatus = null;
  };

  const runInitialMaterialize = () => {
    if (initialMaterializeInFlight) return;

    logger.info("[automerge-notebook] Notebook interactive, materializing");
    const handle = options.getHandle();
    if (!handle) {
      initialMaterializeDeferred = false;
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
        options.refreshCanAcceptCellMutations(handle);
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
        options.setLoadError(err instanceof Error ? err.message : String(err));
        options.setIsLoading(false);
      });
  };

  subscription.add(
    options.engine.sessionStatus$.subscribe((status) => {
      latestSessionStatus = status;

      if (isInitialLoadFailed(status.initial_load)) {
        logger.warn(
          "[automerge-notebook] Initial load failed:",
          status.initial_load.reason,
        );
        initialMaterializeDeferred = false;
        initialLoadWasStreaming = false;
        options.setLoadError(status.initial_load.reason);
        options.setIsLoading(false);
        return;
      }

      options.setLoadError(null);
      if (isInitialLoadStreaming(status.initial_load)) {
        initialLoadWasStreaming = true;
      }
      options.refreshCanAcceptCellMutations();
      if (
        initialMaterializeDeferred &&
        !isInitialLoadStreaming(status.initial_load)
      ) {
        runInitialMaterialize();
        return;
      }
      if (interactiveReady) {
        options.setIsLoading(isInitialLoadStreaming(status.initial_load));
      }
    }),
  );

  subscription.add(
    options.engine.initialSyncComplete$.subscribe(() => {
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

  return {
    resetReadiness,
    stop() {
      stopped = true;
      subscription.unsubscribe();
    },
  };
}
