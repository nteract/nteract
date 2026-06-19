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
