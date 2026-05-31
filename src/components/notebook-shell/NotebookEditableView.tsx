import type { ReactNode } from "react";
import { NotebookCellList } from "./NotebookCellList";
import type { NotebookViewCell, NotebookViewModel } from "./view-model";

export interface NotebookEditableViewProps<TCell extends NotebookViewCell = NotebookViewCell> {
  viewModel: Pick<NotebookViewModel<TCell>, "cells">;
  className?: string;
  slot?: string;
  renderMarkdownCell: (cell: TCell, index: number) => ReactNode;
  renderCodeCell: (cell: TCell, index: number) => ReactNode;
  renderFallbackCell: (cell: TCell, index: number) => ReactNode;
  renderCellError?: (error: Error, cell: TCell, index: number) => ReactNode;
}

export function NotebookEditableView<TCell extends NotebookViewCell = NotebookViewCell>({
  viewModel,
  className,
  slot = "notebook-editable-view",
  renderMarkdownCell,
  renderCodeCell,
  renderFallbackCell,
  renderCellError,
}: NotebookEditableViewProps<TCell>) {
  return (
    <NotebookCellList
      cells={viewModel.cells}
      className={className}
      slot={slot}
      renderCellError={renderCellError}
      renderCell={(cell, index) => {
        if (cell.cellType === "markdown") {
          return renderMarkdownCell(cell, index);
        }
        if (cell.cellType === "code") {
          return renderCodeCell(cell, index);
        }
        return renderFallbackCell(cell, index);
      }}
    />
  );
}
