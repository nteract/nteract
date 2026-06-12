import type { LocalMutationResult, SyncEngine } from "runtimed";
import { logger } from "./logger";
import { createNotebookCellId } from "./notebook-cell-id";
import { getNotebookCellsSnapshot, updateCellSourceById } from "./notebook-cells";
import type { NotebookCell } from "../types";

export type NotebookControllerCellType = "code" | "markdown" | "raw";
export type NotebookControllerMutationKind =
  | "source"
  | "structure"
  | "outputs"
  | "visibility";
export type NotebookControllerSyncMode = "flush" | "scheduleFlush";

export interface NotebookControllerHandle {
  update_source(cellId: string, source: string): boolean;
  add_cell_after(cellId: string, cellType: NotebookControllerCellType, afterCellId: string | null): void;
  add_cell_after_with_changeset?(
    cellId: string,
    cellType: NotebookControllerCellType,
    afterCellId: string | null,
  ): LocalMutationResult<string>;
  move_cell(cellId: string, afterCellId: string | null): void;
  move_cell_with_changeset?(
    cellId: string,
    afterCellId: string | null,
  ): LocalMutationResult<string>;
  cell_count(): number;
  delete_cell(cellId: string): boolean;
  delete_cell_with_changeset?(cellId: string): LocalMutationResult<boolean>;
  clear_outputs(cellId: string): boolean;
  clear_outputs_with_changeset?(cellId: string): LocalMutationResult<boolean>;
  set_cell_source_hidden(cellId: string, hidden: boolean): boolean;
  set_cell_source_hidden_with_changeset?(
    cellId: string,
    hidden: boolean,
  ): LocalMutationResult<boolean>;
  set_cell_outputs_hidden(cellId: string, hidden: boolean): boolean;
  set_cell_outputs_hidden_with_changeset?(
    cellId: string,
    hidden: boolean,
  ): LocalMutationResult<boolean>;
  has_cells_map?(): boolean;
}

export interface NotebookControllerOptions<THandle extends NotebookControllerHandle> {
  getHandle: () => THandle | null;
  getEngine: () => Pick<SyncEngine, "flush" | "scheduleFlush"> | null;
  canWriteCellSource: (cellId: string) => boolean;
  canEditStructure: () => boolean;
  canEditOutputs?: () => boolean;
  canEditVisibility?: () => boolean;
  canAcceptStructure?: (handle: THandle) => boolean;
  createCellId?: () => string;
  syncMode?: Partial<Record<NotebookControllerMutationKind, NotebookControllerSyncMode>>;
  applyMutationEvent?: (event: unknown) => boolean;
  afterMutation?: (handle: THandle, kind: NotebookControllerMutationKind) => void;
  refreshCanAcceptCellMutations?: (handle?: THandle) => void;
  onFocusCell?: (cellId: string) => void;
  fallbackCell?: (
    cellId: string,
    cellType: NotebookControllerCellType,
  ) => NotebookCell | null;
  logPrefix?: string;
}

export interface NotebookController {
  updateCellSource: (cellId: string, source: string) => void;
  addCell: (
    cellType: NotebookControllerCellType,
    afterCellId?: string | null,
  ) => NotebookCell | null;
  moveCell: (cellId: string, afterCellId?: string | null) => void;
  deleteCell: (cellId: string) => void;
  clearOutputs: (cellIds: string | string[]) => boolean;
  setCellSourceHidden: (cellId: string, hidden: boolean) => void;
  setCellOutputsHidden: (cellId: string, hidden: boolean) => void;
}

