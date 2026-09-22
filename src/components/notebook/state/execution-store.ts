import { useMemo, useSyncExternalStore } from "react";
import {
  createNotebookExecutionStore,
  type ExecutionSnapshot,
  type NotebookQueueProjectionSnapshot,
} from "runtimed";
export type { ExecutionSnapshot, NotebookQueueProjectionSnapshot } from "runtimed";

/** The frontend owns one default instance; headless hosts own their own. */
export const notebookExecutionStore = createNotebookExecutionStore();
export const {
  subscribeNotebookQueueProjection,
  getNotebookQueueProjection,
  setExecution,
  markExecutionsRuntimeOwned,
  isExecutionRuntimeOwned,
  setCellExecutionPointer,
  setNotebookQueueProjection,
  deleteExecutions,
  getExecutionById,
  getCellExecutionId,
  getCellIdForExecutionId,
  resetNotebookExecutions,
} = notebookExecutionStore;
const {
  subscribeExecutionById,
  getExecutionSnapshotGetter,
  subscribeCellExecutionPointer,
  getCellExecutionIdGetter,
  subscribeExecutionStructureVersion,
  getExecutionStructureVersionSnapshot,
} = notebookExecutionStore;

// ── Hooks ───────────────────────────────────────────────────────────────

/** Subscribe to a single execution by id. Re-renders only when it changes. */
export function useExecution(execution_id: string | null): ExecutionSnapshot | undefined {
  const id = execution_id ?? "";
  const subscribe = useMemo(() => subscribeExecutionById(id), [id]);
  const getSnapshot = useMemo(() => getExecutionSnapshotGetter(id), [id]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Subscribe to the `execution_id` pointer for a cell.
 *
 * Re-renders when the cell transitions from one execution to the next
 * (e.g. fresh run). Useful for `<CellLabel>` / prompt components that need
 * to chain `useCellExecutionId(cellId)` → `useExecution(execution_id)`.
 */
export function useCellExecutionId(cell_id: string): string | null {
  const subscribe = useMemo(() => subscribeCellExecutionPointer(cell_id), [cell_id]);
  const getSnapshot = useMemo(() => getCellExecutionIdGetter(cell_id), [cell_id]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useNotebookQueueProjection(): NotebookQueueProjectionSnapshot {
  return useSyncExternalStore(subscribeNotebookQueueProjection, getNotebookQueueProjection);
}

/**
 * Subscribe to execution facts that cross-cell derived views consume:
 * execution counts, cell execution pointers, and output-id membership.
 * Status-only changes stay on the per-execution path.
 */
export function useExecutionStructureVersion(): number {
  return useSyncExternalStore(
    subscribeExecutionStructureVersion,
    getExecutionStructureVersionSnapshot,
  );
}
