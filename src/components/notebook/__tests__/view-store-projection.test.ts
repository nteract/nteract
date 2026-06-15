import { afterEach, describe, expect, it } from "vite-plus/test";
import type { JupyterOutput } from "@/components/cell/jupyter-output";
import {
  getCellById,
  getCellIdsSnapshot,
  resetNotebookCells,
} from "@/components/notebook/state/cell-store";
import {
  getCellExecutionId,
  getExecutionById,
  getNotebookQueueProjection,
  markExecutionsRuntimeOwned,
  resetNotebookExecutions,
  setExecution,
  setNotebookQueueProjection,
} from "@/components/notebook/state/execution-store";
import { getOutputById, resetNotebookOutputs } from "@/components/notebook/state/output-store";
import { createNotebookViewStoreProjector } from "@/components/notebook/state/view-store-projection";
import { setMarkdownProjectionProjector } from "@/lib/markdown-projection";

let restoreMarkdownProjectionProjector: (() => void) | undefined;

afterEach(() => {
  restoreMarkdownProjectionProjector?.();
  restoreMarkdownProjectionProjector = undefined;
  resetNotebookCells();
  resetNotebookExecutions();
  resetNotebookOutputs();
});

describe("NotebookViewStoreProjector", () => {
  it("projects materialized cells into the shared cell, execution, and output stores", () => {
    restoreMarkdownProjectionProjector = setMarkdownProjectionProjector(testMarkdownProjector);
    const projector = createNotebookViewStoreProjector({
      syntheticExecutionId: (cellId) => `projection-execution:${cellId}`,
    });

    projector.projectCells([
      {
        id: "intro",
        cellType: "markdown",
        source: "# Projected title",
        executionId: null,
        executionCount: null,
        outputs: [],
        metadata: { tags: ["doc"] },
      },
      {
        id: "code",
        cellType: "code",
        source: "print('hello')",
        executionId: null,
        executionCount: 12,
        outputs: [
          {
            output_id: "out-code-stdout",
            output_type: "stream",
            name: "stdout",
            text: ["hello", "\n"],
          },
        ],
        metadata: {},
      },
    ]);

    expect(getCellIdsSnapshot()).toEqual(["intro", "code"]);
    expect(getCellById("intro")).toMatchObject({
      cell_type: "markdown",
      source: "# Projected title",
      metadata: { tags: ["doc"] },
    });
    expect(getCellById("intro")).toHaveProperty("markdownProjection");
    expect(getCellExecutionId("code")).toBe("projection-execution:code");
    expect(getExecutionById("projection-execution:code")).toEqual({
      execution_count: 12,
      status: "done",
      success: null,
      output_ids: ["out-code-stdout"],
    });
    expect(getOutputById("out-code-stdout")).toEqual({
      output_id: "out-code-stdout",
      output_type: "stream",
      name: "stdout",
      text: "hello\n",
    });
  });

  it("keeps projector-owned execution records across repeated projections", () => {
    const projector = createNotebookViewStoreProjector({
      syntheticExecutionId: (cellId) => `projection-execution:${cellId}`,
    });
    const cells = [codeCellWithIdentifiedOutput("code", "out-code-stdout", "hello\n")];

    projector.projectCells(cells);
    projector.projectCells(cells);

    expect(getCellExecutionId("code")).toBe("projection-execution:code");
    expect(getExecutionById("projection-execution:code")).toEqual({
      execution_count: 1,
      status: "done",
      success: null,
      output_ids: ["out-code-stdout"],
    });
    expect(getOutputById("out-code-stdout")).toBeDefined();
  });

  it("projects missing output IDs as visible invariant errors", () => {
    const projector = createNotebookViewStoreProjector({
      syntheticExecutionId: (cellId) => `projection-execution:${cellId}`,
    });

    projector.projectCells([codeCellWithoutOutputId("legacy-code", "legacy output\n")]);

    const errorOutputId = "resolution-error:missing-output-id:legacy-code:0";
    expect(getCellExecutionId("legacy-code")).toBe("projection-execution:legacy-code");
    expect(getExecutionById("projection-execution:legacy-code")?.output_ids).toEqual([
      errorOutputId,
    ]);
    expect(getOutputById(errorOutputId)).toMatchObject({
      output_id: errorOutputId,
      output_type: "error",
      ename: "OutputProjectionError",
    });
    expect(getOutputById(errorOutputId)?.evalue).toMatch(/without output_id/);
  });

  it("preserves RuntimeStateDoc-owned queue and execution snapshots", () => {
    const projector = createNotebookViewStoreProjector({
      syntheticExecutionId: (cellId) => `projection-execution:${cellId}`,
    });
    setNotebookQueueProjection({
      executing_cell_id: "running-cell",
      queued_cell_ids: ["queued-cell"],
    });
    setExecution("exec-real", {
      execution_count: 7,
      status: "running",
      success: null,
      output_ids: ["runtime-output"],
    });

    projector.projectCells([
      {
        id: "running-cell",
        cellType: "code",
        source: "print('runtime-owned')",
        executionId: "exec-real",
        executionCount: 3,
        outputs: [],
        metadata: {},
      },
    ]);

    expect(getNotebookQueueProjection()).toEqual({
      executing_cell_id: "running-cell",
      queued_cell_ids: ["queued-cell"],
    });
    expect(getExecutionById("exec-real")).toEqual({
      execution_count: 7,
      status: "running",
      success: null,
      output_ids: ["runtime-output"],
    });
  });

  it("cleans real-id display placeholders created by the projector", () => {
    const projector = createNotebookViewStoreProjector();

    projector.projectCells([
      {
        id: "cell-1",
        cellType: "code",
        source: "print('snapshot')",
        executionId: "exec-from-notebook-doc",
        executionCount: 3,
        outputs: [
          {
            output_id: "out-from-notebook-doc",
            output_type: "stream",
            name: "stdout",
            text: "snapshot\n",
          },
        ],
        metadata: {},
      },
    ]);

    expect(getCellExecutionId("cell-1")).toBe("exec-from-notebook-doc");
    expect(getExecutionById("exec-from-notebook-doc")).toEqual({
      execution_count: 3,
      status: "done",
      success: null,
      output_ids: ["out-from-notebook-doc"],
    });

    projector.reset();

    expect(getCellExecutionId("cell-1")).toBe(null);
    expect(getExecutionById("exec-from-notebook-doc")).toBeUndefined();
    expect(getOutputById("out-from-notebook-doc")).toBeUndefined();
  });

  it("releases ownership when RuntimeStateDoc authors a seeded execution id", () => {
    const projector = createNotebookViewStoreProjector();

    projector.projectCells([
      {
        id: "cell-1",
        cellType: "code",
        source: "print('snapshot')",
        executionId: "exec-runtime-late",
        executionCount: 3,
        outputs: [
          {
            output_id: "out-placeholder",
            output_type: "stream",
            name: "stdout",
            text: "snapshot\n",
          },
        ],
        metadata: {},
      },
    ]);

    markExecutionsRuntimeOwned(["exec-runtime-late"]);
    setExecution("exec-runtime-late", {
      execution_count: 4,
      status: "running",
      success: null,
      output_ids: ["out-runtime"],
    });

    projector.projectCells([
      {
        id: "cell-1",
        cellType: "code",
        source: "print('live')",
        executionId: "exec-runtime-late",
        executionCount: 4,
        outputs: [
          {
            output_id: "out-runtime",
            output_type: "stream",
            name: "stdout",
            text: "live\n",
          },
        ],
        metadata: {},
      },
    ]);
    projector.cleanupRemovedCells(["cell-1"]);

    expect(getCellExecutionId("cell-1")).toBe(null);
    expect(getExecutionById("exec-runtime-late")).toEqual({
      execution_count: 4,
      status: "running",
      success: null,
      output_ids: ["out-runtime"],
    });
    expect(getOutputById("out-placeholder")).toBeUndefined();
  });

  it("reuses stamped output references without serializing them", () => {
    const projector = createNotebookViewStoreProjector({
      syntheticExecutionId: (cellId) => `projection-execution:${cellId}`,
    });

    projector.projectCells([codeCellWithStampedOutput("widget-cell", "output:widget:1:0", "one")]);
    const firstOutput = getOutputById("widget-output");
    expect(firstOutput).toBeDefined();
    expect(firstOutput).not.toHaveProperty("_runt_output_cache_key");

    projector.projectCells([codeCellWithStampedOutput("widget-cell", "output:widget:1:0", "two")]);

    expect(getOutputById("widget-output")).toBe(firstOutput);
    const cell = getCellById("widget-cell");
    expect(cell?.cell_type).toBe("code");
    if (cell?.cell_type === "code") {
      expect(cell.outputs[0]).toBe(firstOutput);
    }
  });

  it("cleans only projector-owned executions and outputs for removed cells", () => {
    const projector = createNotebookViewStoreProjector({
      syntheticExecutionId: (cellId) => `projection-execution:${cellId}`,
    });

    projector.projectCells([
      codeCellWithIdentifiedOutput("removed-cell", "out-removed", "gone"),
      codeCellWithIdentifiedOutput("kept-cell", "out-kept", "still here"),
    ]);

    expect(getExecutionById("projection-execution:removed-cell")).toBeDefined();
    expect(getOutputById("out-removed")).toBeDefined();

    projector.cleanupRemovedCells(["removed-cell"]);

    expect(getCellExecutionId("removed-cell")).toBe(null);
    expect(getExecutionById("projection-execution:removed-cell")).toBeUndefined();
    expect(getOutputById("out-removed")).toBeUndefined();
    expect(getCellExecutionId("kept-cell")).toBe("projection-execution:kept-cell");
    expect(getExecutionById("projection-execution:kept-cell")).toBeDefined();
    expect(getOutputById("out-kept")).toBeDefined();
  });
});

