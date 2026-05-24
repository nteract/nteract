import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { CodeMirrorEditor } from "@/components/editor/codemirror-editor";
import type { CodeMirrorEditorRef } from "@/components/editor";
import {
  remoteCursorsExtension,
  setRemoteCursors,
  setRemoteSelections,
} from "@/components/editor/remote-cursors";
import type { RemoteCellPresence } from "@/components/editor/presence-state";
import {
  createCrdtBridge,
  remoteChangesFromTextAttributions,
  type TextAttributionLike,
} from "../../notebook/src/lib/crdt-editor-bridge";
import { presenceSenderExtension } from "../../notebook/src/lib/presence-sender";
import type { ResolvedCell } from "./render-resolution";
import type { NotebookHandle } from "./runtimed-wasm-client";

export interface CloudTextAttributionBatch {
  sequence: number;
  attributions: readonly TextAttributionLike[];
}

export interface CloudTextAttributionQueue {
  batches: readonly CloudTextAttributionBatch[];
}

export interface EditableMarkdownCellProps {
  cell: ResolvedCell;
  className?: string;
  sourceClassName?: string;
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
  onSourceChange,
  onSyncNeeded,
  getHandle,
  localActorLabel,
  textAttributionQueue,
  remotePresence,
  onPresenceCursor,
  onPresenceSelection,
}: EditableMarkdownCellProps) {
  const editorRef = useRef<CodeMirrorEditorRef>(null);
  const getHandleRef = useRef(getHandle);
  const onSourceChangeRef = useRef(onSourceChange);
  const onSyncNeededRef = useRef(onSyncNeeded);
  const lastAppliedAttributionSequenceRef = useRef(0);

  useLayoutEffect(() => {
    getHandleRef.current = getHandle;
    onSourceChangeRef.current = onSourceChange;
    onSyncNeededRef.current = onSyncNeeded;
  });

  const bridge = useMemo(
    () =>
      createCrdtBridge({
        getHandle: () => getHandleRef.current(),
        cellId: cell.id,
        onSourceChanged: (source) => onSourceChangeRef.current(cell.id, source),
        onSyncNeeded: () => onSyncNeededRef.current(),
      }),
    [cell.id],
  );
  const extensions = useMemo(() => {
    // The presence sender captures the cell id; the parent keys this component
    // by cell id so a real id change remounts the editor instead of retargeting it.
    const editorExtensions = [bridge.extension, ...remoteCursorsExtension()];
    if (onPresenceCursor && onPresenceSelection) {
      editorExtensions.push(
        presenceSenderExtension(cell.id, {
          onCursor: onPresenceCursor,
          onSelection: onPresenceSelection,
        }),
      );
    }
    return editorExtensions;
  }, [bridge.extension, cell.id, onPresenceCursor, onPresenceSelection]);

  useLayoutEffect(() => {
    if (!textAttributionQueue) return;

    for (const batch of textAttributionQueue.batches) {
      if (batch.sequence <= lastAppliedAttributionSequenceRef.current) continue;

      const changes = remoteChangesFromTextAttributions(
        batch.attributions,
        cell.id,
        localActorLabel,
      );
      bridge.applyRemoteChanges(changes);
      lastAppliedAttributionSequenceRef.current = batch.sequence;
    }
  }, [bridge, cell.id, localActorLabel, textAttributionQueue]);

  useLayoutEffect(() => {
    bridge.applyFullSource(cell.source);
  }, [bridge, cell.source]);

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
          className="cloud-markdown-editor min-h-[2rem]"
        />
      </div>
    </article>
  );
}
