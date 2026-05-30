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
  className?: string;
  sourceClassName?: string;
  editorClassName?: string;
  previewClassName?: string;
  previewOutputClassName?: string;
  actionClassName?: string;
  placeholder?: string;
  priority?: readonly string[];
  hostContext?: NteractEmbedHostContextPatch;
  editorExtensions?: readonly Extension[];
  editorKeyMap?: readonly KeyBinding[];
  presenceIndicators?: ReactNode;
}

export function EditableMarkdownCell({
  id,
  elementId,
  source,
  editing,
  onEditingChange,
  editorRef,
  className,
  sourceClassName,
  editorClassName,
  previewClassName,
  previewOutputClassName,
  actionClassName,
  placeholder = "Markdown",
  priority,
  hostContext,
  editorExtensions,
  editorKeyMap,
  presenceIndicators,
}: EditableMarkdownCellProps) {
  const suppressNextToggleClickRef = useRef(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const previewFrameRef = useRef<IsolatedFrameHandle | null>(null);

  const markdownOutput = useMemo<JupyterOutput>(
    () => ({
      output_id: `markdown-source:${id}`,
      output_type: "display_data",
      data: { "text/markdown": source },
      metadata: {},
    }),
    [id, source],
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
      if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        enterEditing();
      }
    },
    [enterEditing],
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

  return (
    <CellContainer
      ref={viewRef}
      id={id}
      elementId={elementId}
      cellType="markdown"
      className={className}
      presenceIndicators={presenceIndicators}
      rightGutterContent={
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
      }
      codeContent={
        editing ? (
          <div className={sourceClassName} data-slot="editable-markdown-source">
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
        ) : (
          <div
            className={cn(previewClassName, sourceClassName)}
            data-slot="editable-markdown-preview"
            role="textbox"
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
              onIsolatedFrameHandleChange={handlePreviewFrameHandleChange}
            />
          </div>
        )
      }
    />
  );
}
