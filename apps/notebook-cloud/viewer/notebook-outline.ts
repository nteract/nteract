import { projectNotebookOutline, type NotebookOutlineItem } from "runtimed";

export interface CloudNotebookOutlineCell {
  id: string;
  cellType: string;
  source: string;
  executionCount?: number | null;
}

export function deriveCloudNotebookOutlineItems(
  cells: readonly CloudNotebookOutlineCell[],
): NotebookOutlineItem[] {
  return projectNotebookOutline(cells, {
    getStatusLabel: (cell) => {
      if (
        cell.cellType === "code" &&
        cell.executionCount !== null &&
        cell.executionCount !== undefined
      ) {
        return `In [${cell.executionCount}]`;
      }
      return null;
    },
  }).items;
}