function codeCellWithStampedOutput(cellId: string, cacheKey: string, text: string) {
  return {
    id: cellId,
    cellType: "code" as const,
    source: "display(value)",
    executionId: null,
    executionCount: 1,
    outputs: [
      {
        output_id: "widget-output",
        output_type: "display_data",
        data: { "text/plain": text },
        metadata: {},
        _runt_output_cache_key: cacheKey,
        toJSON() {
          throw new Error("stamped output should not be stringified");
        },
      } as JupyterOutput & Record<string, unknown>,
    ],
    metadata: {},
  };
}

function codeCellWithIdentifiedOutput(cellId: string, outputId: string, text: string) {
  return {
    id: cellId,
    cellType: "code" as const,
    source: "print(value)",
    executionId: null,
    executionCount: 1,
    outputs: [
      {
        output_id: outputId,
        output_type: "stream" as const,
        name: "stdout" as const,
        text,
      },
    ],
    metadata: {},
  };
}

function codeCellWithoutOutputId(cellId: string, text: string) {
  return {
    id: cellId,
    cellType: "code" as const,
    source: "print(value)",
    executionId: null,
    executionCount: 1,
    outputs: [
      {
        output_type: "stream" as const,
        name: "stdout" as const,
        text,
      },
    ],
    metadata: {},
  };
}

function testMarkdownProjector(source: string): string {
  const title =
    source
      .replace(/^#+\s*/, "")
      .split(/\r?\n/, 1)[0]
      ?.trim() || "Untitled";
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return JSON.stringify({
    version: 1,
    engine: "test",
    source,
    byteLength: source.length,
    utf16Length: source.length,
    measurement: {
      estimatedHeight: 24,
      confidence: "high",
      width: 720,
    },
    anchors: [
      {
        anchorId: `anchor:${slug}`,
        blockId: "block:0",
        level: 1,
        slug,
        sourceSpanByte: [0, source.length],
        sourceSpanUtf16: [0, source.length],
        title,
      },
    ],
    blocks: [],
    runs: [],
  });
}
