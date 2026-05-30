import type { JupyterOutput } from "@/components/cell/jupyter-output";
import type { ReadOnlyNotebookCellData } from "@/components/cell/ReadOnlyNotebook";
import type { SupportedLanguage } from "@/components/editor/languages";

export type NotebookViewCellType = "code" | "markdown" | "raw";

export interface NotebookViewCell {
  id: string;
  cellType: NotebookViewCellType;
  source: string;
  language: string | null;
  executionId: string | null;
  executionCount: number | null;
  outputs: JupyterOutput[];
  metadata: Record<string, unknown>;
}

export type NotebookViewLanguageResolver = (
  language: string | null | undefined,
) => SupportedLanguage | null;

export function notebookViewCellsToReadOnlyCells(
  cells: readonly NotebookViewCell[],
  resolveLanguage: NotebookViewLanguageResolver,
): ReadOnlyNotebookCellData[] {
  return cells.map((cell) => notebookViewCellToReadOnlyCell(cell, resolveLanguage));
}

export function notebookViewCellToReadOnlyCell(
  cell: NotebookViewCell,
  resolveLanguage: NotebookViewLanguageResolver,
): ReadOnlyNotebookCellData {
  return {
    id: cell.id,
    cellType: cell.cellType,
    source: cell.source,
    language: resolveLanguage(cell.language),
    outputs: cell.outputs,
    executionId: cell.executionId,
    executionCount: cell.executionCount,
  };
}
