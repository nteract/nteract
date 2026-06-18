/**
 * External store for the comments projection, consumed via useSyncExternalStore.
 *
 * The projection is derived notebook state. It is fed from two places that both
 * push here, so React reads a single source instead of a useState mirror:
 *   - the sync engine's `commentsProjection$` (remote/daemon updates), and
 *   - an optimistic read after a local mutation (the observable does not emit
 *     for local writes, so the caller refreshes to reflect its own action).
 *
 * Fully eliminating the optimistic refresh would require the engine to emit a
 * projection on local comments-doc changes; until then this keeps the snapshot
 * authoritative and reference-stable for useSyncExternalStore.
 */

import { useSyncExternalStore } from "react";
import type { CommentsProjection } from "runtimed";

let snapshot: CommentsProjection | null = null;
const listeners = new Set<() => void>();

/** Replace the current projection snapshot and notify subscribers. */
export function setCommentsProjectionSnapshot(next: CommentsProjection | null): void {
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): CommentsProjection | null {
  return snapshot;
}

/** Subscribe a component to the comments projection. */
export function useCommentsProjection(): CommentsProjection | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
