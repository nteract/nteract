import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vite-plus/test";

const require = createRequire(import.meta.url);
const { Session } = require("../src/session.cjs") as {
  Session: new (nativeSession: Record<string, unknown>) => {
    executionTransitions$: {
      subscribe: (observer: { next?: (value: unknown) => void }) => {
        unsubscribe: () => void;
      };
    };
    executionViewChanges$: {
      subscribe: (observer: { next?: (value: unknown) => void }) => {
        unsubscribe: () => void;
      };
    };
    getExecutionView: () => unknown;
    runCell: (source: string, options?: Record<string, unknown>) => Promise<unknown>;
    exportSnapshotPair: () => Promise<unknown>;
    close: () => Promise<void>;
  };
};

describe("@runtimed/node Session wrapper", () => {
  it("emits execution transitions keyed only by execution id", () => {
    let transitionCallback: ((json: string) => void) | null = null;
    const native = {
      notebookId: "nb-1",
      onExecutionTransition: vi.fn((callback: (json: string) => void) => {
        transitionCallback = callback;
        return { dispose: vi.fn() };
      }),
      close: vi.fn(async () => {}),
    };
    const session = new Session(native);
    const received: unknown[] = [];
    session.executionTransitions$.subscribe({ next: (value) => received.push(value) });

    transitionCallback?.(
      JSON.stringify({
        execution_id: "exec-1",
        kind: "started",
        execution_count: 4,
      }),
    );

    expect(received).toEqual([
      {
        execution_id: "exec-1",
        kind: "started",
        execution_count: 4,
      },
    ]);
    expect(received[0]).not.toHaveProperty("cell_id");
  });

  it("emits shared execution view changesets", () => {
    let viewCallback: ((json: string) => void) | null = null;
    const native = {
      notebookId: "nb-1",
      onExecutionViewChange: vi.fn((callback: (json: string) => void) => {
        viewCallback = callback;
        return { dispose: vi.fn() };
      }),
      close: vi.fn(async () => {}),
    };
    const session = new Session(native);
    const received: unknown[] = [];
    session.executionViewChanges$.subscribe({ next: (value) => received.push(value) });

    viewCallback?.(
      JSON.stringify({
        cell_pointer_changes: [["cell-1", "exec-1"]],
        execution_upserts: [
          [
            "exec-1",
            {
              execution_count: 1,
              status: "running",
              success: null,
              output_ids: ["out-1"],
            },
          ],
        ],
        queue: {
          executing_execution_id: "exec-1",
          queued_execution_ids: [],
          notebook: {
            executing_cell_id: "cell-1",
            queued_cell_ids: [],
          },
        },
      }),
    );

    expect(received).toEqual([
      {
        cell_pointer_changes: [["cell-1", "exec-1"]],
        execution_upserts: [
          [
            "exec-1",
            {
              execution_count: 1,
              status: "running",
              success: null,
              output_ids: ["out-1"],
            },
          ],
        ],
        queue: {
          executing_execution_id: "exec-1",
          queued_execution_ids: [],
          notebook: {
            executing_cell_id: "cell-1",
            queued_cell_ids: [],
          },
        },
      },
    ]);
    expect(session.getExecutionView()).toEqual({
      cell_execution_ids: {
        "cell-1": "exec-1",
      },
      executions: {
        "exec-1": {
          execution_count: 1,
          status: "running",
          success: null,
          output_ids: ["out-1"],
        },
      },
      queue: {
        executing_execution_id: "exec-1",
        queued_execution_ids: [],
        notebook: {
          executing_cell_id: "cell-1",
          queued_cell_ids: [],
        },
      },
    });
  });

  it("materializes execution view updates and returns defensive snapshots", () => {
    let viewCallback: ((json: string) => void) | null = null;
    const native = {
      notebookId: "nb-1",
      onExecutionViewChange: vi.fn((callback: (json: string) => void) => {
        viewCallback = callback;
        return { dispose: vi.fn() };
      }),
      close: vi.fn(async () => {}),
    };
    const session = new Session(native);

    viewCallback?.(
      JSON.stringify({
        cell_pointer_changes: [
          ["cell-1", "exec-1"],
          ["cell-2", "exec-2"],
        ],
        execution_upserts: [
          [
            "exec-1",
            {
              execution_count: 1,
              status: "done",
              success: true,
              output_ids: ["out-1"],
            },
          ],
          [
            "exec-2",
            {
              execution_count: 2,
              status: "queued",
              success: null,
              output_ids: [],
            },
          ],
        ],
        queue: {
          executing_execution_id: null,
          queued_execution_ids: ["exec-2"],
          notebook: {
            executing_cell_id: null,
            queued_cell_ids: ["cell-2"],
          },
        },
      }),
    );
    viewCallback?.(
      JSON.stringify({
        cell_pointer_changes: [["cell-1", null]],
        removed_execution_ids: ["exec-1"],
        queue: {
          executing_execution_id: "exec-2",
          queued_execution_ids: [],
          notebook: {
            executing_cell_id: "cell-2",
            queued_cell_ids: [],
          },
        },
      }),
    );

    const view = session.getExecutionView() as {
      cell_execution_ids: Record<string, string>;
      executions: Record<string, { output_ids: string[] }>;
      queue: { queued_execution_ids: string[] };
    };
    expect(view).toEqual({
      cell_execution_ids: {
        "cell-2": "exec-2",
      },
      executions: {
        "exec-2": {
          execution_count: 2,
          status: "queued",
          success: null,
          output_ids: [],
        },
      },
      queue: {
        executing_execution_id: "exec-2",
        queued_execution_ids: [],
        notebook: {
          executing_cell_id: "cell-2",
          queued_cell_ids: [],
        },
      },
    });

    view.cell_execution_ids["cell-3"] = "exec-3";
    view.executions["exec-2"].output_ids.push("mutated");
    view.queue.queued_execution_ids.push("exec-3");

    expect(session.getExecutionView()).toEqual({
      cell_execution_ids: {
        "cell-2": "exec-2",
      },
      executions: {
        "exec-2": {
          execution_count: 2,
          status: "queued",
          success: null,
          output_ids: [],
        },
      },
      queue: {
        executing_execution_id: "exec-2",
        queued_execution_ids: [],
        notebook: {
          executing_cell_id: "cell-2",
          queued_cell_ids: [],
        },
      },
    });
  });

  it("runCell with progress waits on the queued execution id", async () => {
    const native = {
      notebookId: "nb-1",
      queueCell: vi.fn(async () => ({
        cellId: "cell-1",
        executionId: "exec-1",
      })),
      waitForExecution: vi.fn(async () => ({
        cellId: "cell-1",
        executionId: "exec-1",
        status: "done",
        success: true,
        outputs: [],
      })),
      close: vi.fn(async () => {}),
    };
    const session = new Session(native);
    const onUpdate = vi.fn();

    const result = await session.runCell("print('node')", {
      timeoutMs: 123,
      onUpdate,
    });

    expect(native.queueCell).toHaveBeenCalledWith("print('node')", {
      timeoutMs: 123,
      onUpdate,
    });
    expect(native.waitForExecution).toHaveBeenCalledWith("exec-1", {
      timeoutMs: 123,
      cellId: "cell-1",
    });
    expect(result).toMatchObject({
      cellId: "cell-1",
      executionId: "exec-1",
      status: "done",
    });
  });

  it("passes snapshot pair export through to the native session", async () => {
    const snapshot = {
      notebookId: "nb-1",
      notebookBytes: new Uint8Array([1, 2, 3]),
      runtimeStateBytes: new Uint8Array([4, 5, 6]),
      commsDocBytes: new Uint8Array([7, 8, 9]),
      notebookHeads: ["a"],
      runtimeStateHeads: ["b"],
      commsDocHeads: ["c"],
      blobBaseUrl: "http://127.0.0.1:1234",
      blobStorePath: "/tmp/runtimed-blobs",
    };
    const native = {
      notebookId: "nb-1",
      exportSnapshotPair: vi.fn(async () => snapshot),
      close: vi.fn(async () => {}),
    };
    const session = new Session(native);

    await expect(session.exportSnapshotPair()).resolves.toBe(snapshot);
    expect(native.exportSnapshotPair).toHaveBeenCalledTimes(1);
  });
});
