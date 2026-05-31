import type { ReactNode } from "react";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import type { ReadOnlyNotebookCellData } from "@/components/notebook-shell/cell-data";
import { NotebookCellList } from "@/components/notebook-shell/NotebookCellList";
import type {
  TracebackCellNavigator,
  TracebackExecutionResolver,
} from "@/components/outputs/traceback-output";
import { ReadOnlyNotebookCell } from "./ReadOnlyNotebookCell";

export interface ReadOnlyNotebookProps {
  cells: readonly ReadOnlyNotebookCellData[];
  priority?: readonly string[];
  hostContext?: NteractEmbedHostContextPatch;
  displayMode?: "notebook" | "report";
  showCode?: boolean;
  focusOutputs?: boolean;
  deferIsolatedFrameUntilVisible?: boolean;
  deferredIsolatedFrameRootMargin?: string;
  className?: string;
  cellClassName?: string;
  sourceClassName?: string;
  outputClassName?: string;
  lineWrapping?: boolean;
  label?: string;
  scrollable?: boolean;
  emptyContent?: ReactNode;
  renderCellError?: (error: Error, cell: ReadOnlyNotebookCellData, index: number) => ReactNode;
  resolveTracebackExecutionTarget?: TracebackExecutionResolver;
  onNavigateToTracebackCell?: TracebackCellNavigator;
}

export function ReadOnlyNotebook({
  cells,
  priority,
  hostContext,
  displayMode = "notebook",
  showCode = true,
  focusOutputs = false,
  deferIsolatedFrameUntilVisible,
  deferredIsolatedFrameRootMargin,
  className,
  cellClassName,
  sourceClassName,
  outputClassName,
  lineWrapping = true,
  label = "Notebook cells",
  scrollable = false,
  emptyContent = null,
  renderCellError,
  resolveTracebackExecutionTarget,
  onNavigateToTracebackCell,
}: ReadOnlyNotebookProps) {
  return (
    <NotebookCellList
      cells={cells}
      label={label}
      className={className}
      slot="read-only-notebook"
      scrollable={scrollable}
      emptyContent={emptyContent}
      keyForCell={(cell, index) => `${cell.id}:${index}`}
      renderCellError={(error, cell, index) =>
        renderCellError ? renderCellError(error, cell, index) : defaultCellError(error, index)
      }
      renderCell={(cell) => (
        <ReadOnlyNotebookCell
          id={cell.id}
          cellType={cell.cellType}
          source={cell.source}
          language={cell.language}
          outputs={cell.outputs}
          executionCount={cell.executionCount}
          priority={priority}
          hostContext={hostContext}
          displayMode={displayMode}
          showSource={cell.cellType !== "code" || showCode}
          focusOutputs={focusOutputs}
          deferIsolatedFrameUntilVisible={deferIsolatedFrameUntilVisible}
          deferredIsolatedFrameRootMargin={deferredIsolatedFrameRootMargin}
          className={cellClassName}
          sourceClassName={sourceClassName}
          outputClassName={outputClassName}
          lineWrapping={lineWrapping}
          resolveTracebackExecutionTarget={resolveTracebackExecutionTarget}
          onNavigateToTracebackCell={onNavigateToTracebackCell}
        />
      )}
    />
  );
}

function defaultCellError(error: Error, index: number) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      Unable to render cell {index + 1}: {error.message}
    </div>
  );
}
