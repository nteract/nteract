import { type Extension } from "@codemirror/state";
import { type KeyBinding } from "@codemirror/view";
import { type ReactNode, type RefObject, useMemo } from "react";
import { CodeMirrorEditor, type CodeMirrorEditorRef } from "@/components/editor/codemirror-editor";
import { type SupportedLanguage } from "@/components/editor/languages";
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
  deferIsolatedFrameUntilVisible?: boolean;
  deferredIsolatedFrameRootMargin?: string;
  onOutputLinkClick?: (url: string, newTab: boolean) => void;
  onOutputIframeMouseDown?: () => void;
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
  deferIsolatedFrameUntilVisible,
  deferredIsolatedFrameRootMargin,
  onOutputLinkClick,
  onOutputIframeMouseDown,
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

  const codeContent = showSource ? (
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
  ) : null;

  const outputContent =
    outputArray.length > 0 ? (
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
        deferIsolatedFrameUntilVisible={deferIsolatedFrameUntilVisible}
        deferredIsolatedFrameRootMargin={deferredIsolatedFrameRootMargin}
        onLinkClick={onOutputLinkClick}
        onIframeMouseDown={onOutputIframeMouseDown}
        resolveTracebackExecutionTarget={resolveTracebackExecutionTarget}
        onNavigateToTracebackCell={onNavigateToTracebackCell}
      />
    ) : null;

  return (
    <CellContainer
      id={id}
      elementId={elementId}
      cellType="code"
      isFocused={isFocused}
      onFocus={onFocus}
      codeContent={codeContent}
      outputContent={outputContent}
      hideOutput={outputArray.length === 0}
      gutterContent={<ExecutionCount count={executionCount} />}
      rightGutterContent={rightGutterContent}
      outputRightGutterContent={outputRightGutterContent}
      presenceIndicators={presenceIndicators}
      className={className}
    />
  );
}
