import { useCallback } from "react";
import { useNotebookQueueProjection } from "./state/execution-store";

/**
 * Returns a function that derives outline status labels from execution state.
 * Used by useNotebookViewModel to annotate outline items with run status.
 *
 * @returns Status label function for outline items
 */
export function useOutlineStatusLabel(): (cell: {
  id: string;
  cellType: string;
  executionCount: number | null;
}) => string | null {
  const notebookQueueProjection = useNotebookQueueProjection();

  return useCallback(
    (cell: { id: string; cellType: string; executionCount: number | null }) => {
      if (cell.id === notebookQueueProjection.executing_cell_id) return "running";
      if (notebookQueueProjection.queued_cell_ids.includes(cell.id)) return "queued";
      if (cell.cellType === "code" && cell.executionCount !== null) {
        return `run ${cell.executionCount}`;
      }
      return null;
    },
    [notebookQueueProjection.executing_cell_id, notebookQueueProjection.queued_cell_ids],
  );
}
