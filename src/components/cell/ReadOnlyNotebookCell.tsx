import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import type { IsolatedFrameHandle } from "@/components/isolated/isolated-frame";
import { ReadOnlyCodeMirror } from "@/components/editor/readonly-codemirror";
import type { SupportedLanguage } from "@/components/editor/languages";
import type {
  TracebackCellNavigator,
  TracebackExecutionResolver,
} from "@/components/outputs/traceback-output";
import { cn } from "@/lib/utils";
import { CellContainer } from "./CellContainer";
import { ExecutionCount } from "./ExecutionCount";
import {
  registerMarkdownHeadingNavigator,
  scrollIsolatedMarkdownHeading,
} from "./markdown-heading-navigation";
import { OutputArea } from "./OutputArea";
import type { JupyterOutput } from "./jupyter-output";
import { notebookCellAnchorId } from "runtimed";

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
  deferIsolatedFrameUntilVisible?: boolean;
  deferredIsolatedFrameRootMargin?: string;
  resolveTracebackExecutionTarget?: TracebackExecutionResolver;
  onNavigateToTracebackCell?: TracebackCellNavigator;
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
  deferIsolatedFrameUntilVisible,
  deferredIsolatedFrameRootMargin,
  resolveTracebackExecutionTarget,
  onNavigateToTracebackCell,
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
        layoutInset={displayMode === "notebook" ? "cell-output" : "standalone"}
        deferIsolatedFrameUntilVisible={deferIsolatedFrameUntilVisible}
        deferredIsolatedFrameRootMargin={deferredIsolatedFrameRootMargin}
        resolveTracebackExecutionTarget={resolveTracebackExecutionTarget}
        onNavigateToTracebackCell={onNavigateToTracebackCell}
      />
    ) : null;

  if (displayMode === "report") {
    if (!showSource && !outputContent) return null;

    return (
      <article
        id={notebookCellAnchorId(id)}
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
      <ReadOnlyMarkdownSource
        cellId={cellId}
        source={source}
        priority={priority}
        hostContext={hostContext}
        layoutInset="none"
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

function ReadOnlyMarkdownSource({
  cellId,
  source,
  priority,
  hostContext,
  className,
}: {
  cellId: string;
  source: string;
  priority?: readonly string[];
  hostContext?: NteractEmbedHostContextPatch;
  className?: string;
}) {
  const viewRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<IsolatedFrameHandle | null>(null);
  const output = useMemo(() => markdownSourceOutput(cellId, source), [cellId, source]);

  const handleFrameHandleChange = useCallback((handle: IsolatedFrameHandle | null) => {
    frameRef.current = handle;
  }, []);

  const scrollToHeading = useCallback(
    (headingAnchorId: string, options?: { behavior?: ScrollBehavior }) =>
      scrollIsolatedMarkdownHeading({
        frame: frameRef.current,
        root: viewRef.current,
        headingAnchorId,
        behavior: options?.behavior,
      }),
    [],
  );

  useEffect(() => {
    return registerMarkdownHeadingNavigator(cellId, scrollToHeading);
  }, [cellId, scrollToHeading]);

  return (
    <div ref={viewRef} data-slot="read-only-markdown-source">
      <OutputArea
        cellId={cellId}
        outputs={[output]}
        isolated="auto"
        priority={priority}
        hostContext={hostContext}
        className={className}
        onIsolatedFrameHandleChange={handleFrameHandleChange}
      />
    </div>
  );
}

function markdownSourceOutput(cellId: string, source: string): JupyterOutput {
  return {
    output_id: `markdown-source:${cellId}`,
    output_type: "display_data",
    data: { "text/markdown": source },
    metadata: {},
  };
}
