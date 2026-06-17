/**
 * Cursor registry — connects presence events from the frame bus to
 * CodeMirror EditorViews via direct StateEffect dispatch.
 *
 * This is the hot path for remote cursor rendering. No React involvement:
 * presence events arrive synchronously from the frame bus and are dispatched
 * as CodeMirror StateEffects to registered EditorViews.
 */

import { setRemoteCursors, setRemoteSelections } from "@/components/editor/remote-cursors";
import { RemotePresenceState, type PeerCursorInfo } from "@/components/editor/presence-state";
import { logger } from "@/lib/logger";
import { getAllCellEditors, getCellEditor } from "./state/editor-registry";
import { subscribePresence } from "./state/notebook-frame-bus";

export type { PeerCursorInfo } from "@/components/editor/presence-state";

const presenceState = new RemotePresenceState();

/** Map of cellId -> Set of subscriber callbacks. */
const cellSubscribers = new Map<string, Set<() => void>>();

/**
 * Called when a cell editor is registered via editor-registry.
 * Immediately render any existing cursors for this cell.
 */
export function onEditorRegistered(cellId: string): void {
  dispatchToCell(cellId);
}

/**
 * Called when a cell editor is unregistered.
 * Clears peer state referencing that cell.
 */
export function onEditorUnregistered(cellId: string): void {
  const affectedCells = presenceState.clearCell(cellId);
  if (affectedCells.size > 0) {
    notifyCellSubscribers(affectedCells);
  }
}

function dispatchToCell(cellId: string): void {
  const view = getCellEditor(cellId);
  if (!view) {
    logger.debug(`[cursor-registry] dispatchToCell: no view for ${cellId}`);
    return;
  }

  const { cursors, selections } = presenceState.presenceForCell(cellId);

  logger.debug(
    `[cursor-registry] dispatchToCell ${cellId}: ${cursors.length} cursors, ${selections.length} selections`,
  );
  setRemoteCursors(view, cursors);
  setRemoteSelections(view, selections);
}

function dispatchToAffectedCells(affectedCellIds: Set<string>): void {
  for (const cellId of affectedCellIds) {
    dispatchToCell(cellId);
  }
  notifyCellSubscribers(affectedCellIds);
}

function handlePresence(payload: unknown): void {
  const affectedCells = presenceState.handlePresence(payload);
  dispatchToAffectedCells(affectedCells);
}

const RECONCILE_INTERVAL_MS = 5_000;

/**
 * Start dispatching presence events to registered CodeMirror EditorViews.
 *
 * @param peerId The local peer's ID, excluded from remote cursor rendering.
 */
export function startCursorDispatch(peerId: string): () => void {
  presenceState.setLocalPeerId(peerId);

  const unsubscribe = subscribePresence(handlePresence);

  // Periodic reconciliation self-heals if individual update messages were
  // lost, misordered, or if rendering diverged from canonical peer state.
  const reconcileTimer = setInterval(() => {
    for (const cellId of getAllCellEditors().keys()) {
      dispatchToCell(cellId);
    }
  }, RECONCILE_INTERVAL_MS);

  return () => {
    unsubscribe();
    clearInterval(reconcileTimer);
    presenceState.setLocalPeerId(null);
    presenceState.clear();

    for (const [, view] of getAllCellEditors()) {
      setRemoteCursors(view, []);
      setRemoteSelections(view, []);
    }
    cellSubscribers.clear();
  };
}

/**
 * Find a connected peer's color by exact actor-label match.
 *
 * Presence carries the same actor label used by CRDT attribution, so cursor
 * colors can line up with text attribution without fuzzy label matching.
 */
export function findPeerColorByActorLabel(actorLabel: string): string | undefined {
  return presenceState.findPeerColorByActorLabel(actorLabel);
}

/**
 * Find a connected peer's friendly label by exact actor-label match.
 *
 * Lets comment authors render by the name presence shows (e.g. "Claude Code")
 * instead of the raw actor label's operator kind. Returns undefined when the
 * author is not currently connected.
 */
export function findPeerLabelByActorLabel(actorLabel: string): string | undefined {
  return presenceState.findPeerLabelByActorLabel(actorLabel);
}

/**
 * Get all remote peers that have a cursor or focus in the given cell.
 */
export function getPeersForCell(cellId: string): PeerCursorInfo[] {
  return presenceState.getPeersForCell(cellId);
}

/**
 * Subscribe to presence changes for a specific cell.
 */
export function subscribeToCell(cellId: string, callback: () => void): () => void {
  let subs = cellSubscribers.get(cellId);
  if (!subs) {
    subs = new Set();
    cellSubscribers.set(cellId, subs);
  }
  subs.add(callback);

  return () => {
    subs?.delete(callback);
    if (subs?.size === 0) {
      cellSubscribers.delete(cellId);
    }
  };
}

function notifyCellSubscribers(cellIds: Set<string>): void {
  for (const cellId of cellIds) {
    const subs = cellSubscribers.get(cellId);
    if (subs) {
      for (const cb of subs) {
        cb();
      }
    }
  }
}
