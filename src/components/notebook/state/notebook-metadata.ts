import { useSyncExternalStore } from "react";
import type { NotebookMetadataStore } from "runtimed";

/** Shared React read binding; metadata and handle lifetime stay outside React. */
export function useNotebookMetadataStore<T>(store: NotebookMetadataStore<T>): T | null {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
