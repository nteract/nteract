import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  replaceNotebookCells,
  resetNotebookCells,
  updateCellById,
  updateCellSourceById,
} from "../notebook-cells";
import {
  resetNotebookExecutions,
  setCellExecutionPointer,
  setExecution,
} from "../notebook-executions";
import { resetNotebookOutputs, setOutput } from "../notebook-outputs";
import { createNotebookViewModelFromNotebookCells } from "../notebook-view-model";
import { setMarkdownProjectionProjector } from "../markdown-projection";
import type { NotebookCell } from "../../types";

const codeCell = (id: string, source = "", executionCount: number | null = null): NotebookCell => ({
  cell_type: "code",
  id,
  source,
  execution_count: executionCount,
  outputs: [],
  metadata: {},
});

const markdownCell = (id: string, source = ""): NotebookCell => ({
  cell_type: "markdown",
  id,
  source,
  metadata: {},
  markdownProjection: testMarkdownProjection(source),
});

let restoreMarkdownProjectionProjector: (() => void) | undefined;

afterEach(() => {
  restoreMarkdownProjectionProjector?.();
  restoreMarkdownProjectionProjector = undefined;
  resetNotebookCells();
  resetNotebookOutputs();
  resetNotebookExecutions();
});

describe("createNotebookViewModelFromNotebookCells", () => {
  it("projects outline headings from the shared NotebookView cell store", () => {
    restoreMarkdownProjectionProjector = setMarkdownProjectionProjector(testMarkdownProjector);
    replaceNotebookCells([markdownCell("intro", "# Original title")]);

    expect(outlineTitles()).toEqual(["Original title"]);

    updateCellSourceById("intro", "# Updated title\n\nBody");

    expect(outlineTitles()).toEqual(["Updated title"]);
  });

  it("updates outline headings after direct markdown source edits", () => {
    restoreMarkdownProjectionProjector = setMarkdownProjectionProjector(testMarkdownProjector);
    replaceNotebookCells([
      {
        ...markdownCell("later", "## Analysis\n\n# Draft checkpoint\n\n### Supporting detail"),
        markdownProjection: testMarkdownProjection(
          "## Analysis\n\n# Draft checkpoint\n\n### Supporting detail",
        ),
      },
    ]);

    expect(outlineTitles()).toEqual(["Analysis", "Draft checkpoint", "Supporting detail"]);

    updateCellSourceById(
      "later",
      "## Analysis\n\n# Updated checkpoint\n\n# Final review\n\n### Supporting detail",
    );

    expect(outlineTitles()).toEqual([
      "Analysis",
      "Updated checkpoint",
      "Final review",
      "Supporting detail",
    ]);
  });

  it("projects outline status labels from shared cell chrome", () => {
    replaceNotebookCells([codeCell("code-1", "print('hi')")]);

    expect(createNotebookViewModelFromNotebookCells().outlineItems[0].statusLabel).toBeNull();

    updateCellById("code-1", (cell) =>
      cell.cell_type === "code" ? { ...cell, execution_count: 7 } : cell,
    );

    expect(createNotebookViewModelFromNotebookCells().outlineItems[0].statusLabel).toBe("run 7");
  });

  it("projects raster output waypoints from the execution and output stores", () => {
    replaceNotebookCells([markdownCell("intro", "# Results"), codeCell("plot", "plot()", 2)]);

    setOutput("plot-output", {
      output_id: "plot-output",
      output_type: "display_data",
      data: { "image/png": "iVBORw0KGgo=" },
      metadata: {},
    });
    setExecution("exec-plot", {
      execution_count: 2,
      status: "done",
      success: true,
      output_ids: ["plot-output"],
    });
    setCellExecutionPointer("plot", "exec-plot");

    const outline = createNotebookViewModelFromNotebookCells().outlineItems;

    expect(outline.map((item) => [item.id, item.kind, item.title])).toEqual([
      ["intro:heading:0", "heading", "Results"],
      ["plot:output:plot-output", "output", "Image output"],
    ]);
    expect(outline[1]).toMatchObject({
      href: "#notebook-cell-plot-output-plot-output",
      imagePreview: { mimeType: "image/png" },
      outputId: "plot-output",
    });
  });

  it("does not project cell outputs without an execution pointer", () => {
    replaceNotebookCells([
      markdownCell("intro", "# Results"),
      {
        ...codeCell("stale-plot", "plot()", 1),
        outputs: [
          {
            output_id: "stale-output",
            output_type: "display_data",
            data: { "image/png": "iVBORw0KGgo=" },
            metadata: {},
          },
        ],
      },
    ]);

    const outline = createNotebookViewModelFromNotebookCells().outlineItems;

    expect(outline.map((item) => [item.id, item.kind])).toEqual([["intro:heading:0", "heading"]]);
  });
});

function outlineTitles(): string[] {
  return createNotebookViewModelFromNotebookCells().outlineItems.map((item) => item.title);
}

function testMarkdownProjection(source: string): NonNullable<Extract<NotebookCell, { cell_type: "markdown" }>["markdownProjection"]> {
  return JSON.parse(testMarkdownProjector(source));
}

function testMarkdownProjector(source: string): string {
  const anchors = source
    .split(/\r?\n/)
    .flatMap((line, index) => {
      const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (!match) return [];
      const title = match[2].trim();
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      return [
        {
          anchorId: `anchor:${slug}`,
          blockId: `block:${index}`,
          level: match[1].length,
          slug,
          sourceSpanByte: [0, source.length],
          sourceSpanUtf16: [0, source.length],
          title,
        },
      ];
    });
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
    anchors,
    blocks: [],
    runs: [],
  });
}
