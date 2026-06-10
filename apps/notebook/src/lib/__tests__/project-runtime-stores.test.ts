import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  getCellExecutionId,
  getExecutionById,
  getNotebookQueueProjection,
  setCellExecutionPointer,
} from "../notebook-executions";
import { getOutputById } from "../notebook-outputs";
import {
  applyExecutionViewChangeset,
  applyOutputChangeset,
  getOutputProjectionFailures,
  resetRuntimeStoresProjection,
  seedOutputStoresFromHandle,
  subscribeOutputProjectionFailures,
} from "../project-runtime-stores";

afterEach(() => {
  resetRuntimeStoresProjection();
});

describe("applyExecutionViewChangeset", () => {
  it("upserts execution snapshots from the WASM materialized view", () => {
    applyExecutionViewChangeset({
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
    });

    expect(getExecutionById("exec-1")).toEqual({
      execution_count: 1,
      status: "running",
      success: null,
      output_ids: ["out-1"],
    });
  });

  it("applies cell execution pointer changes from NotebookDoc", () => {
    applyExecutionViewChangeset({
      cell_pointer_changes: [["cell-1", "exec-1"]],
    });
    expect(getCellExecutionId("cell-1")).toBe("exec-1");

    applyExecutionViewChangeset({
      cell_pointer_changes: [["cell-1", null]],
    });
    expect(getCellExecutionId("cell-1")).toBeNull();
  });

  it("evicts trimmed executions and clears matching cell pointers", () => {
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
    });
    setCellExecutionPointer("cell-1", "exec-1");
    expect(getExecutionById("exec-1")).toBeTruthy();

    applyExecutionViewChangeset({
      removed_execution_ids: ["exec-1"],
    });
    expect(getExecutionById("exec-1")).toBeUndefined();
    expect(getCellExecutionId("cell-1")).toBeNull();
  });

  it("applies notebook queue projection when WASM provides the adapter join", () => {
    applyExecutionViewChangeset({
      queue: {
        executing_execution_id: "exec-1",
        queued_execution_ids: ["exec-2"],
        notebook: {
          executing_cell_id: "cell-1",
          queued_cell_ids: ["cell-2"],
        },
      },
    });

    expect(getNotebookQueueProjection()).toEqual({
      executing_cell_id: "cell-1",
      queued_cell_ids: ["cell-2"],
    });
  });

  it("does not let eager notebook-output seeding overwrite runtime execution snapshots", () => {
    applyExecutionViewChangeset({
      execution_upserts: [
        [
          "exec-1",
          {
            execution_count: 7,
            status: "running",
            success: null,
            output_ids: ["out-runtime"],
          },
        ],
      ],
    });

    seedOutputStoresFromHandle(
      {
        get_cell_execution_id: () => "exec-1",
        get_cell_outputs: () => [{ output_id: "out-notebook", output_type: "stream" }],
      } as Parameters<typeof seedOutputStoresFromHandle>[0],
      ["cell-1"],
    );

    expect(getExecutionById("exec-1")).toEqual({
      execution_count: 7,
      status: "running",
      success: null,
      output_ids: ["out-runtime"],
    });
    expect(getOutputById("out-notebook")).toEqual({
      output_id: "out-notebook",
      output_type: "stream",
    });
  });
});

describe("applyOutputChangeset", () => {
  it("uses a supplied blob resolver for manifest-backed outputs", async () => {
    const fetch = vi.fn(async () => new Response("hello from cloud"));
    const blobResolver = {
      url: vi.fn((ref: { blob: string }) => `https://example.test/blob/${ref.blob}`),
      fetch,
    };

    await applyOutputChangeset(
      [
        [
          "out-1",
          {
            output_id: "out-1",
            output_type: "stream",
            name: "stdout",
            text: { blob: "blob-1", size: 16 },
          },
        ],
      ],
      [],
      { blobResolver },
    );

    expect(fetch).toHaveBeenCalledWith({ blob: "blob-1", size: 16 });
    expect(getOutputById("out-1")).toEqual({
      output_id: "out-1",
      output_type: "stream",
      name: "stdout",
      text: "hello from cloud",
    });
  });

  // FSB-1: failed resolutions are retried, then surfaced — never silently
  // stale.
  it("retries transient resolution failures before storing the output", async () => {
    let calls = 0;
    const blobResolver = {
      url: (ref: { blob: string }) => `https://example.test/blob/${ref.blob}`,
      fetch: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("blob server blip");
        return new Response("recovered");
      }),
    };

    await applyOutputChangeset(
      [
        [
          "out-retry",
          {
            output_id: "out-retry",
            output_type: "stream",
            name: "stdout",
            text: { blob: "blob-r", size: 9 },
          },
        ],
      ],
      [],
      { blobResolver, retryDelaysMs: [0] },
    );

    expect(blobResolver.fetch).toHaveBeenCalledTimes(2);
    expect(getOutputById("out-retry")).toMatchObject({ text: "recovered" });
    expect(getOutputProjectionFailures()).toEqual([]);
  });

  it("records a projection failure after retries are exhausted, and clears it on later success", async () => {
    const failing = {
      url: (ref: { blob: string }) => `https://example.test/blob/${ref.blob}`,
      fetch: vi.fn(async () => {
        throw new Error("persistent failure");
      }),
    };
    const manifest = {
      output_id: "out-fail",
      output_type: "stream",
      name: "stdout",
      text: { blob: "blob-f", size: 5 },
    };

    const failureEvents: number[] = [];
    const unsubscribe = subscribeOutputProjectionFailures(() => {
      failureEvents.push(getOutputProjectionFailures().length);
    });

    await applyOutputChangeset([["out-fail", manifest]], [], {
      blobResolver: failing,
      retryDelaysMs: [0],
    });

    expect(failing.fetch).toHaveBeenCalledTimes(2);
    expect(getOutputProjectionFailures()).toEqual(["out-fail"]);
    expect(getOutputById("out-fail")).toBeUndefined();

    // A later changeset tick that resolves the same output clears the entry.
    const recovering = {
      url: (ref: { blob: string }) => `https://example.test/blob/${ref.blob}`,
      fetch: vi.fn(async () => new Response("late success")),
    };
    await applyOutputChangeset([["out-fail", manifest]], [], {
      blobResolver: recovering,
      retryDelaysMs: [0],
    });

    expect(getOutputProjectionFailures()).toEqual([]);
    expect(getOutputById("out-fail")).toMatchObject({ text: "late success" });
    expect(failureEvents).toEqual([1, 0]);
    unsubscribe();
  });

  it("drops failure entries when the output is removed", async () => {
    const failing = {
      url: (ref: { blob: string }) => `https://example.test/blob/${ref.blob}`,
      fetch: vi.fn(async () => {
        throw new Error("persistent failure");
      }),
    };
    await applyOutputChangeset(
      [
        [
          "out-gone",
          {
            output_id: "out-gone",
            output_type: "stream",
            name: "stdout",
            text: { blob: "blob-g", size: 5 },
          },
        ],
      ],
      [],
      { blobResolver: failing, retryDelaysMs: [] },
    );
    expect(getOutputProjectionFailures()).toEqual(["out-gone"]);

    await applyOutputChangeset([], ["out-gone"], { blobResolver: failing });
    expect(getOutputProjectionFailures()).toEqual([]);
  });
});
