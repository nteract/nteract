import assert from "node:assert/strict";
import { afterEach, describe, it } from "vite-plus/test";
import {
  getCellById,
  getCellIdsSnapshot,
  updateCellSourceById,
} from "@/components/notebook/state/cell-store";
import {
  getCellExecutionId,
  getExecutionById,
  getNotebookQueueProjection,
  resetNotebookExecutions,
  setExecution,
  setNotebookQueueProjection,
} from "@/components/notebook/state/execution-store";
import { getOutputById, resetNotebookOutputs } from "@/components/notebook/state/output-store";
import {
  cleanupNotebookProjectionForRemovedCells,
  projectNotebookCellsIntoViewStores,
  resetNotebookProjectionUnlessPreserved,
  resetNotebookViewStoreProjection,
} from "@/components/notebook/state/projection-lifecycle";
import { createNotebookViewModelFromNotebookCells } from "@/components/notebook/state/view-model-store";
import { setMarkdownProjectionProjector } from "@/lib/markdown-projection";

describe("notebook projection lifecycle", () => {
  let restoreMarkdownProjectionProjector: (() => void) | undefined;

  afterEach(() => {
    restoreMarkdownProjectionProjector?.();
    restoreMarkdownProjectionProjector = undefined;
    resetNotebookViewStoreProjection();
    resetNotebookExecutions();
    resetNotebookOutputs();
  });

  it("keeps outline projection tied to the shared NotebookView store after local source edits", () => {
    restoreMarkdownProjectionProjector = setMarkdownProjectionProjector(testMarkdownProjector);

    projectNotebookCellsIntoViewStores([
      {
        id: "intro",
        cellType: "markdown",
        source: "# Original title",
        executionId: null,
        executionCount: null,
        outputs: [],
        metadata: {},
      },
    ]);

    assert.deepEqual(outlineTitlesFromStore(), ["Original title"]);

    updateCellSourceById("intro", "# Updated title\n\nBody");

    assert.deepEqual(outlineTitlesFromStore(), ["Updated title"]);
  });

  it("reuses markdown projections for unchanged cloud cell sources", () => {
    let projectCalls = 0;
    restoreMarkdownProjectionProjector = setMarkdownProjectionProjector((source) => {
      projectCalls += 1;
      return testMarkdownProjector(source);
    });

    const cell = {
      id: "intro",
      cellType: "markdown" as const,
      source: "# Stable title",
      executionId: null,
      executionCount: null,
      outputs: [],
      metadata: {},
    };

    projectNotebookCellsIntoViewStores([cell]);
    projectNotebookCellsIntoViewStores([cell]);

    assert.equal(projectCalls, 1);
    assert.deepEqual(outlineTitlesFromStore(), ["Stable title"]);
  });

  it("preserves RuntimeStateDoc-owned queue projection during cell materialization", () => {
    setNotebookQueueProjection({
      executing_cell_id: "cell-running",
      queued_cell_ids: ["cell-queued"],
    });

    projectNotebookCellsIntoViewStores([
      {
        id: "cell-running",
        cellType: "code",
        source: "print('running')",
        executionId: "exec-running",
        executionCount: null,
        outputs: [],
        metadata: {},
      },
      {
        id: "cell-queued",
        cellType: "code",
        source: "print('queued')",
        executionId: "exec-queued",
        executionCount: null,
        outputs: [],
        metadata: {},
      },
    ]);

    assert.deepEqual(getNotebookQueueProjection(), {
      executing_cell_id: "cell-running",
      queued_cell_ids: ["cell-queued"],
    });
  });

  it("does not overwrite runtime-owned execution snapshots with cloud placeholders", () => {
    setExecution("exec-real", {
      execution_count: 7,
      status: "running",
      success: null,
      output_ids: ["out-runtime"],
    });

    projectNotebookCellsIntoViewStores([
      {
        id: "cell-1",
        cellType: "code",
        source: "print('snapshot')",
        executionId: "exec-real",
        executionCount: 3,
        outputs: [],
        metadata: {},
      },
    ]);

    assert.deepEqual(getExecutionById("exec-real"), {
      execution_count: 7,
      status: "running",
      success: null,
      output_ids: ["out-runtime"],
    });
  });

  it("keeps existing output references stable when structural cloud projection adds a cell", () => {
    projectNotebookCellsIntoViewStores([
      codeCellWithWidgetOutput("widget-cell", "slider-model", 7),
    ]);

    const firstCell = getCellById("widget-cell");
    const firstOutput = getOutputById("widget-output");

    projectNotebookCellsIntoViewStores([
      codeCellWithWidgetOutput("widget-cell", "slider-model", 7),
      {
        id: "new-cell",
        cellType: "code",
        source: "",
        executionId: null,
        executionCount: null,
        outputs: [],
        metadata: {},
      },
    ]);

    assert.equal(getCellById("widget-cell"), firstCell);
    assert.equal(getOutputById("widget-output"), firstOutput);
  });

  it("updates an existing output reference when the cloud output payload changes", () => {
    projectNotebookCellsIntoViewStores([
      codeCellWithWidgetOutput("widget-cell", "slider-model", 7),
    ]);

    const firstOutput = getOutputById("widget-output");

    projectNotebookCellsIntoViewStores([
      codeCellWithWidgetOutput("widget-cell", "slider-model", 8),
    ]);

    assert.notEqual(getOutputById("widget-output"), firstOutput);
  });

  it("reuses stamped output references with equal cache keys without stringifying", () => {
    projectNotebookCellsIntoViewStores([
      codeCellWithStampedOutput("widget-cell", "output:widget-output:1:0", "first"),
    ]);

    const firstOutput = getOutputById("widget-output");
    assert.ok(firstOutput);
    assert.equal("_runt_output_cache_key" in firstOutput, false);

    projectNotebookCellsIntoViewStores([
      codeCellWithStampedOutput("widget-cell", "output:widget-output:1:0", "second"),
    ]);

    const nextOutput = getOutputById("widget-output");
    assert.equal(nextOutput, firstOutput);
    const cell = getCellById("widget-cell");
    assert.equal(cell?.cell_type, "code");
    if (cell?.cell_type === "code") {
      assert.equal(cell.outputs[0], firstOutput);
      assert.equal("_runt_output_cache_key" in cell.outputs[0], false);
    }
  });

  it("replaces stamped output references when cache keys change", () => {
    projectNotebookCellsIntoViewStores([
      codeCellWithStampedOutput("widget-cell", "output:widget-output:1:0", "first"),
    ]);

    const firstOutput = getOutputById("widget-output");

    projectNotebookCellsIntoViewStores([
      codeCellWithStampedOutput("widget-cell", "output:widget-output:1:1", "second"),
    ]);

    const nextOutput = getOutputById("widget-output");
    assert.ok(firstOutput);
    assert.ok(nextOutput);
    assert.notEqual(nextOutput, firstOutput);
    assert.equal("_runt_output_cache_key" in nextOutput, false);
    assert.equal(nextOutput.output_type, "display_data");
    if (nextOutput.output_type === "display_data") {
      assert.equal(nextOutput.data["text/plain"], "second");
    }
  });

  it("cleans projector-owned execution and output entries for removed cells only", () => {
    projectNotebookCellsIntoViewStores([
      codeCellWithIdentifiedOutput("removed-cell", "out-removed", "gone"),
      codeCellWithIdentifiedOutput("kept-cell", "out-kept", "still here"),
    ]);

    assert.equal(getCellExecutionId("removed-cell"), "notebook-view-execution:removed-cell");
    assert.ok(getExecutionById("notebook-view-execution:removed-cell"));
    assert.ok(getOutputById("out-removed"));
    assert.equal(getCellExecutionId("kept-cell"), "notebook-view-execution:kept-cell");
    assert.ok(getExecutionById("notebook-view-execution:kept-cell"));
    assert.ok(getOutputById("out-kept"));

    cleanupNotebookProjectionForRemovedCells(["removed-cell"]);

    assert.equal(getCellExecutionId("removed-cell"), null);
    assert.equal(getExecutionById("notebook-view-execution:removed-cell"), undefined);
    assert.equal(getOutputById("out-removed"), undefined);
    assert.equal(getCellExecutionId("kept-cell"), "notebook-view-execution:kept-cell");
    assert.ok(getExecutionById("notebook-view-execution:kept-cell"));
    assert.ok(getOutputById("out-kept"));
  });

  it("preserves cells, outputs, and execution pointers across a same-notebook re-run", () => {
    paintNotebook();
    assertPainted();

    const preserved = resetNotebookProjectionUnlessPreserved({
      previousIdentity: PAINTED,
      nextIdentity: PAINTED,
    });

    assert.equal(preserved, true);
    assertPainted();
  });

  it("hands an instant paint to the live effect and replaces it in place", () => {
    paintNotebook();
    const preserved = resetNotebookProjectionUnlessPreserved({
      previousIdentity: PAINTED,
      nextIdentity: PAINTED,
    });
    assert.equal(preserved, true);
    assertPainted();

    projectNotebookCellsIntoViewStores([
      {
        id: "cell-code",
        cellType: "code",
        source: "print('live')",
        executionId: "exec-2",
        executionCount: 4,
        outputs: [
          { output_type: "stream", name: "stdout", text: "live output\n", output_id: "out-2" },
        ],
        metadata: {},
      },
    ]);

    assert.deepEqual(getCellIdsSnapshot(), ["cell-code"]);
    assert.equal(getCellExecutionId("cell-code"), "exec-2");
    assert.equal(getOutputById("out-2")?.output_type, "stream");
    assert.equal(getOutputById("out-1"), undefined);
  });

  it("clears every projected store on a real notebook switch", () => {
    paintNotebook();

    const preserved = resetNotebookProjectionUnlessPreserved({
      previousIdentity: PAINTED,
      nextIdentity: "id:nb-2",
    });

    assert.equal(preserved, false);
    assert.deepEqual(getCellIdsSnapshot(), [] as string[]);
    assert.equal(getCellExecutionId("cell-code"), null);
    assert.equal(getExecutionById("exec-1"), undefined);
    assert.equal(getOutputById("out-1"), undefined);
  });

  it("fails closed when no painted identity was recorded", () => {
    paintNotebook();

    const preserved = resetNotebookProjectionUnlessPreserved({
      previousIdentity: null,
      nextIdentity: PAINTED,
    });

    assert.equal(preserved, false);
    assert.deepEqual(getCellIdsSnapshot(), [] as string[]);
    assert.equal(getOutputById("out-1"), undefined);
  });

  it("does not preserve an empty projection", () => {
    const preserved = resetNotebookProjectionUnlessPreserved({
      previousIdentity: PAINTED,
      nextIdentity: PAINTED,
    });

    assert.equal(preserved, false);
    assert.deepEqual(getCellIdsSnapshot(), [] as string[]);
  });
});

