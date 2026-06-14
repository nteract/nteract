import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  getCellExecutionId,
  getExecutionById,
  getNotebookQueueProjection,
  isExecutionRuntimeOwned,
} from "@/components/notebook/state/execution-store";
import { getOutputById } from "@/components/notebook/state/output-store";
import {
  applyExecutionViewChangeset,
  applyOutputChangeset,
  getOutputProjectionFailures,
  resetRuntimeStoresProjection,
  subscribeOutputProjectionFailures,
} from "@/components/notebook/state/runtime-store-projection";

afterEach(() => {
  resetRuntimeStoresProjection();
});

describe("runtime store projection", () => {
  it("upserts runtime-owned execution snapshots and reports them to observers", () => {
    const observed: string[] = [];

    applyExecutionViewChangeset(
      {
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
      },
      {
        onExecutionSnapshot: (executionId, snapshot) => {
          observed.push(`${executionId}:${snapshot.status}:${snapshot.output_ids.length}`);
        },
      },
    );

    expect(getExecutionById("exec-1")).toEqual({
      execution_count: 1,
      status: "running",
      success: null,
      output_ids: ["out-1"],
    });
    expect(isExecutionRuntimeOwned("exec-1")).toBe(true);
    expect(observed).toEqual(["exec-1:running:1"]);
  });

  it("applies execution pointers, removals, and queue projection", () => {
    applyExecutionViewChangeset({
      execution_upserts: [
        [
          "exec-1",
          {
            execution_count: 1,
            status: "done",
            success: true,
            output_ids: [],
          },
        ],
      ],
      cell_pointer_changes: [["cell-1", "exec-1"]],
      queue: {
        executing_execution_id: "exec-1",
        queued_execution_ids: [],
        notebook: {
          executing_cell_id: "cell-1",
          queued_cell_ids: ["cell-2"],
        },
      },
    });

    expect(getCellExecutionId("cell-1")).toBe("exec-1");
    expect(getNotebookQueueProjection()).toEqual({
      executing_cell_id: "cell-1",
      queued_cell_ids: ["cell-2"],
    });

    applyExecutionViewChangeset({ removed_execution_ids: ["exec-1"] });

    expect(getExecutionById("exec-1")).toBeUndefined();
    expect(getCellExecutionId("cell-1")).toBeNull();
    expect(isExecutionRuntimeOwned("exec-1")).toBe(false);
  });

  it("surfaces output projection failures and clears them on removal", async () => {
    const failureEvents: number[] = [];
    const unsubscribe = subscribeOutputProjectionFailures(() => {
      failureEvents.push(getOutputProjectionFailures().length);
    });

    await applyOutputChangeset(
      [
        [
          "out-fail",
          {
            output_id: "out-fail",
            output_type: "stream",
            name: "stdout",
            text: { blob: "blob-f", size: 5 },
          },
        ],
      ],
      [],
      { blobResolver: null },
    );

    expect(getOutputProjectionFailures()).toEqual(["out-fail"]);
    await applyOutputChangeset([], ["out-fail"]);

    expect(getOutputProjectionFailures()).toEqual([]);
    expect(failureEvents).toEqual([1, 0]);
    unsubscribe();
  });

  it("reset invalidates suspended output projection writes", async () => {
    let releaseFirstAttempt: (() => void) | undefined;
    const firstAttemptStarted = new Promise<void>((resolve) => {
      releaseFirstAttempt = () => resolve();
    });
    let failFirst = true;
    const blobResolver = {
      url: (ref: { blob: string }) => `https://example.test/blob/${ref.blob}`,
      fetch: vi.fn(async () => {
        if (failFirst) {
          failFirst = false;
          releaseFirstAttempt?.();
          throw new Error("transient");
        }
        return new Response("stale payload");
      }),
    };

    const suspendedProjection = applyOutputChangeset(
      [
        [
          "out-stale",
          {
            output_id: "out-stale",
            output_type: "stream",
            name: "stdout",
            text: { blob: "blob-stale", size: 13 },
          },
        ],
      ],
      [],
      { blobResolver, retryDelaysMs: [20] },
    );

    await firstAttemptStarted;
    resetRuntimeStoresProjection();
    await suspendedProjection;

    expect(getOutputById("out-stale")).toBeUndefined();
    expect(getOutputProjectionFailures()).toEqual([]);
  });
});
