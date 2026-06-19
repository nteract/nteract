import type { ExecutionViewChangeset, SessionStatus, SyncEngine } from "runtimed";
import { isInitialLoadFailed, isInitialLoadStreaming } from "runtimed";
import { concatMap, from, Subscription } from "rxjs";
import type { JupyterOutput } from "../types";
import type { NotebookHandle } from "../wasm/runtimed-wasm/runtimed_wasm.js";
import { materializeChangeset } from "./frame-pipeline";
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
  let latestSessionStatus: SessionStatus | null = null;
  let stopped = false;
  const subscription = new Subscription();

  const resetReadiness = () => {
    interactiveReady = false;
    latestSessionStatus = null;
  };

  subscription.add(
    options.engine.sessionStatus$.subscribe((status) => {
      latestSessionStatus = status;

      if (isInitialLoadFailed(status.initial_load)) {
        logger.warn("[automerge-notebook] Initial load failed:", status.initial_load.reason);
        options.setLoadError(status.initial_load.reason);
        options.setIsLoading(false);
        return;
      }

      options.setLoadError(null);
      options.refreshCanAcceptCellMutations();
      if (interactiveReady) {
        options.setIsLoading(isInitialLoadStreaming(status.initial_load));
      }
    }),
  );

  subscription.add(
    options.engine.initialSyncComplete$.subscribe(() => {
      logger.info("[automerge-notebook] Notebook interactive, materializing");
      const handle = options.getHandle();
      if (!handle) {
        options.setIsLoading(false);
        return;
      }

      options
        .materializeCells(handle)
        .then(() => {
          if (stopped) return;
          // A daemon restart can free this handle during the await (gen1 -> gen2
          // relay reset). Bail if the live handle was replaced; the gen2
          // bootstrap drives its own initialSyncComplete materialize cycle.
          if (options.getHandle() !== handle) return;
          interactiveReady = true;
          const cellIdList = [...handle.get_cell_ids()];
          // `initialSyncComplete$` fires when the notebook doc is interactive,
          // not when RuntimeStateDoc has finished bootstrapping. Seeding the
          // outputs/executions stores from the notebook handle here preserves
          // eager output visibility until the authoritative runtime-state
          // projection lands via `executionViewChanges$` / `outputIdChanges$`.
          applyExecutionViewChangeset(options.projectExecutionViewChangeset(handle));
          seedOutputStoresFromHandle(handle, cellIdList);
          options.refreshCanAcceptCellMutations(handle);
          options.setIsLoading(
            latestSessionStatus ? isInitialLoadStreaming(latestSessionStatus.initial_load) : false,
          );
          notifyMetadataChanged();
          logger.info("[automerge-notebook] Interactive materialization done");
        })
        .catch((err: unknown) => {
          if (stopped) return;
          logger.warn("[automerge-notebook] initial materialize failed:", err);
          options.setLoadError(err instanceof Error ? err.message : String(err));
          options.setIsLoading(false);
        });
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
            })
              .then(() => {
                if (stopped) return;
                const handle = options.getHandle();
                if (!handle) return;
                options.refreshCanAcceptCellMutations(handle);
                applyExecutionViewChangeset(options.projectExecutionViewChangeset(handle));
              })
              .catch((err: unknown) => {
                if (stopped) return;
                logger.warn("[automerge-notebook] materialize changeset failed:", err);
              }),
          ),
        ),
      )
      .subscribe(),
  );

  subscription.add(options.engine.broadcasts$.subscribe((payload) => emitBroadcast(payload)));
  subscription.add(options.engine.presence$.subscribe((payload) => emitPresence(payload)));

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
        logger.warn("[automerge-notebook] output store projection failed:", err),
      );
    }),
  );

  subscription.add(options.engine.poolState$.subscribe((state) => setPoolState(state)));

  return {
    resetReadiness,
    stop() {
      stopped = true;
      subscription.unsubscribe();
    },
  };
}
