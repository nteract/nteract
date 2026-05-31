import { type Extension } from "@codemirror/state";
import { type KeyBinding } from "@codemirror/view";
import { type ReactNode, type RefObject, useMemo } from "react";
import { CodeMirrorEditor, type CodeMirrorEditorRef } from "@/components/editor/codemirror-editor";
import { type SupportedLanguage } from "@/components/editor/languages";
import type { IsolatedDiagnosticHandler } from "@/components/isolated";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import type {
  TracebackCellNavigator,
  TracebackExecutionResolver,
} from "@/components/outputs/traceback-output";
import { CellContainer } from "./CellContainer";
import { ExecutionCount } from "./ExecutionCount";
import type { JupyterOutput } from "./jupyter-output";
import { OutputArea } from "./OutputArea";

export interface EditableCodeCellProps {
  id: string;
  elementId?: string;
  source: string;
  language?: SupportedLanguage | null;
  outputs?: readonly JupyterOutput[];
  executionCount?: number | null;
  priority?: readonly string[];
  hostContext?: NteractEmbedHostContextPatch;
  editorRef: RefObject<CodeMirrorEditorRef | null>;
  editorExtensions?: readonly Extension[];
  editorKeyMap?: readonly KeyBinding[];
  placeholder?: string;
  showSource?: boolean;
  focusOutputs?: boolean;
  isFocused?: boolean;
  onFocus?: () => void;
  className?: string;
  sourceClassName?: string;
  outputClassName?: string;
  editorClassName?: string;
  presenceIndicators?: ReactNode;
  rightGutterContent?: ReactNode;
  outputRightGutterContent?: ReactNode;
  editorFooterContent?: ReactNode;
  codeContentOverride?: ReactNode;
  outputContentOverride?: ReactNode;
  gutterContent?: ReactNode;
  hideOutput?: boolean;
  isPreviousCellFromFocused?: boolean;
  isNextCellFromFocused?: boolean;
  outputFocused?: boolean;
  outputDimmed?: boolean;
  dragHandleProps?: Record<string, unknown>;
  isDragging?: boolean;
  deferIsolatedFrameUntilVisible?: boolean;
  deferredIsolatedFrameRootMargin?: string;
  preloadIframe?: boolean;
  searchQuery?: string;
  onSearchMatchCount?: (count: number) => void;
  onOutputLinkClick?: (url: string, newTab: boolean) => void;
  onOutputIframeMouseDown?: () => void;
  onOutputDiagnostic?: IsolatedDiagnosticHandler;
  useOutputWell?: boolean;
  resolveTracebackExecutionTarget?: TracebackExecutionResolver;
  onNavigateToTracebackCell?: TracebackCellNavigator;
}

export function EditableCodeCell({
  id,
  elementId,
  source,
  language = "python",
  outputs = [],
  executionCount = null,
  priority,
  hostContext,
  editorRef,
  editorExtensions,
  editorKeyMap,
  placeholder = "Enter code...",
  showSource = true,
  focusOutputs = false,
  isFocused = false,
  onFocus,
  className,
  sourceClassName,
  outputClassName,
  editorClassName,
  presenceIndicators,
  rightGutterContent,
  outputRightGutterContent,
  editorFooterContent,
  codeContentOverride,
  outputContentOverride,
  gutterContent = <ExecutionCount count={executionCount} />,
  hideOutput,
  isPreviousCellFromFocused = false,
  isNextCellFromFocused = false,
  outputFocused = false,
  outputDimmed = false,
  dragHandleProps,
  isDragging = false,
  deferIsolatedFrameUntilVisible,
  deferredIsolatedFrameRootMargin,
  preloadIframe,
  searchQuery,
  onSearchMatchCount,
  onOutputLinkClick,
  onOutputIframeMouseDown,
  onOutputDiagnostic,
  useOutputWell,
  resolveTracebackExecutionTarget,
  onNavigateToTracebackCell,
}: EditableCodeCellProps) {
  const outputArray = useMemo(() => [...outputs], [outputs]);
  const editorExtensionArray = useMemo(
    () => (editorExtensions ? [...editorExtensions] : undefined),
    [editorExtensions],
  );
  const editorKeyMapArray = useMemo(
    () => (editorKeyMap ? [...editorKeyMap] : undefined),
    [editorKeyMap],
  );
  const resolvedLanguage = language ?? "plain";

  const codeContent =
    codeContentOverride ??
    (showSource ? (
      <div className={sourceClassName}>
        <CodeMirrorEditor
          ref={editorRef}
          initialValue={source}
          language={resolvedLanguage}
          keyMap={editorKeyMapArray}
          extensions={editorExtensionArray}
          placeholder={placeholder}
          autoFocus={isFocused}
          className={editorClassName}
        />
        {editorFooterContent}
      </div>
    ) : null);

  const outputContent =
    outputContentOverride ??
    (outputArray.length > 0 ? (
      <OutputArea
        cellId={id}
        executionCount={executionCount}
        outputs={outputArray}
        isolated="auto"
        focused={focusOutputs}
        priority={priority}
        hostContext={hostContext}
        className={outputClassName}
        layoutInset="cell-output"
        preloadIframe={preloadIframe}
        searchQuery={searchQuery}
        onSearchMatchCount={onSearchMatchCount}
        deferIsolatedFrameUntilVisible={deferIsolatedFrameUntilVisible}
        deferredIsolatedFrameRootMargin={deferredIsolatedFrameRootMargin}
        onLinkClick={onOutputLinkClick}
        onIframeMouseDown={onOutputIframeMouseDown}
        onDiagnostic={onOutputDiagnostic}
        useOutputWell={useOutputWell}
        resolveTracebackExecutionTarget={resolveTracebackExecutionTarget}
        onNavigateToTracebackCell={onNavigateToTracebackCell}
      />
    ) : null);

  return (
    <CellContainer
      id={id}
      elementId={elementId}
      cellType="code"
      isFocused={isFocused}
      isPreviousCellFromFocused={isPreviousCellFromFocused}
      isNextCellFromFocused={isNextCellFromFocused}
      outputFocused={outputFocused}
      outputDimmed={outputDimmed}
      onFocus={onFocus}
      codeContent={codeContent}
      outputContent={outputContent}
      hideOutput={hideOutput ?? outputContent == null}
      gutterContent={gutterContent}
      rightGutterContent={rightGutterContent}
      outputRightGutterContent={outputRightGutterContent}
      presenceIndicators={presenceIndicators}
      dragHandleProps={dragHandleProps}
      isDragging={isDragging}
      className={className}
    />
  );
}
