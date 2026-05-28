import { Check, Pencil } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { CellContainer } from "@/components/cell/CellContainer";
import { OutputArea } from "@/components/cell/OutputArea";
import type { JupyterOutput } from "@/components/cell/jupyter-output";
import { CodeMirrorEditor } from "@/components/editor/codemirror-editor";
import type { CodeMirrorEditorRef } from "@/components/editor";
import {
  remoteCursorsExtension,
  setRemoteCursors,
  setRemoteSelections,
} from "@/components/editor/remote-cursors";
import type { RemoteCellPresence } from "@/components/editor/presence-state";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import { cn } from "@/lib/utils";
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
  const [editing, setEditing] = useState(cell.source.trim().length === 0);
  const editorRef = useRef<CodeMirrorEditorRef>(null);
  const suppressNextToggleClickRef = useRef(false);
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

  const markdownOutput = useMemo<JupyterOutput>(
    () => ({
      output_id: `markdown-source:${cell.id}`,
      output_type: "display_data",
      data: { "text/markdown": cell.source },
      metadata: {},
    }),
    [cell.id, cell.source],
  );

  const enterEditing = useCallback(() => {
    setEditing(true);
  }, []);

  const exitEditing = useCallback(() => {
    const currentSource = editorRef.current?.getEditor()?.state.doc.toString() ?? cell.source;
    if (currentSource.trim().length > 0) {
      setEditing(false);
    }
  }, [cell.source]);

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
    if (cell.source.trim().length === 0 && !editing) {
      setEditing(true);
    }
  }, [cell.source, editing]);

  useEffect(() => {
    if (!editing) return;
    const frame = requestAnimationFrame(() => {
      editorRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  useEffect(() => {
    const view = editorRef.current?.getEditor();
    if (!view) return;
    setRemoteCursors(view, remotePresence?.cursors ?? []);
    setRemoteSelections(view, remotePresence?.selections ?? []);
  }, [editing, remotePresence]);

  return (
    <CellContainer
      id={cell.id}
      cellType="markdown"
      className={className}
      presenceIndicators={<CloudMarkdownPresenceIndicators presence={remotePresence} />}
      rightGutterContent={
        <button
          type="button"
          className="cloud-markdown-cell-action"
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
          <div className={sourceClassName} data-slot="cloud-editable-markdown-source">
            <CodeMirrorEditor
              ref={editorRef}
              initialValue={cell.source}
              language="markdown"
              lineWrapping
              onBlur={exitEditing}
              extensions={extensions}
              placeholder="Markdown"
              className="cloud-markdown-editor min-h-[2rem]"
            />
          </div>
        ) : (
          <div
            className={cn("cloud-markdown-preview", sourceClassName)}
            data-slot="cloud-editable-markdown-preview"
            role="textbox"
            aria-readonly
            tabIndex={0}
            onDoubleClick={enterEditing}
            onKeyDown={handlePreviewKeyDown}
          >
            <OutputArea
              cellId={cell.id}
              outputs={[markdownOutput]}
              isolated="auto"
              priority={priority}
              hostContext={hostContext}
              className="cloud-markdown-preview-output"
            />
          </div>
        )
      }
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
