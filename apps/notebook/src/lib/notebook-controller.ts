import type { SyncEngine } from "runtimed";
import { logger } from "./logger";
import { getNotebookCellsSnapshot, updateCellById } from "./notebook-cells";
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
  move_cell(cellId: string, afterCellId: string | null): void;
  cell_count(): number;
  delete_cell(cellId: string): boolean;
  clear_outputs(cellId: string): boolean;
  set_cell_source_hidden(cellId: string, hidden: boolean): boolean;
  set_cell_outputs_hidden(cellId: string, hidden: boolean): boolean;
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
  createCellId = () => crypto.randomUUID(),
  syncMode = {},
  afterMutation,
  refreshCanAcceptCellMutations,
  onFocusCell,
  fallbackCell = defaultFallbackCell,
  logPrefix = "[notebook-controller]",
}: NotebookControllerOptions<THandle>): NotebookController {
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

  const commit = (
    kind: NotebookControllerMutationKind,
    canWrite: () => boolean,
    mutate: (handle: THandle) => boolean,
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
    if (!mutate(handle)) return false;

    afterMutation?.(handle, kind);
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

      updateCellById(cellId, (cell) => ({ ...cell, source }));
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
      try {
        handle.add_cell_after(cellId, cellType, afterCellId);
      } catch (error) {
        logger.warn(`${logPrefix} addCell failed:`, error);
        refreshCanAcceptCellMutations?.(handle);
        return null;
      }

      afterMutation?.(handle, "structure");
      syncAfterMutation(engine, "structure");
      onFocusCell?.(cellId);

      return getNotebookCellsSnapshot().find((cell) => cell.id === cellId) ?? fallbackCell(cellId, cellType);
    },

    moveCell(cellId, afterCellId = null) {
      commit("structure", canEditStructure, (handle) => {
        handle.move_cell(cellId, afterCellId);
        return true;
      });
    },

    deleteCell(cellId) {
      commit("structure", canEditStructure, (handle) => {
        if (handle.cell_count() <= 1) return false;
        return !!handle.delete_cell(cellId);
      });
    },

    clearOutputs(cellIds) {
      const ids = Array.isArray(cellIds) ? cellIds : [cellIds];
      if (ids.length === 0) return false;

      return commit("outputs", canEditOutputs, (handle) => {
        let changed = false;
        for (const cellId of ids) {
          changed = !!handle.clear_outputs(cellId) || changed;
        }
        return changed;
      });
    },

    setCellSourceHidden(cellId, hidden) {
      commit("visibility", canEditVisibility, (handle) => {
        return !!handle.set_cell_source_hidden(cellId, hidden);
      });
    },

    setCellOutputsHidden(cellId, hidden) {
      commit("visibility", canEditVisibility, (handle) => {
        return !!handle.set_cell_outputs_hidden(cellId, hidden);
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
