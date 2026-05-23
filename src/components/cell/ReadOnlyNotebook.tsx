import type { ReactNode } from "react";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import { ErrorBoundary } from "@/lib/error-boundary";
import { cn } from "@/lib/utils";
import type { SupportedLanguage } from "../editor/languages";
import type { JupyterOutput } from "./jupyter-output";
import { ReadOnlyNotebookCell } from "./ReadOnlyNotebookCell";

export interface ReadOnlyNotebookCellData {
  id: string;
  cellType: string;
  source: string;
  language?: SupportedLanguage | null;
  outputs?: readonly JupyterOutput[];
  executionCount?: number | null;
}

export interface ReadOnlyNotebookProps {
  cells: readonly ReadOnlyNotebookCellData[];
  priority?: readonly string[];
  hostContext?: NteractEmbedHostContextPatch;
  className?: string;
  cellClassName?: string;
  sourceClassName?: string;
  outputClassName?: string;
  lineWrapping?: boolean;
  label?: string;
  emptyContent?: ReactNode;
  renderCellError?: (error: Error, cell: ReadOnlyNotebookCellData, index: number) => ReactNode;
}

export function ReadOnlyNotebook({
  cells,
  priority,
  hostContext,
  className,
  cellClassName,
  sourceClassName,
  outputClassName,
  lineWrapping = true,
  label = "Notebook cells",
  emptyContent = null,
  renderCellError,
}: ReadOnlyNotebookProps) {
  return (
    <section
      aria-label={label}
      className={cn("flex min-h-0 flex-1 flex-col overflow-x-clip overscroll-x-contain", className)}
      data-cell-count={cells.length}
      data-slot="read-only-notebook"
    >
      {cells.length === 0
        ? emptyContent
        : cells.map((cell, index) => (
            <ErrorBoundary
              key={`${cell.id}:${index}`}
              resetKeys={[
                cell.id,
                cell.cellType,
                cell.source,
                cell.language,
                cell.executionCount,
                cell.outputs?.length ?? 0,
              ]}
              fallback={(error) =>
                renderCellError
                  ? renderCellError(error, cell, index)
                  : defaultCellError(error, index)
              }
            >
              <ReadOnlyNotebookCell
                id={cell.id}
                cellType={cell.cellType}
                source={cell.source}
                language={cell.language}
                outputs={cell.outputs}
                executionCount={cell.executionCount}
                priority={priority}
                hostContext={hostContext}
                className={cellClassName}
                sourceClassName={sourceClassName}
                outputClassName={outputClassName}
                lineWrapping={lineWrapping}
              />
            </ErrorBoundary>
          ))}
    </section>
  );
}

function defaultCellError(error: Error, index: number) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      Unable to render cell {index + 1}: {error.message}
    </div>
  );
}
