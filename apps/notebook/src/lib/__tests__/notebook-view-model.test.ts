import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  replaceNotebookCells,
  resetNotebookCells,
  updateCellById,
  updateCellSourceById,
} from "../notebook-cells";
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
});

describe("createNotebookViewModelFromNotebookCells", () => {
  it("projects outline headings from the shared NotebookView cell store", () => {
    restoreMarkdownProjectionProjector = setMarkdownProjectionProjector(testMarkdownProjector);
    replaceNotebookCells([markdownCell("intro", "# Original title")]);

    expect(outlineTitles()).toEqual(["Original title"]);

    updateCellSourceById("intro", "# Updated title\n\nBody");

    expect(outlineTitles()).toEqual(["Updated title"]);
  });

  it("projects outline status labels from shared cell chrome", () => {
    replaceNotebookCells([codeCell("code-1", "print('hi')")]);

    expect(createNotebookViewModelFromNotebookCells().outlineItems[0].statusLabel).toBeNull();

    updateCellById("code-1", (cell) =>
      cell.cell_type === "code" ? { ...cell, execution_count: 7 } : cell,
    );

    expect(createNotebookViewModelFromNotebookCells().outlineItems[0].statusLabel).toBe("run 7");
  });
});

function outlineTitles(): string[] {
  return createNotebookViewModelFromNotebookCells().outlineItems.map((item) => item.title);
}

function testMarkdownProjection(source: string): NonNullable<Extract<NotebookCell, { cell_type: "markdown" }>["markdownProjection"]> {
  return JSON.parse(testMarkdownProjector(source));
}

function testMarkdownProjector(source: string): string {
  const title = source.replace(/^#+\s*/, "").split(/\r?\n/, 1)[0]?.trim() || "Untitled";
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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