const PAINTED = "id:nb-1";

function paintNotebook(): void {
  projectNotebookCellsIntoViewStores([
    {
      id: "cell-code",
      cellType: "code",
      source: "print('painted')",
      executionId: "exec-1",
      executionCount: 3,
      outputs: [
        {
          output_type: "stream",
          name: "stdout",
          text: "painted output\n",
          output_id: "out-1",
        },
      ],
      metadata: {},
    },
    {
      id: "cell-md",
      cellType: "markdown",
      source: "# Painted",
      executionId: null,
      executionCount: null,
      outputs: [],
      metadata: {},
    },
  ]);
}

function assertPainted(): void {
  assert.deepEqual(getCellIdsSnapshot(), ["cell-code", "cell-md"]);
  assert.equal(getCellExecutionId("cell-code"), "exec-1");
  assert.equal(getExecutionById("exec-1")?.execution_count, 3);
  assert.deepEqual(getExecutionById("exec-1")?.output_ids, ["out-1"]);
  const output = getOutputById("out-1");
  assert.equal(output?.output_type, "stream");
}

function codeCellWithWidgetOutput(cellId: string, modelId: string, value: number) {
  return {
    id: cellId,
    cellType: "code" as const,
    source: "display(slider)",
    executionId: "exec-widget",
    executionCount: 1,
    outputs: [
      {
        output_id: "widget-output",
        output_type: "display_data" as const,
        data: {
          "application/vnd.jupyter.widget-view+json": {
            model_id: modelId,
          },
          "text/plain": `IntSlider(value=${value})`,
        },
        metadata: {},
      },
    ],
    metadata: {},
  };
}

function codeCellWithStampedOutput(cellId: string, cacheKey: string, text: string) {
  return {
    id: cellId,
    cellType: "code" as const,
    source: "display(value)",
    executionId: "exec-widget",
    executionCount: 1,
    outputs: [
      {
        output_id: "widget-output",
        output_type: "display_data" as const,
        data: { "text/plain": text },
        metadata: {},
        _runt_output_cache_key: cacheKey,
        toJSON() {
          throw new Error("stamped output should not be stringified");
        },
      },
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

function outlineTitlesFromStore(): string[] {
  return createNotebookViewModelFromNotebookCells().outlineItems.map((item) => item.title);
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
