import { useMemo } from "react";
import {
  createNotebookViewModel,
  type CreateNotebookViewModelOptions,
  type NotebookViewCell,
  type NotebookViewModel,
} from "../view-model";
import {
  getCellExecutionId,
  getExecutionById,
  useExecutionStructureVersion,
} from "./execution-store";
import { getCellOutputsSnapshot, useOutputStructureVersion } from "./output-store";
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
  const executionStructureVersion = useExecutionStructureVersion();
  const outputStructureVersion = useOutputStructureVersion();
  const { getOutlineStatusLabel, includeDocumentAnchors, metadata, resolveLanguage } = options;

  return useMemo(() => {
    void cellIds;
    void materializeVersion;
    void executionStructureVersion;
    void outputStructureVersion;
    return createNotebookViewModelFromNotebookCells({
      getOutlineStatusLabel,
      includeDocumentAnchors,
      metadata,
      resolveLanguage,
    }) as NotebookViewModel<TCell>;
  }, [
    cellIds,
    executionStructureVersion,
    getOutlineStatusLabel,
    includeDocumentAnchors,
    materializeVersion,
    metadata,
    outputStructureVersion,
    resolveLanguage,
  ]);
}

export function createNotebookViewModelFromNotebookCells(
  options: CreateNotebookViewModelOptions = {},
): NotebookViewModel {
  return createNotebookViewModel(getNotebookCellsSnapshot().map(notebookCellToViewCell), options);
}

export function notebookCellToViewCell(cell: NotebookStoreCell): NotebookViewCell {
  const executionId = cell.cell_type === "code" ? getCellExecutionId(cell.id) : null;
  const execution = executionId ? getExecutionById(executionId) : undefined;
  const outputs = cell.cell_type === "code" ? getCellOutputsSnapshot(cell.id) : [];

  return {
    id: cell.id,
    cellType: cell.cell_type,
    source: cell.source,
    language: cell.cell_type === "code" ? notebookCellLanguage(cell.metadata) : null,
    executionId,
    executionCount:
      cell.cell_type === "code" ? (execution?.execution_count ?? cell.execution_count) : null,
    outputs,
    metadata: cell.metadata,
    markdownProjection: cell.cell_type === "markdown" ? cell.markdownProjection : undefined,
  };
}

function notebookCellLanguage(metadata: Record<string, unknown>): string | null {
  const language = metadata.language;
  return typeof language === "string" ? language : null;
}
