import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EditableMarkdownCell as SharedEditableMarkdownCell } from "@/components/cell/EditableMarkdownCell";
import { shouldStartMarkdownEditMode } from "@/components/cell/markdown-editor-keymap";
import type { CodeMirrorEditorRef } from "@/components/editor";
import {
  remoteCursorsExtension,
  setRemoteCursors,
  setRemoteSelections,
} from "@/components/editor/remote-cursors";
import type { RemoteCellPresence } from "@/components/editor/presence-state";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
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
  const [editing, setEditing] = useState(shouldStartMarkdownEditMode(cell.source));
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
    if (!editing) return;
    bridge.applyFullSource(cell.source);
  }, [bridge, cell.source, editing]);

  useEffect(() => {
    if (shouldStartMarkdownEditMode(cell.source) && !editing) {
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
      editorExtensions={extensions}
      presenceIndicators={<CloudMarkdownPresenceIndicators presence={remotePresence} />}
    />
  );
}

function CloudMarkdownPresenceIndicators({ presence }: { presence?: RemoteCellPresence }) {
  const peers = useMemo(() => {
    const byPeer = new Map<string, { label: string; color: string }>();
    for (const cursor of presence?.cursors ?? []) {
      byPeer.set(cursor.peerId, {
        label: cursor.peerLabel,
        color: cursor.color,
      });
    }
    for (const selection of presence?.selections ?? []) {
      byPeer.set(selection.peerId, {
        label: selection.peerLabel,
        color: selection.color,
      });
    }
    return Array.from(byPeer.entries()).map(([peerId, peer]) => ({ peerId, ...peer }));
  }, [presence]);

  if (peers.length === 0) {
    return null;
  }

  return (
    <div className="cloud-markdown-presence" aria-label="Remote editors">
      {peers.slice(0, 4).map((peer) => (
        <span
          key={peer.peerId}
          style={{ backgroundColor: peer.color }}
          title={peer.label}
          aria-label={peer.label}
        />
      ))}
    </div>
  );
}
