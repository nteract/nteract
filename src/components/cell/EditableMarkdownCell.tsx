import { type Extension } from "@codemirror/state";
import { type KeyBinding } from "@codemirror/view";
import { Check, Pencil } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { CodeMirrorEditor, type CodeMirrorEditorRef } from "@/components/editor/codemirror-editor";
import type { IsolatedDiagnosticHandler } from "@/components/isolated";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import type { IsolatedFrameHandle } from "@/components/isolated/isolated-frame";
import { cn } from "@/lib/utils";
import { CellContainer } from "./CellContainer";
import {
  registerMarkdownHeadingNavigator,
  scrollIsolatedMarkdownHeading,
} from "./markdown-heading-navigation";
import {
  createMarkdownEditModeKeyMap,
  shouldExitMarkdownEditOnBlur,
} from "./markdown-editor-keymap";
import { OutputArea } from "./OutputArea";
import type { JupyterOutput } from "./jupyter-output";

export interface EditableMarkdownCellProps {
  id: string;
  source: string;
  renderedSource?: string;
  markdownMetadata?: Record<string, unknown>;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  editorRef: RefObject<CodeMirrorEditorRef | null>;
  isFocused?: boolean;
  isPreviousCellFromFocused?: boolean;
  isNextCellFromFocused?: boolean;
  onFocus?: () => void;
  focusPreview?: boolean;
  className?: string;
  sourceClassName?: string;
  editorClassName?: string;
  previewClassName?: string;
  previewOutputClassName?: string;
  actionClassName?: string;
  rightGutterContent?: ReactNode;
  dragHandleProps?: Record<string, unknown>;
  isDragging?: boolean;
  placeholder?: string;
  priority?: readonly string[];
  hostContext?: NteractEmbedHostContextPatch;
  editorExtensions?: readonly Extension[];
  editorKeyMap?: readonly KeyBinding[];
  searchQuery?: string;
  onPreviewKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onLinkClick?: (url: string, newTab: boolean) => void;
  onIframeMouseDown?: () => void;
  onDiagnostic?: IsolatedDiagnosticHandler;
  presenceIndicators?: ReactNode;
}

