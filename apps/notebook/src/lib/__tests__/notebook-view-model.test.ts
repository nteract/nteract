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

  it("updates outline headings after direct markdown source edits", () => {
    restoreMarkdownProjectionProjector = setMarkdownProjectionProjector(testMarkdownProjector);
    replaceNotebookCells([
      {
        ...markdownCell("later", "## Later section\n\n# LMAO\n\n### Deeper note"),
        markdownProjection: testMarkdownProjection(
          "## Later section\n\n# LMAO\n\n### Deeper note",
        ),
      },
    ]);

    expect(outlineTitles()).toEqual(["Later section", "LMAO", "Deeper note"]);

    updateCellSourceById(
      "later",
      "## Later section\n\n# ANother one\n\n# LMAO this is fine\n\n### Deeper note",
    );

    expect(outlineTitles()).toEqual([
      "Later section",
      "ANother one",
      "LMAO this is fine",
      "Deeper note",
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
