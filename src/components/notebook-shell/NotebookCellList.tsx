import type { CSSProperties, ReactNode } from "react";
import { ErrorBoundary } from "@/lib/error-boundary";
import { cn } from "@/lib/utils";
import type { NotebookCellListItem } from "./cell-data";

export interface NotebookCellListProps<TCell extends NotebookCellListItem = NotebookCellListItem> {
  cells: readonly TCell[];
  label?: string;
  className?: string;
  slot?: string;
  scrollable?: boolean;
  emptyContent?: ReactNode;
  stableDomOrder?: boolean;
  keyForCell?: (cell: TCell, index: number) => string;
  resetKeysForCell?: (cell: TCell, index: number) => readonly unknown[];
  renderCell: (cell: TCell, index: number) => ReactNode;
  renderCellError?: (error: Error, cell: TCell, index: number) => ReactNode;
}

export function NotebookCellList<TCell extends NotebookCellListItem = NotebookCellListItem>({
  cells,
  label = "Notebook cells",
  className,
  slot = "notebook-cell-list",
  scrollable = false,
  emptyContent = null,
  stableDomOrder = false,
  keyForCell = defaultKeyForCell,
  resetKeysForCell = defaultResetKeysForCell,
  renderCell,
  renderCellError,
}: NotebookCellListProps<TCell>) {
  return (
    <section
      aria-label={label}
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-x-clip overscroll-x-contain",
        scrollable && "overflow-y-auto overscroll-contain scroll-smooth",
        className,
      )}
      data-cell-count={cells.length}
      data-slot={slot}
    >
      {cells.length === 0
        ? emptyContent
        : notebookCellListEntries(cells, keyForCell, stableDomOrder).map(({ cell, index, key }) =>
            stableDomOrder ? (
              <div
                key={key}
                data-slot="notebook-cell-list-item"
                style={cellListItemOrderStyle(index)}
              >
                <ErrorBoundary
                  resetKeys={resetKeysForCell(cell, index)}
                  fallback={(error) =>
                    renderCellError
                      ? renderCellError(error, cell, index)
                      : defaultCellError(error, index)
                  }
                >
                  {renderCell(cell, index)}
                </ErrorBoundary>
              </div>
            ) : (
              <ErrorBoundary
                key={key}
                resetKeys={resetKeysForCell(cell, index)}
                fallback={(error) =>
                  renderCellError
                    ? renderCellError(error, cell, index)
                    : defaultCellError(error, index)
                }
              >
                {renderCell(cell, index)}
              </ErrorBoundary>
            ),
          )}
    </section>
  );
}

interface NotebookCellListEntry<TCell extends NotebookCellListItem> {
  cell: TCell;
  index: number;
  key: string;
}

function notebookCellListEntries<TCell extends NotebookCellListItem>(
  cells: readonly TCell[],
  keyForCell: (cell: TCell, index: number) => string,
  stableDomOrder: boolean,
): Array<NotebookCellListEntry<TCell>> {
  const entries = cells.map((cell, index) => ({
    cell,
    index,
    key: keyForCell(cell, index),
  }));
  if (!stableDomOrder) {
    return entries;
  }
  return [...entries].sort((a, b) => a.cell.id.localeCompare(b.cell.id) || a.index - b.index);
}

function cellListItemOrderStyle(index: number): CSSProperties {
  return { order: index };
}

function defaultKeyForCell(cell: NotebookCellListItem): string {
  return cell.id;
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