export function EditableMarkdownCell({
  id,
  source,
  renderedSource = source,
  markdownMetadata,
  editing,
  onEditingChange,
  editorRef,
  isFocused,
  isPreviousCellFromFocused,
  isNextCellFromFocused,
  onFocus,
  focusPreview,
  className,
  sourceClassName,
  editorClassName,
  previewClassName,
  previewOutputClassName,
  actionClassName,
  rightGutterContent,
  dragHandleProps,
  isDragging,
  placeholder = "Enter markdown...",
  priority,
  hostContext,
  editorExtensions,
  editorKeyMap,
  searchQuery,
  onPreviewKeyDown,
  onLinkClick,
  onIframeMouseDown,
  onDiagnostic,
  presenceIndicators,
}: EditableMarkdownCellProps) {
  const suppressNextToggleClickRef = useRef(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewFrameRef = useRef<IsolatedFrameHandle | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const markdownOutput = useMemo<JupyterOutput>(
    () => ({
      output_id: `markdown-source:${id}`,
      output_type: "display_data",
      data: { "text/markdown": renderedSource },
      metadata: markdownMetadata ?? {},
    }),
    [id, markdownMetadata, renderedSource],
  );
  const editorExtensionArray = useMemo(
    () => (editorExtensions ? [...editorExtensions] : undefined),
    [editorExtensions],
  );
  const enterEditing = useCallback(() => {
    onEditingChange(true);
  }, [onEditingChange]);

  const exitEditing = useCallback(
    (options?: { force?: boolean }) => {
      const currentSource =
        editorRef.current?.getEditor()?.state.doc.toString() ?? sourceRef.current;
      if (options?.force || shouldExitMarkdownEditOnBlur(currentSource)) {
        onEditingChange(false);
      }
    },
    [editorRef, onEditingChange],
  );

  const editorKeyMapArray = useMemo(() => {
    return [
      ...createMarkdownEditModeKeyMap({
        exitEditing,
        forceExitEditing: () => exitEditing({ force: true }),
      }),
      ...(editorKeyMap ? [...editorKeyMap] : []),
    ];
  }, [editorKeyMap, exitEditing]);

  const handleActionMouseDown = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (!editing) return;
      event.preventDefault();
      suppressNextToggleClickRef.current = true;
      exitEditing();
    },
    [editing, exitEditing],
  );

  const handleActionClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (suppressNextToggleClickRef.current) {
        suppressNextToggleClickRef.current = false;
        event.preventDefault();
        return;
      }
      if (editing) {
        exitEditing();
      } else {
        enterEditing();
      }
    },
    [editing, enterEditing, exitEditing],
  );

  const handlePreviewKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      onPreviewKeyDown?.(event);
      if (event.defaultPrevented) return;

      if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        enterEditing();
      }
    },
    [enterEditing, onPreviewKeyDown],
  );

  const handlePreviewFrameHandleChange = useCallback((handle: IsolatedFrameHandle | null) => {
    previewFrameRef.current = handle;
  }, []);

  const scrollToHeading = useCallback(
    async (headingAnchorId: string, options?: { behavior?: ScrollBehavior }) => {
      if (editing) return false;
      return scrollIsolatedMarkdownHeading({
        frame: previewFrameRef.current,
        root: viewRef.current,
        headingAnchorId,
        behavior: options?.behavior,
      });
    },
    [editing],
  );

  useEffect(() => {
    return registerMarkdownHeadingNavigator(id, scrollToHeading);
  }, [id, scrollToHeading]);

  useEffect(() => {
    if (!editing) return;
    const frame = requestAnimationFrame(() => {
      editorRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [editing, editorRef]);

  useEffect(() => {
    if (!focusPreview || editing) return;
    const frame = requestAnimationFrame(() => {
      previewRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [editing, focusPreview]);

  const defaultRightGutterContent = (
    <button
      type="button"
      className={actionClassName}
      aria-label={editing ? "Render markdown" : "Edit markdown"}
      title={editing ? "Render markdown" : "Edit markdown"}
      onMouseDown={handleActionMouseDown}
      onClick={handleActionClick}
    >
      {editing ? <Check aria-hidden="true" /> : <Pencil aria-hidden="true" />}
    </button>
  );

  return (
    <CellContainer
      ref={viewRef}
      id={id}
      cellType="markdown"
      isFocused={isFocused}
      isPreviousCellFromFocused={isPreviousCellFromFocused}
      isNextCellFromFocused={isNextCellFromFocused}
      onFocus={onFocus}
      className={className}
      presenceIndicators={presenceIndicators}
      dragHandleProps={dragHandleProps}
      isDragging={isDragging}
      rightGutterContent={rightGutterContent ?? defaultRightGutterContent}
      codeContent={
        <>
          <div
            className={cn(!editing && "hidden", sourceClassName)}
            data-slot="editable-markdown-source"
          >
            <div className="flex items-center gap-1 py-1">
              <span className="font-mono text-xs text-muted-foreground">md</span>
            </div>
            <CodeMirrorEditor
              ref={editorRef}
              initialValue={source}
              language="markdown"
              lineWrapping
              onBlur={exitEditing}
              keyMap={editorKeyMapArray}
              extensions={editorExtensionArray}
              placeholder={placeholder}
              className={cn("min-h-[2rem]", editorClassName)}
            />
          </div>

          <div
            ref={previewRef}
            className={cn(editing && "hidden", previewClassName, sourceClassName)}
            data-slot="editable-markdown-preview"
            role="textbox"
            aria-label="Markdown cell content"
            aria-readonly
            tabIndex={0}
            onDoubleClick={enterEditing}
            onKeyDown={handlePreviewKeyDown}
          >
            <OutputArea
              cellId={id}
              outputs={[markdownOutput]}
              isolated="auto"
              priority={priority}
              hostContext={hostContext}
              className={previewOutputClassName}
              searchQuery={searchQuery}
              onLinkClick={onLinkClick}
              onIframeMouseDown={onIframeMouseDown}
              onIsolatedFrameHandleChange={handlePreviewFrameHandleChange}
              onDiagnostic={onDiagnostic}
            />
          </div>
        </>
      }
    />
  );
}
