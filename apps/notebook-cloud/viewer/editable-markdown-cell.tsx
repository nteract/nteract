import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { externalChangeAnnotation, CodeMirrorEditor } from "@/components/editor/codemirror-editor";
import type { CodeMirrorEditorRef } from "@/components/editor";
import {
  remoteCursorsExtension,
  setRemoteCursors,
  setRemoteSelections,
} from "@/components/editor/remote-cursors";
import type { RemoteCellPresence } from "@/components/editor/presence-state";
import { presenceSenderExtension } from "../../notebook/src/lib/presence-sender";
import type { ResolvedCell } from "./render-resolution";
import { minimalTextReplacement } from "./text-change";

export interface EditableMarkdownCellProps {
  cell: ResolvedCell;
  className?: string;
  sourceClassName?: string;
  onSourceChange: (cellId: string, source: string) => void;
  remotePresence?: RemoteCellPresence;
  onPresenceCursor?: (cellId: string, line: number, column: number) => void;
  onPresenceSelection?: (
    cellId: string,
    anchorLine: number,
    anchorCol: number,
    headLine: number,
    headCol: number,
  ) => void;
}

export function EditableMarkdownCell({
  cell,
  className,
  sourceClassName,
  onSourceChange,
  remotePresence,
  onPresenceCursor,
  onPresenceSelection,
}: EditableMarkdownCellProps) {
  const editorRef = useRef<CodeMirrorEditorRef>(null);
  const extensions = useMemo(() => {
    // The presence sender captures the cell id; the parent keys this component
    // by cell id so a real id change remounts the editor instead of retargeting it.
    const editorExtensions = [...remoteCursorsExtension()];
    if (onPresenceCursor && onPresenceSelection) {
      editorExtensions.push(
        presenceSenderExtension(cell.id, {
          onCursor: onPresenceCursor,
          onSelection: onPresenceSelection,
        }),
      );
    }
    return editorExtensions;
  }, [cell.id, onPresenceCursor, onPresenceSelection]);

  useLayoutEffect(() => {
    const view = editorRef.current?.getEditor();
    if (!view) return;

    const current = view.state.doc.toString();
    const changes = minimalTextReplacement(current, cell.source);
    if (!changes) return;

    view.dispatch({
      changes,
      annotations: externalChangeAnnotation.of(true),
    });
  }, [cell.source]);

  useEffect(() => {
    const view = editorRef.current?.getEditor();
    if (!view) return;
    setRemoteCursors(view, remotePresence?.cursors ?? []);
    setRemoteSelections(view, remotePresence?.selections ?? []);
  }, [remotePresence]);

  return (
    <article
      className={className}
      data-cell-id={cell.id}
      data-cell-type="markdown"
      data-slot="cloud-editable-markdown-cell"
    >
      <div className={sourceClassName} data-slot="cloud-editable-markdown-source">
        <CodeMirrorEditor
          ref={editorRef}
          initialValue={cell.source}
          language="markdown"
          lineWrapping
          extensions={extensions}
          onValueChange={(source) => onSourceChange(cell.id, source)}
          className="cloud-markdown-editor min-h-[2rem]"
        />
      </div>
    </article>
  );
}
