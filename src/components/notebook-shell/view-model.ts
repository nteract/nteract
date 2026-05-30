import type { JupyterOutput } from "@/components/cell/jupyter-output";
import type { ReadOnlyNotebookCellData } from "@/components/cell/ReadOnlyNotebook";
import type { SupportedLanguage } from "@/components/editor/languages";
import { projectNotebookOutline, type NotebookOutlineItem } from "runtimed";

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

export interface NotebookViewModel {
  cells: readonly NotebookViewCell[];
  cellIds: string[];
  readOnlyCells: ReadOnlyNotebookCellData[];
  outlineItems: NotebookOutlineItem[];
  codeCellCount: number;
}

export interface CreateNotebookViewModelOptions {
  resolveLanguage: NotebookViewLanguageResolver;
}

export function createNotebookViewModel(
  cells: readonly NotebookViewCell[],
  options: CreateNotebookViewModelOptions,
): NotebookViewModel {
  return {
    cells,
    cellIds: cells.map((cell) => cell.id),
    readOnlyCells: notebookViewCellsToReadOnlyCells(cells, options.resolveLanguage),
    outlineItems: notebookViewCellsToOutlineItems(cells),
    codeCellCount: cells.filter((cell) => cell.cellType === "code").length,
  };
}

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

export function notebookViewCellsToOutlineItems(
  cells: readonly NotebookViewCell[],
): NotebookOutlineItem[] {
  return projectNotebookOutline(cells, {
    hrefTarget: "heading",
    getStatusLabel: notebookViewCellOutlineStatusLabel,
  }).items;
}

function notebookViewCellOutlineStatusLabel(cell: NotebookViewCell): string | null {
  if (cell.cellType === "code" && cell.executionCount !== null) {
    return `In [${cell.executionCount}]`;
  }
  return null;
}
