import { type ReactNode, useMemo } from "react";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import { ReadOnlyCodeMirror } from "@/components/editor/readonly-codemirror";
import type { SupportedLanguage } from "@/components/editor/languages";
import { cn } from "@/lib/utils";
import { CellContainer } from "./CellContainer";
import { ExecutionCount } from "./ExecutionCount";
import { OutputArea } from "./OutputArea";
import type { JupyterOutput } from "./jupyter-output";

export interface ReadOnlyNotebookCellProps {
  id: string;
  cellType: string;
  source: string;
  language?: SupportedLanguage | null;
  outputs?: readonly JupyterOutput[];
  executionCount?: number | null;
  priority?: readonly string[];
  hostContext?: NteractEmbedHostContextPatch;
  displayMode?: "notebook" | "report";
  showSource?: boolean;
  focusOutputs?: boolean;
  className?: string;
  sourceClassName?: string;
  outputClassName?: string;
  lineWrapping?: boolean;
}

export function ReadOnlyNotebookCell({
  id,
  cellType,
  source,
  language = "plain",
  outputs = [],
  executionCount = null,
  priority,
  hostContext,
  displayMode = "notebook",
  showSource = true,
  focusOutputs = false,
  className,
  sourceClassName,
  outputClassName,
  lineWrapping = true,
}: ReadOnlyNotebookCellProps) {
  const codeContent = useMemo(
    () =>
      renderReadOnlyCellSource({
        cellId: id,
        cellType,
        hostContext,
        language,
        lineWrapping,
        priority,
        source,
        sourceClassName,
      }),
    [cellType, hostContext, id, language, lineWrapping, priority, source, sourceClassName],
  );
  const outputArray = useMemo(() => [...outputs], [outputs]);

  const outputContent =
    outputs.length > 0 ? (
      <OutputArea
        cellId={id}
        executionCount={executionCount}
        outputs={outputArray}
        isolated="auto"
        focused={focusOutputs}
        priority={priority}
        hostContext={hostContext}
        className={outputClassName}
      />
    ) : null;

  if (displayMode === "report") {
    if (!showSource && !outputContent) return null;

    return (
      <article
        className={cn("flex min-w-0 flex-col", className)}
        data-cell-id={id}
        data-cell-type={cellType}
        data-slot="read-only-report-cell"
      >
        {showSource ? (
          <div className="min-w-0" data-slot="read-only-cell-source">
            {codeContent}
          </div>
        ) : null}
        {outputContent ? (
          <div className="min-w-0" data-slot="read-only-cell-output">
            {outputContent}
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <CellContainer
      id={id}
      cellType={cellType}
      codeContent={showSource ? codeContent : null}
      outputContent={outputContent}
      gutterContent={cellType === "code" ? <ExecutionCount count={executionCount} /> : null}
      className={className}
    />
  );
}

function renderReadOnlyCellSource({
  cellId,
  cellType,
  hostContext,
  language,
  lineWrapping,
  priority,
  source,
  sourceClassName,
}: {
  cellId: string;
  cellType: string;
  hostContext?: NteractEmbedHostContextPatch;
  language?: SupportedLanguage | null;
  lineWrapping: boolean;
  priority?: readonly string[];
  source: string;
  sourceClassName?: string;
}): ReactNode {
  if (cellType === "markdown") {
    return (
      <OutputArea
        cellId={cellId}
        outputs={[markdownSourceOutput(source)]}
        isolated="auto"
        priority={priority}
        hostContext={hostContext}
        className={cn("pl-0 pr-0", sourceClassName)}
      />
    );
  }

  return (
    <ReadOnlyCodeMirror
      value={source}
      language={language ?? "plain"}
      lineWrapping={lineWrapping}
      className={sourceClassName}
    />
  );
}

function markdownSourceOutput(source: string): JupyterOutput {
  return {
    output_type: "display_data",
    data: { "text/markdown": source },
    metadata: {},
  };
}
