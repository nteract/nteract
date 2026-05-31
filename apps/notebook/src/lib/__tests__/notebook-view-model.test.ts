import { afterEach, describe, expect, it } from "vite-plus/test";
import { replaceNotebookCells, resetNotebookCells, updateCellById } from "../notebook-cells";
import { createNotebookViewModelFromNotebookCells } from "../notebook-view-model";
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
});

afterEach(() => {
  resetNotebookCells();
});

describe("createNotebookViewModelFromNotebookCells", () => {
  it("projects outline headings from the shared NotebookView cell store", () => {
    replaceNotebookCells([markdownCell("intro", "# Original title")]);

    expect(outlineTitles()).toEqual(["Original title"]);

    updateCellById("intro", (cell) => ({
      ...cell,
      source: "# Updated title\n\nBody",
    }));

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
