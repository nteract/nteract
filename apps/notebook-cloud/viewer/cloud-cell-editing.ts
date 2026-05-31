import { type Extension } from "@codemirror/state";
import { useLayoutEffect, useMemo, useRef } from "react";
import { remoteCursorsExtension } from "@/components/editor/remote-cursors";
import {
  createCrdtBridge,
  remoteChangesFromTextAttributions,
  type TextAttributionLike,
} from "../../notebook/src/lib/crdt-editor-bridge";
import { presenceSenderExtension } from "../../notebook/src/lib/presence-sender";
import type { NotebookHandle } from "./runtimed-wasm-client";

export interface CloudTextAttributionBatch {
  sequence: number;
  attributions: readonly TextAttributionLike[];
}

export interface CloudTextAttributionQueue {
  batches: readonly CloudTextAttributionBatch[];
}

export interface CloudEditableCellBridgeOptions {
  cellId: string;
  getHandle: () => NotebookHandle | null;
  onSourceChange: (cellId: string, source: string) => void;
  onSyncNeeded: () => void;
  localActorLabel?: string | null;
  textAttributionQueue?: CloudTextAttributionQueue;
  onPresenceCursor?: (cellId: string, line: number, column: number) => void;
  onPresenceSelection?: (
    cellId: string,
    anchorLine: number,
    anchorCol: number,
    headLine: number,
    headCol: number,
  ) => void;
}

export function useCloudEditableCellBridge({
  cellId,
  getHandle,
  onSourceChange,
  onSyncNeeded,
  localActorLabel,
  textAttributionQueue,
  onPresenceCursor,
  onPresenceSelection,
}: CloudEditableCellBridgeOptions): {
  applyFullSource: (source: string) => void;
  editorExtensions: readonly Extension[];
} {
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
        cellId,
        onSourceChanged: (source) => onSourceChangeRef.current(cellId, source),
        onSyncNeeded: () => onSyncNeededRef.current(),
      }),
    [cellId],
  );

  const editorExtensions = useMemo(() => {
    const extensions = [bridge.extension, ...remoteCursorsExtension()];
    if (onPresenceCursor && onPresenceSelection) {
      extensions.push(
        presenceSenderExtension(cellId, {
          onCursor: onPresenceCursor,
          onSelection: onPresenceSelection,
        }),
      );
    }
    return extensions;
  }, [bridge.extension, cellId, onPresenceCursor, onPresenceSelection]);

  useLayoutEffect(() => {
    if (!textAttributionQueue) return;

    for (const batch of textAttributionQueue.batches) {
      if (batch.sequence <= lastAppliedAttributionSequenceRef.current) continue;

      const changes = remoteChangesFromTextAttributions(
        batch.attributions,
        cellId,
        localActorLabel,
      );
      bridge.applyRemoteChanges(changes);
      lastAppliedAttributionSequenceRef.current = batch.sequence;
    }
  }, [bridge, cellId, localActorLabel, textAttributionQueue]);

  return {
    applyFullSource: bridge.applyFullSource,
    editorExtensions,
  };
}
