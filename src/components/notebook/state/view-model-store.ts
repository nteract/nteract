import { useMemo } from "react";
import {
  createNotebookViewModel,
  type CreateNotebookViewModelOptions,
  type NotebookViewCell,
  type NotebookViewModel,
} from "../view-model";
import {
  getNotebookCellsSnapshot,
  useCellIds,
  useMaterializeVersion,
  type NotebookStoreCell,
} from "./cell-store";

export function useNotebookViewModel<TCell extends NotebookViewCell = NotebookViewCell>(
  options: CreateNotebookViewModelOptions = {},
): NotebookViewModel<TCell> {
  const cellIds = useCellIds();
  const materializeVersion = useMaterializeVersion();
  const { getOutlineStatusLabel, metadata, resolveLanguage } = options;

  return useMemo(() => {
    void cellIds;
    void materializeVersion;
    return createNotebookViewModelFromNotebookCells({
      getOutlineStatusLabel,
      metadata,
      resolveLanguage,
    }) as NotebookViewModel<TCell>;
  }, [cellIds, getOutlineStatusLabel, materializeVersion, metadata, resolveLanguage]);
}

export function createNotebookViewModelFromNotebookCells(
  options: CreateNotebookViewModelOptions = {},
): NotebookViewModel {
  return createNotebookViewModel(getNotebookCellsSnapshot().map(notebookCellToViewCell), options);
}

export function notebookCellToViewCell(cell: NotebookStoreCell): NotebookViewCell {
  return {
    id: cell.id,
    cellType: cell.cell_type,
    source: cell.source,
    language: cell.cell_type === "code" ? notebookCellLanguage(cell.metadata) : null,
    executionId: null,
    executionCount: cell.cell_type === "code" ? cell.execution_count : null,
    outputs: cell.cell_type === "code" ? cell.outputs : [],
    metadata: cell.metadata,
  };
}

function notebookCellLanguage(metadata: Record<string, unknown>): string | null {
  const language = metadata.language;
  return typeof language === "string" ? language : null;
}
