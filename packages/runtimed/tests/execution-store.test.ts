import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vite-plus/test";
import { createNotebookExecutionStore, type ExecutionViewSnapshot } from "../src/execution-store";

const require = createRequire(import.meta.url);
const compiled =
  require("../../runtimed-node/src/execution-store.cjs") as typeof import("../src/execution-store");
const snap = (overrides: Partial<ExecutionViewSnapshot> = {}): ExecutionViewSnapshot => ({
  execution_count: 1,
  status: "running",
  success: null,
  output_ids: ["o1"],
  ...overrides,
});

describe.each([
  ["TypeScript", createNotebookExecutionStore],
  ["published CommonJS", compiled.createNotebookExecutionStore],
] as const)("execution store (%s)", (_name, create) => {
  it("isolates notebooks and owns immutable input snapshots", () => {
    const a = create(),
      b = create(),
      input = snap();
    a.setExecution("e", input);
    const first = a.getExecutionById("e")!;
    input.output_ids.push("external");
    input.status = "error";
    expect(first.output_ids).toEqual(["o1"]);
    expect(first.status).toBe("running");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.output_ids)).toBe(true);
    expect(b.getExecutionById("e")).toBeUndefined();
    expect(a.getCellExecutionId("c")).toBeNull();
  });

  it("retains identity on no-ops and shares unchanged membership across status changes", () => {
    const store = create();
    store.setExecution("e", snap());
    const first = store.getExecutionById("e")!,
      view = store.getSnapshot();
    store.setExecution("e", snap());
    expect(store.getSnapshot()).toBe(view);
    store.setExecution("e", snap({ status: "done", success: true }));
    expect(store.getExecutionById("e")!.output_ids).toBe(first.output_ids);
    expect(store.getSnapshot()).not.toBe(view);
    expect(view.executions.e).toBe(first);
    expect(first.status).toBe("running");
    store.setExecution("e", snap({ output_ids: ["o1", "o2"] }));
    expect(store.getExecutionById("e")!.output_ids).not.toBe(first.output_ids);
  });

  it("keeps status invalidation local and invalidates structure for counts and membership", () => {
    const store = create();
    store.setExecution("e", snap());
    const entity = vi.fn(),
      other = vi.fn(),
      structure = vi.fn();
    store.subscribeExecutionById("e")(entity);
    store.subscribeExecutionById("other")(other);
    store.subscribeExecutionStructureVersion(structure);
    store.setExecution("e", snap({ status: "done" }));
    expect(entity).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    expect(structure).not.toHaveBeenCalled();
    store.setExecution("e", snap({ execution_count: 2 }));
    store.setExecution("e", snap({ execution_count: 2, output_ids: ["o2"] }));
    expect(structure).toHaveBeenCalledTimes(2);
  });

  it("invalidates the aggregate before notifying and supports nested writes", () => {
    const store = create();
    store.setExecution("e", snap());
    const before = store.getSnapshot();
    const views: ReturnType<typeof store.getSnapshot>[] = [];
    store.subscribeExecutionById("e")(() => {
      views.push(store.getSnapshot());
      if (store.getExecutionById("e")!.status === "done")
        store.setExecution("e", snap({ status: "error" }));
    });
    store.setExecution("e", snap({ status: "done" }));
    expect(views.map((v) => v.executions.e.status)).toEqual(["done", "error"]);
    expect(before.executions.e.status).toBe("running");
    expect(store.getSnapshot()).toBe(views[1]);
  });

  it("clears removed current pointers before callbacks, including pointers without snapshots", () => {
    const store = create();
    store.setExecution("e", snap());
    store.setCellExecutionPointer("c", "e");
    const seen: unknown[] = [];
    store.subscribeExecutionById("e")(() =>
      seen.push([store.getExecutionById("e"), store.getCellExecutionId("c")]),
    );
    store.deleteExecutions(["e"]);
    expect(seen).toEqual([[undefined, null]]);
    store.setCellExecutionPointer("c", "pending");
    store.deleteExecutions(["pending"]);
    expect(store.getCellExecutionId("c")).toBeNull();
    store.setCellExecutionPointer("c", "new");
    store.deleteExecutions(["old"]);
    expect(store.getCellExecutionId("c")).toBe("new");
  });

  it("preserves runtime ownership even for equal upserts and resets state before delivery", () => {
    const store = create();
    store.setExecution("e", snap());
    store.applyChangeset({
      execution_upserts: [["e", snap()]],
      cell_pointer_changes: [["c", "e"]],
    });
    expect(store.isExecutionRuntimeOwned("e")).toBe(true);
    const seen: unknown[] = [];
    store.subscribeCellExecutionPointer("c")(() => seen.push(store.getSnapshot()));
    store.resetNotebookExecutions();
    expect(seen).toEqual([{ cell_execution_ids: {}, executions: {}, queue: null }]);
    expect(store.isExecutionRuntimeOwned("e")).toBe(false);
  });

  it("distinguishes absent queue updates from clearing the notebook projection", () => {
    const store = create();
    const queue = {
      executing_execution_id: "e",
      queued_execution_ids: ["e2"],
      notebook: { executing_cell_id: "c", queued_cell_ids: ["c2"] },
    };
    store.applyChangeset({ queue });
    const first = store.getSnapshot();
    store.applyChangeset({ queue });
    expect(store.getSnapshot()).toBe(first);
    queue.queued_execution_ids.push("mutated");
    queue.notebook.queued_cell_ids.push("mutated");
    expect(first.queue!.queued_execution_ids).toEqual(["e2"]);
    expect(store.getNotebookQueueProjection().queued_cell_ids).toEqual(["c2"]);
    store.applyChangeset({});
    expect(store.getSnapshot()).toBe(first);
    store.applyChangeset({ queue: { queued_execution_ids: [] } });
    expect(store.getNotebookQueueProjection()).toEqual({
      executing_cell_id: null,
      queued_cell_ids: [],
    });
    store.applyChangeset({ queue: null });
    expect(store.getSnapshot().queue).toBeNull();
  });

  it("isolates listener errors, honors unsubscribe, and defers newly added listeners", () => {
    const store = create();
    const late = vi.fn(),
      removed = vi.fn();
    let stop = () => {};
    store.subscribeExecutionById("e")(() => {
      stop();
      store.subscribeExecutionById("e")(late);
      throw Error("listener");
    });
    stop = store.subscribeExecutionById("e")(removed);
    store.setExecution("e", snap());
    expect(removed).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
    store.setExecution("e", snap({ status: "done" }));
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("retains a newer subscription when an older unsubscribe is called twice", () => {
    const store = create(),
      seen = vi.fn();
    const old = store.subscribeExecutionById("e")(() => {});
    old();
    store.subscribeExecutionById("e")(seen);
    old();
    store.setExecution("e", snap());
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
