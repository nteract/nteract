import { useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// Assistant side-panel open/closed state.
//
// A hand-rolled `useSyncExternalStore` module store, mirroring the notebook
// rail's `rail-ui-state.ts`. The assistant panel mounts on the right of the
// document shell and is toggled from the toolbar; a single boolean is all the
// UI state it needs.
// ---------------------------------------------------------------------------

let open = false;
const subscribers = new Set<() => void>();

function emit(): void {
  for (const callback of subscribers) callback();
}

function subscribe(callback: () => void): () => void {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

function getSnapshot(): boolean {
  return open;
}

/** React hook — re-renders when the assistant panel opens or closes. */
export function useAssistantPanelOpen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function setAssistantPanelOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  emit();
}

export function toggleAssistantPanel(): void {
  setAssistantPanelOpen(!open);
}

/** @internal Reset for test isolation. */
export function _testResetAssistantPanel(): void {
  open = false;
  subscribers.clear();
}
