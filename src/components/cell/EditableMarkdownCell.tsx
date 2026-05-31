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
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { CodeMirrorEditor, type CodeMirrorEditorRef } from "@/components/editor/codemirror-editor";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import type { IsolatedFrameHandle } from "@/components/isolated/isolated-frame";
import { cn } from "@/lib/utils";
import { CellContainer } from "./CellContainer";
import {
  registerMarkdownHeadingNavigator,
  scrollIsolatedMarkdownHeading,
} from "./markdown-heading-navigation";
import { OutputArea } from "./OutputArea";
import type { JupyterOutput } from "./jupyter-output";

export interface EditableMarkdownCellProps {
  id: string;
  elementId?: string;
  source: string;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  editorRef: RefObject<CodeMirrorEditorRef | null>;
  isFocused?: boolean;
  onFocus?: () => void;
  isPreviousCellFromFocused?: boolean;
  isNextCellFromFocused?: boolean;
  dragHandleProps?: Record<string, unknown>;
  isDragging?: boolean;
  className?: string;
  sourceClassName?: string;
  editorClassName?: string;
  editorHeaderContent?: ReactNode;
  previewClassName?: string;
  previewOutputClassName?: string;
  actionClassName?: string;
  placeholder?: string;
  priority?: readonly string[];
  hostContext?: NteractEmbedHostContextPatch;
  editorExtensions?: readonly Extension[];
  editorKeyMap?: readonly KeyBinding[];
  previewSource?: string;
  previewOutputId?: string;
  previewFrameName?: string;
  previewMetadata?: Record<string, unknown>;
  previewSearchQuery?: string;
  previewFocused?: boolean;
  keepPreviewMounted?: boolean;
  revealPreviewOnRender?: boolean;
  previewLabel?: string;
  onPreviewSearchMatchCount?: (count: number) => void;
  onPreviewLinkClick?: (url: string, newTab: boolean) => void;
  onPreviewKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => boolean | void;
  onPreviewPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
  onPreviewPointerOut?: (event: PointerEvent<HTMLDivElement>) => void;
  onPreviewIframeMouseDown?: () => void;
  onPreviewIframeDoubleClick?: () => void;
  presenceIndicators?: ReactNode;
  rightGutterContent?: ReactNode;
}

export function EditableMarkdownCell({
  id,
  elementId,
  source,
  editing,
  onEditingChange,
  editorRef,
  isFocused = false,
  onFocus,
  isPreviousCellFromFocused = false,
  isNextCellFromFocused = false,
  dragHandleProps,
  isDragging = false,
  className,
  sourceClassName,
  editorClassName,
  editorHeaderContent,
  previewClassName,
  previewOutputClassName,
  actionClassName,
  placeholder = "Markdown",
  priority,
  hostContext,
  editorExtensions,
  editorKeyMap,
  previewSource = source,
  previewOutputId = `markdown-source:${id}`,
  previewFrameName,
  previewMetadata,
  previewSearchQuery,
  previewFocused = false,
  keepPreviewMounted = false,
  revealPreviewOnRender = true,
  previewLabel = "Markdown cell content",
  onPreviewSearchMatchCount,
  onPreviewLinkClick,
  onPreviewKeyDown,
  onPreviewPointerDown,
  onPreviewPointerOut,
  onPreviewIframeMouseDown,
  onPreviewIframeDoubleClick,
  presenceIndicators,
  rightGutterContent,
}: EditableMarkdownCellProps) {
  const suppressNextToggleClickRef = useRef(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewFrameRef = useRef<IsolatedFrameHandle | null>(null);

  const markdownOutput = useMemo<JupyterOutput>(
    () => ({
      output_id: previewOutputId,
      output_type: "display_data",
      data: { "text/markdown": previewSource },
      metadata: previewMetadata ? { "text/markdown": previewMetadata } : {},
    }),
    [previewMetadata, previewOutputId, previewSource],
  );
  const editorExtensionArray = useMemo(
    () => (editorExtensions ? [...editorExtensions] : undefined),
    [editorExtensions],
  );
  const editorKeyMapArray = useMemo(
    () => (editorKeyMap ? [...editorKeyMap] : undefined),
    [editorKeyMap],
  );

  const enterEditing = useCallback(() => {
    onEditingChange(true);
  }, [onEditingChange]);

  const exitEditing = useCallback(() => {
    const currentSource = editorRef.current?.getEditor()?.state.doc.toString() ?? source;
    if (currentSource.trim().length > 0) {
      onEditingChange(false);
    }
  }, [editorRef, onEditingChange, source]);

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
      if (onPreviewKeyDown?.(event) || event.defaultPrevented) return;
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
    if (!isFocused || editing) return;
    const frame = requestAnimationFrame(() => {
      previewRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [editing, isFocused]);

  const actionButton = (
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
      elementId={elementId}
      cellType="markdown"
      isFocused={isFocused}
      onFocus={onFocus}
      isPreviousCellFromFocused={isPreviousCellFromFocused}
      isNextCellFromFocused={isNextCellFromFocused}
      dragHandleProps={dragHandleProps}
      isDragging={isDragging}
      className={className}
      presenceIndicators={presenceIndicators}
      rightGutterContent={
        rightGutterContent ? (
          <div className="flex flex-col gap-0.5">
            {actionButton}
            {rightGutterContent}
          </div>
        ) : (
          actionButton
        )
      }
      codeContent={
        <>
          {editing ? (
            <div className={sourceClassName} data-slot="editable-markdown-source">
              {editorHeaderContent}
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
          ) : null}
          {!editing || keepPreviewMounted ? (
            <div
              ref={previewRef}
              className={cn(previewClassName, sourceClassName, editing && "hidden")}
              data-slot="editable-markdown-preview"
              role="textbox"
              aria-readonly
              aria-label={previewLabel}
              tabIndex={0}
              onDoubleClick={enterEditing}
              onKeyDown={handlePreviewKeyDown}
              onPointerDown={onPreviewPointerDown}
              onPointerOut={onPreviewPointerOut}
            >
              <OutputArea
                cellId={id}
                isolatedFrameName={previewFrameName}
                outputs={[markdownOutput]}
                isolated="auto"
                priority={priority}
                hostContext={hostContext}
                className={previewOutputClassName}
                searchQuery={previewSearchQuery}
                isolatedFrameScrollPassthrough={!previewFocused}
                isolatedFrameAllowWheelBoundaryScroll={previewFocused}
                revealIsolatedFrameOnRender={revealPreviewOnRender}
                onSearchMatchCount={onPreviewSearchMatchCount}
                onLinkClick={onPreviewLinkClick}
                onIframeMouseDown={onPreviewIframeMouseDown}
                onIframeDoubleClick={onPreviewIframeDoubleClick}
                onIsolatedFrameHandleChange={handlePreviewFrameHandleChange}
              />
            </div>
          ) : null}
        </>
      }
    />
  );
}
