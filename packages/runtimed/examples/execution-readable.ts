import type { ExecutionSnapshot, NotebookExecutionStore } from "../src/execution-store";

/**
 * Svelte's readable-store contract over one execution. The host owns the
 * notebook store and feeds it changesets; this adapter owns no notebook state.
 * Create it once for an execution ID, not during each render.
 */
export function executionReadable(store: NotebookExecutionStore, executionId: string) {
  return {
    subscribe(run: (snapshot: ExecutionSnapshot | undefined) => void): () => void {
      const publish = () => run(store.getExecutionById(executionId));
      const unsubscribe = store.subscribeExecutionById(executionId)(publish);
      try {
        publish(); // Svelte requires synchronous initial delivery.
      } catch (error) {
        unsubscribe();
        throw error;
      }
      return unsubscribe;
    },
  };
}