export function createNotebookController<THandle extends NotebookControllerHandle>({
  getHandle,
  getEngine,
  canWriteCellSource,
  canEditStructure,
  canEditOutputs = canEditStructure,
  canEditVisibility = canEditStructure,
  canAcceptStructure = (handle) => handle.has_cells_map?.() ?? true,
  createCellId = createNotebookCellId,
  syncMode = {},
  applyMutationEvent,
  afterMutation,
  refreshCanAcceptCellMutations,
  onFocusCell,
  fallbackCell = defaultFallbackCell,
  logPrefix = "[notebook-controller]",
}: NotebookControllerOptions<THandle>): NotebookController {
  type MutationOutcome = {
    changed: boolean;
    eventApplied: boolean;
  };

  const syncAfterMutation = (
    engine: Pick<SyncEngine, "flush" | "scheduleFlush">,
    kind: NotebookControllerMutationKind,
  ) => {
    const mode = syncMode[kind] ?? (kind === "source" ? "scheduleFlush" : "flush");
    if (mode === "scheduleFlush") {
      engine.scheduleFlush();
      return;
    }
    engine.flush();
  };

  const localMutationOutcome = <T>(
    mutation: LocalMutationResult<T>,
    isChanged: (result: T) => boolean,
  ): MutationOutcome => {
    const changed = isChanged(mutation.result);
    if (!changed) return { changed: false, eventApplied: false };
    const eventApplied =
      mutation.event !== undefined && applyMutationEvent?.(mutation.event) === true;
    return { changed: true, eventApplied };
  };

  const commit = (
    kind: NotebookControllerMutationKind,
    canWrite: () => boolean,
    mutate: (handle: THandle) => MutationOutcome,
  ): boolean => {
    const handle = getHandle();
    const engine = getEngine();
    if (!handle || !engine) {
      logger.debug(`${logPrefix} ${kind} mutation skipped: no handle/engine`);
      return false;
    }
    if (!canWrite()) {
      logger.debug(`${logPrefix} ${kind} mutation skipped: capability denied`);
      return false;
    }
    const outcome = mutate(handle);
    if (!outcome.changed) return false;

    if (!outcome.eventApplied) {
      afterMutation?.(handle, kind);
    }
    syncAfterMutation(engine, kind);
    return true;
  };

  return {
    updateCellSource(cellId, source) {
      const handle = getHandle();
      const engine = getEngine();
      if (!handle || !engine) return;
      if (!canWriteCellSource(cellId)) {
        logger.debug(`${logPrefix} updateCellSource skipped: capability denied`);
        return;
      }

      const updated = handle.update_source(cellId, source);
      if (!updated) return;

      updateCellSourceById(cellId, source);
      afterMutation?.(handle, "source");
      syncAfterMutation(engine, "source");
    },

    addCell(cellType, afterCellId = null) {
      const handle = getHandle();
      const engine = getEngine();
      if (!handle || !engine) {
        logger.debug(`${logPrefix} addCell skipped: no handle/engine`);
        return null;
      }
      if (!canEditStructure()) {
        logger.debug(`${logPrefix} addCell skipped: capability denied`);
        return null;
      }
      if (!canAcceptStructure(handle)) {
        logger.debug(`${logPrefix} addCell skipped: cells map not synced yet`);
        refreshCanAcceptCellMutations?.(handle);
        return null;
      }

      const cellId = createCellId();
      let eventApplied = false;
      try {
        if (handle.add_cell_after_with_changeset && applyMutationEvent) {
          const mutation = handle.add_cell_after_with_changeset(cellId, cellType, afterCellId);
          eventApplied =
            mutation.event !== undefined && applyMutationEvent(mutation.event) === true;
        } else {
          handle.add_cell_after(cellId, cellType, afterCellId);
        }
      } catch (error) {
        logger.warn(`${logPrefix} addCell failed:`, error);
        refreshCanAcceptCellMutations?.(handle);
        return null;
      }

      if (!eventApplied) {
        afterMutation?.(handle, "structure");
      }
      syncAfterMutation(engine, "structure");
      onFocusCell?.(cellId);

      return getNotebookCellsSnapshot().find((cell) => cell.id === cellId) ?? fallbackCell(cellId, cellType);
    },

    moveCell(cellId, afterCellId = null) {
      commit("structure", canEditStructure, (handle) => {
        if (handle.move_cell_with_changeset && applyMutationEvent) {
          return localMutationOutcome(
            handle.move_cell_with_changeset(cellId, afterCellId),
            () => true,
          );
        }
        handle.move_cell(cellId, afterCellId);
        return { changed: true, eventApplied: false };
      });
    },

    deleteCell(cellId) {
      commit("structure", canEditStructure, (handle) => {
        if (handle.cell_count() <= 1) return { changed: false, eventApplied: false };
        if (handle.delete_cell_with_changeset && applyMutationEvent) {
          return localMutationOutcome(handle.delete_cell_with_changeset(cellId), Boolean);
        }
        return { changed: !!handle.delete_cell(cellId), eventApplied: false };
      });
    },

    clearOutputs(cellIds) {
      const ids = Array.isArray(cellIds) ? cellIds : [cellIds];
      if (ids.length === 0) return false;

      return commit("outputs", canEditOutputs, (handle) => {
        let changed = false;
        let eventApplied = true;
        for (const cellId of ids) {
          if (handle.clear_outputs_with_changeset && applyMutationEvent) {
            const outcome = localMutationOutcome(
              handle.clear_outputs_with_changeset(cellId),
              Boolean,
            );
            if (outcome.changed) {
              changed = true;
              eventApplied = eventApplied && outcome.eventApplied;
            }
            continue;
          }

          const cellChanged = !!handle.clear_outputs(cellId);
          changed = cellChanged || changed;
          if (cellChanged) eventApplied = false;
        }
        return { changed, eventApplied: changed && eventApplied };
      });
    },

    setCellSourceHidden(cellId, hidden) {
      commit("visibility", canEditVisibility, (handle) => {
        if (handle.set_cell_source_hidden_with_changeset && applyMutationEvent) {
          return localMutationOutcome(
            handle.set_cell_source_hidden_with_changeset(cellId, hidden),
            Boolean,
          );
        }
        return { changed: !!handle.set_cell_source_hidden(cellId, hidden), eventApplied: false };
      });
    },

    setCellOutputsHidden(cellId, hidden) {
      commit("visibility", canEditVisibility, (handle) => {
        if (handle.set_cell_outputs_hidden_with_changeset && applyMutationEvent) {
          return localMutationOutcome(
            handle.set_cell_outputs_hidden_with_changeset(cellId, hidden),
            Boolean,
          );
        }
        return { changed: !!handle.set_cell_outputs_hidden(cellId, hidden), eventApplied: false };
      });
    },
  };
}

function defaultFallbackCell(
  cellId: string,
  cellType: NotebookControllerCellType,
): NotebookCell | null {
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
}
