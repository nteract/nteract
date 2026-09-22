import { describe, expect, it } from "vite-plus/test";
import { executionReadable } from "../examples/execution-readable";
import { createNotebookExecutionStore, type ExecutionSnapshot } from "../src/execution-store";

describe("Svelte execution readable example", () => {
  it("delivers current state immediately, follows updates, and unsubscribes", () => {
    const store = createNotebookExecutionStore();
    store.setExecution("e", {
      execution_count: 1,
      status: "running",
      success: null,
      output_ids: [],
    });
    const readable = executionReadable(store, "e");
    const seen: (ExecutionSnapshot | undefined)[] = [];
    const stop = readable.subscribe((value) => seen.push(value));
    expect(seen).toEqual([store.getExecutionById("e")]);
    store.setExecution("other", {
      execution_count: 2,
      status: "done",
      success: true,
      output_ids: [],
    });
    expect(seen).toHaveLength(1);
    store.deleteExecutions(["e"]);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeUndefined();
    stop();
    store.setExecution("e", { execution_count: 3, status: "done", success: true, output_ids: [] });
    expect(seen).toHaveLength(2);
  });
});
