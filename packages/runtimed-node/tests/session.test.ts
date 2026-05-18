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
    runCell: (source: string, options?: Record<string, unknown>) => Promise<unknown>;
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
});
