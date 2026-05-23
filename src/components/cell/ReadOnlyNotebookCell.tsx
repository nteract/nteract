import { type ReactNode, useMemo } from "react";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import { ReadOnlyCodeMirror } from "@/components/editor/readonly-codemirror";
import type { SupportedLanguage } from "@/components/editor/languages";
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

  const outputContent =
    outputs.length > 0 ? (
      <OutputArea
        cellId={id}
        executionCount={executionCount}
        outputs={[...outputs]}
        isolated="auto"
        priority={priority}
        hostContext={hostContext}
        className={outputClassName}
      />
    ) : null;

  return (
    <CellContainer
      id={id}
      cellType={cellType}
      codeContent={codeContent}
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
