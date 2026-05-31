import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EditableMarkdownCell as SharedEditableMarkdownCell } from "@/components/cell/EditableMarkdownCell";
import type { CodeMirrorEditorRef } from "@/components/editor";
import { setRemoteCursors, setRemoteSelections } from "@/components/editor/remote-cursors";
import type { RemoteCellPresence } from "@/components/editor/presence-state";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import { notebookCellAnchorId } from "runtimed";
import { type CloudTextAttributionQueue, useCloudEditableCellBridge } from "./cloud-cell-editing";
import { CloudCellPresenceIndicators } from "./cell-presence";
import type { ResolvedCell } from "./render-resolution";
import type { NotebookHandle } from "./runtimed-wasm-client";

export interface EditableMarkdownCellProps {
  cell: ResolvedCell;
  className?: string;
  sourceClassName?: string;
  priority?: readonly string[];
  hostContext?: NteractEmbedHostContextPatch;
  onSourceChange: (cellId: string, source: string) => void;
  onSyncNeeded: () => void;
  getHandle: () => NotebookHandle | null;
  localActorLabel?: string | null;
  textAttributionQueue?: CloudTextAttributionQueue;
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
  priority,
  hostContext,
  onSourceChange,
  onSyncNeeded,
  getHandle,
  localActorLabel,
  textAttributionQueue,
  remotePresence,
  onPresenceCursor,
  onPresenceSelection,
}: EditableMarkdownCellProps) {
  const [editing, setEditing] = useState(cell.source.trim().length === 0);
  const editorRef = useRef<CodeMirrorEditorRef>(null);
  const { applyFullSource, editorExtensions } = useCloudEditableCellBridge({
    cellId: cell.id,
    getHandle,
    onSourceChange,
    onSyncNeeded,
    localActorLabel,
    textAttributionQueue,
    onPresenceCursor,
    onPresenceSelection,
  });

  useLayoutEffect(() => {
    if (!editing) return;
    applyFullSource(cell.source);
  }, [applyFullSource, cell.source, editing]);

  useEffect(() => {
    if (cell.source.trim().length === 0 && !editing) {
      setEditing(true);
    }
  }, [cell.source, editing]);

  useEffect(() => {
    const view = editorRef.current?.getEditor();
    if (!view) return;
    setRemoteCursors(view, remotePresence?.cursors ?? []);
    setRemoteSelections(view, remotePresence?.selections ?? []);
  }, [editing, remotePresence]);

  return (
    <SharedEditableMarkdownCell
      id={cell.id}
      elementId={notebookCellAnchorId(cell.id)}
      source={cell.source}
      editing={editing}
      onEditingChange={setEditing}
      editorRef={editorRef}
      className={className}
      sourceClassName={sourceClassName}
      editorClassName="cloud-markdown-editor"
      previewClassName="cloud-markdown-preview"
      previewOutputClassName="cloud-markdown-preview-output"
      actionClassName="cloud-markdown-cell-action"
      priority={priority}
      hostContext={hostContext}
      editorExtensions={editorExtensions}
      presenceIndicators={<CloudCellPresenceIndicators presence={remotePresence} />}
    />
  );
}
