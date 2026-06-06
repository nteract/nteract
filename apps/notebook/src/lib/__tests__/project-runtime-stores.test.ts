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
  resetRuntimeStoresProjection,
  seedOutputStoresFromHandle,
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
});
