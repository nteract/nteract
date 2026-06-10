import { useMemo, useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// Output-focus state store.
//
// Tracks which cell currently owns "output focus" — the wheel-scroll owner
// and iframe focus ring. At most one cell is output-focused at a time.
//
// Uses direct emit (not the deferred-flush pattern in cell-ui-state.ts)
// because writes always originate from event handlers, never from a render
// pass.
// ---------------------------------------------------------------------------

let _outputFocusedCellId: string | null = null;
const _subscribers = new Set<() => void>();

function emit(): void {
  for (const cb of _subscribers) cb();
}

// ── Setters ─────────────────────────────────────────────────────────────

/** Set the output-focused cell. No-op when the cell is already focused. */
export function setOutputFocusedCellId(cellId: string): void {
  if (_outputFocusedCellId === cellId) return;
  _outputFocusedCellId = cellId;
  emit();
}

/**
 * Clear output focus.
 *
 * When `fromCellId` is provided, only clears if that cell is currently
 * focused — matching the `setOutputFocusedCellId((current) => current === id
 * ? null : current)` functional-updater pattern.
 */
export function clearOutputFocusedCellId(fromCellId?: string): void {
  if (fromCellId !== undefined && _outputFocusedCellId !== fromCellId) return;
  if (_outputFocusedCellId === null) return;
  _outputFocusedCellId = null;
  emit();
}

// ── Snapshot readers (non-reactive) ─────────────────────────────────────

export function getOutputFocusedCellId(): string | null {
  return _outputFocusedCellId;
}

// ── Hooks ────────────────────────────────────────────────────────────────

/** Subscribe to the output-focused cell ID. Re-renders on every change. */
export function useOutputFocusedCellId(): string | null {
  return useSyncExternalStore(subscribeAll, getOutputFocusedCellId);
}

/** Returns true only when this specific cell is output-focused. */
export function useIsCellOutputFocused(cellId: string): boolean {
  const sub = useMemo(() => subscribeFor(cellId), [cellId]);
  const snap = useMemo(() => getIsOutputFocusedSnapshot(cellId), [cellId]);
  return useSyncExternalStore(sub, snap);
}

/** Returns true when another cell is output-focused (this cell is dimmed). */
export function useIsCellOutputDimmed(cellId: string): boolean {
  const sub = useMemo(() => subscribeFor(cellId), [cellId]);
  const snap = useMemo(() => getIsOutputDimmedSnapshot(cellId), [cellId]);
  return useSyncExternalStore(sub, snap);
}

// ── Subscription helpers ─────────────────────────────────────────────────

function subscribeAll(cb: () => void): () => void {
  _subscribers.add(cb);
  return () => _subscribers.delete(cb);
}

// Per-cell subscriptions still listen to the global set — but snapshot
// returns a boolean so useSyncExternalStore only re-renders when the
// boolean flips for that specific cell.
function subscribeFor(_cellId: string): (cb: () => void) => () => void {
  return (cb: () => void) => {
    _subscribers.add(cb);
    return () => _subscribers.delete(cb);
  };
}

function getIsOutputFocusedSnapshot(cellId: string): () => boolean {
  let prev = _outputFocusedCellId === cellId;
  return () => {
    const next = _outputFocusedCellId === cellId;
    if (next !== prev) prev = next;
    return prev;
  };
}

function getIsOutputDimmedSnapshot(cellId: string): () => boolean {
  let prev = _outputFocusedCellId !== null && _outputFocusedCellId !== cellId;
  return () => {
    const next = _outputFocusedCellId !== null && _outputFocusedCellId !== cellId;
    if (next !== prev) prev = next;
    return prev;
  };
}
