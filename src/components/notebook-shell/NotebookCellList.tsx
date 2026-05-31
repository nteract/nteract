import type { ReactNode } from "react";
import { ErrorBoundary } from "@/lib/error-boundary";
import { cn } from "@/lib/utils";

export interface NotebookCellListItem {
  id: string;
  cellType: string;
  source: string;
  language?: string | null;
  executionCount?: number | null;
  outputs?: readonly unknown[];
}

export interface NotebookCellListProps<TCell extends NotebookCellListItem = NotebookCellListItem> {
  cells: readonly TCell[];
  label?: string;
  className?: string;
  slot?: string;
  emptyContent?: ReactNode;
  resetKeysForCell?: (cell: TCell, index: number) => readonly unknown[];
  renderCell: (cell: TCell, index: number) => ReactNode;
  renderCellError?: (error: Error, cell: TCell, index: number) => ReactNode;
}

export function NotebookCellList<TCell extends NotebookCellListItem = NotebookCellListItem>({
  cells,
  label = "Notebook cells",
  className,
  slot = "notebook-cell-list",
  emptyContent = null,
  resetKeysForCell = defaultResetKeysForCell,
  renderCell,
  renderCellError,
}: NotebookCellListProps<TCell>) {
  return (
    <section
      aria-label={label}
      className={cn("flex min-h-0 flex-1 flex-col overflow-x-clip overscroll-x-contain", className)}
      data-cell-count={cells.length}
      data-slot={slot}
    >
      {cells.length === 0
        ? emptyContent
        : cells.map((cell, index) => (
            <ErrorBoundary
              key={cell.id}
              resetKeys={resetKeysForCell(cell, index)}
              fallback={(error) =>
                renderCellError
                  ? renderCellError(error, cell, index)
                  : defaultCellError(error, index)
              }
            >
              {renderCell(cell, index)}
            </ErrorBoundary>
          ))}
    </section>
  );
}

function defaultResetKeysForCell(cell: NotebookCellListItem): readonly unknown[] {
  return [
    cell.id,
    cell.cellType,
    cell.source,
    cell.language,
    cell.executionCount,
    cell.outputs?.length ?? 0,
  ];
}

function defaultCellError(error: Error, index: number) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      Unable to render cell {index + 1}: {error.message}
    </div>
  );
}
