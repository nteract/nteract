/**
 * React context and hook for cell-level CRDT bridges.
 *
 * The `CrdtBridgeProvider` is mounted once by the notebook root component,
 * giving every cell access to the WASM handle and sync trigger. Each cell
 * calls `useCrdtBridge(cellId)` to get a bridge extension wired to its
 * source text in the Automerge document.
 *
 * Inbound flow: the hook subscribes to the frame bus for text_attribution
 * broadcasts and routes them to the bridge's `applyRemoteChanges()`.
 *
 * Outbound flow: the bridge's ViewPlugin calls `splice_source` on the WASM
 * handle directly (character-level, no Myers diff). The bridge updates the
 * shared cell store after local edits, and `onSyncNeeded` triggers the
 * debounced sync to the daemon.
 */

import type { Extension } from "@codemirror/state";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from "react";
import { isTextAttributionEvent } from "runtimed";
import {
  type CrdtBridge,
  createCrdtBridge,
  remoteChangesFromTextAttributions,
} from "../lib/crdt-editor-bridge";
import { logger } from "../lib/logger";
import { updateCellSourceById } from "@/components/notebook/state/cell-store";
import { subscribeBroadcast } from "../lib/notebook-frame-bus";
import type { NotebookHandle } from "../wasm/runtimed-wasm/runtimed_wasm.js";

// ── Context ──────────────────────────────────────────────────────────

interface CrdtBridgeContextValue {
  /** Read the current WASM NotebookHandle (null during bootstrap). */
  getHandle: () => NotebookHandle | null;
  /** Host capability gate for outbound source mutations for a specific cell. */
  canWriteSource?: (cellId: string) => boolean;
  /**
   * Signal that the CRDT was mutated and needs syncing to daemon. The hook
   * supplies the mutated cell's id; hosts that only trigger sync may ignore
   * it (the cloud viewer's offline-merge tracking consumes it).
   */
  onSyncNeeded: (cellId?: string) => void;
  /** Local actor label (e.g. "local:kyle/desktop:abcd1234") for filtering self-echo attributions. */
  localActor: string;
}

const CrdtBridgeContext = createContext<CrdtBridgeContextValue | null>(null);

// ── Provider ─────────────────────────────────────────────────────────

interface CrdtBridgeProviderProps {
  getHandle: () => NotebookHandle | null;
  canWriteSource?: (cellId: string) => boolean;
  onSyncNeeded: (cellId?: string) => void;
  localActor: string;
  children: ReactNode;
}

export function CrdtBridgeProvider({
  getHandle,
  canWriteSource,
  onSyncNeeded,
  localActor,
  children,
}: CrdtBridgeProviderProps) {
  // Stable ref so the context value doesn't change on every render.
  const valueRef = useRef<CrdtBridgeContextValue>({
    getHandle,
    canWriteSource,
    onSyncNeeded,
    localActor,
  });
  valueRef.current.getHandle = getHandle;
  valueRef.current.canWriteSource = canWriteSource;
  valueRef.current.onSyncNeeded = onSyncNeeded;
  valueRef.current.localActor = localActor;

  // The context value object itself is stable (same ref every render).
  const value = valueRef.current;

  return <CrdtBridgeContext.Provider value={value}>{children}</CrdtBridgeContext.Provider>;
}

// ── Hook ─────────────────────────────────────────────────────────────

/**
 * Create a CRDT bridge for a specific cell.
 *
 * Returns:
 * - `extension` — a CodeMirror Extension to include in the editor
 * - `bridge` — the bridge instance (for imperative access if needed)
 *
 * The hook subscribes to the frame bus for inbound text attributions
 * targeting this cell. Cleanup is automatic on unmount.
 */
export function useCrdtBridge(cellId: string): {
  extension: Extension;
  bridge: CrdtBridge;
} {
  const ctx = useContext(CrdtBridgeContext);
  if (!ctx) {
    throw new Error("useCrdtBridge must be used within a CrdtBridgeProvider");
  }

  // Stable refs so the bridge config closures always read fresh values.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const bridge = useMemo(() => {
    return createCrdtBridge({
      getHandle: () => ctxRef.current.getHandle(),
      cellId,
      canWriteSource: () => ctxRef.current.canWriteSource?.(cellId) ?? true,
      onSourceChanged: (source: string) => {
        updateCellSourceById(cellId, source);
      },
      onSyncNeeded: () => {
        ctxRef.current.onSyncNeeded(cellId);
      },
    });
  }, [cellId]);

  // Subscribe to the frame bus for inbound text attributions.
  useEffect(() => {
    const unsubscribe = subscribeBroadcast((payload: unknown) => {
      if (!isTextAttributionEvent(payload)) {
        return;
      }

      logger.debug(
        `[crdt-bridge] text_attribution broadcast received: ${payload.attributions.length} attrs, looking for cell ${cellId.slice(0, 8)}`,
        payload.attributions.map(
          (a) =>
            `${a.cell_id.slice(0, 8)}: idx=${a.index} del=${a.deleted} text="${a.text.slice(0, 20)}"`,
        ),
      );

      // Filter to attributions for this cell, skipping self-echo.
      // When the UI's own edits echo back through the daemon (amplified
      // by other peers' sync rounds), they produce attributions where the
      // only actor is the local human actor. CodeMirror already has these
      // changes, so applying them again would corrupt the editor state.
      const localActor = ctxRef.current.localActor;
      const changes = remoteChangesFromTextAttributions(payload.attributions, cellId, localActor);

      if (changes.length > 0) {
        const view = bridge.getView();
        logger.debug(
          `[crdt-bridge] Applying ${changes.length} remote changes to cell ${cellId.slice(0, 8)}, view=${view ? "attached" : "NULL"}`,
          changes,
        );
        bridge.applyRemoteChanges(changes);
      }
    });

    return unsubscribe;
  }, [cellId, bridge]);

  return { extension: bridge.extension, bridge };
}
