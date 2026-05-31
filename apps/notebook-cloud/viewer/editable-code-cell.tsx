import { useEffect, useLayoutEffect, useRef } from "react";
import { EditableCodeCell as SharedEditableCodeCell } from "@/components/cell/EditableCodeCell";
import type { CodeMirrorEditorRef } from "@/components/editor";
import { setRemoteCursors, setRemoteSelections } from "@/components/editor/remote-cursors";
import type { RemoteCellPresence } from "@/components/editor/presence-state";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import type {
  TracebackCellNavigator,
  TracebackExecutionResolver,
} from "@/components/outputs/traceback-output";
import { notebookCellAnchorId } from "runtimed";
import { type CloudTextAttributionQueue, useCloudEditableCellBridge } from "./cloud-cell-editing";
import type { ResolvedCell } from "./render-resolution";
import type { NotebookHandle } from "./runtimed-wasm-client";
import { cloudSourceLanguage } from "./source-language";

export interface EditableCodeCellProps {
  cell: ResolvedCell;
  className?: string;
  sourceClassName?: string;
  outputClassName?: string;
  priority?: readonly string[];
  hostContext?: NteractEmbedHostContextPatch;
  showSource?: boolean;
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
  resolveTracebackExecutionTarget?: TracebackExecutionResolver;
  onNavigateToTracebackCell?: TracebackCellNavigator;
}

export function EditableCodeCell({
  cell,
  className,
  sourceClassName,
  outputClassName,
  priority,
  hostContext,
  showSource = true,
  onSourceChange,
  onSyncNeeded,
  getHandle,
  localActorLabel,
  textAttributionQueue,
  remotePresence,
  onPresenceCursor,
  onPresenceSelection,
  resolveTracebackExecutionTarget,
  onNavigateToTracebackCell,
}: EditableCodeCellProps) {
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
    applyFullSource(cell.source);
  }, [applyFullSource, cell.source]);

  useEffect(() => {
    const view = editorRef.current?.getEditor();
    if (!view) return;
    setRemoteCursors(view, remotePresence?.cursors ?? []);
    setRemoteSelections(view, remotePresence?.selections ?? []);
  }, [remotePresence]);

  return (
    <SharedEditableCodeCell
      id={cell.id}
      elementId={notebookCellAnchorId(cell.id)}
      source={cell.source}
      language={cloudSourceLanguage(cell.language)}
      outputs={cell.outputs}
      executionCount={cell.executionCount}
      editorRef={editorRef}
      editorExtensions={editorExtensions}
      priority={priority}
      hostContext={hostContext}
      showSource={showSource}
      className={className}
      sourceClassName={sourceClassName}
      outputClassName={outputClassName}
      editorClassName="cloud-code-editor"
      presenceIndicators={<CloudCodePresenceIndicators presence={remotePresence} />}
      deferIsolatedFrameUntilVisible
      deferredIsolatedFrameRootMargin="600px 0px"
      resolveTracebackExecutionTarget={resolveTracebackExecutionTarget}
      onNavigateToTracebackCell={onNavigateToTracebackCell}
    />
  );
}

function CloudCodePresenceIndicators({ presence }: { presence?: RemoteCellPresence }) {
  const peersById = new Map<string, { label: string; color: string }>();
  for (const cursor of presence?.cursors ?? []) {
    peersById.set(cursor.peerId, {
      label: cursor.peerLabel,
      color: cursor.color,
    });
  }
  for (const selection of presence?.selections ?? []) {
    peersById.set(selection.peerId, {
      label: selection.peerLabel,
      color: selection.color,
    });
  }
  const peers = Array.from(peersById.entries()).map(([peerId, peer]) => ({ peerId, ...peer }));

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
