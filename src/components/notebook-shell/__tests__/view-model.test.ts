import { describe, expect, it } from "vite-plus/test";
import { notebookViewCellsToReadOnlyCells, type NotebookViewCell } from "../view-model";

describe("notebook shell view model", () => {
  it("projects shared notebook view cells into read-only render cells", () => {
    const cells: NotebookViewCell[] = [
      {
        id: "code-1",
        cellType: "code",
        source: "print('hello')",
        language: "python",
        executionId: "exec-1",
        executionCount: 1,
        outputs: [
          {
            output_id: "out-1",
            output_type: "stream",
            name: "stdout",
            text: "hello\n",
          },
        ],
        metadata: {},
      },
      {
        id: "markdown-1",
        cellType: "markdown",
        source: "# Title",
        language: null,
        executionId: null,
        executionCount: null,
        outputs: [],
        metadata: {},
      },
    ];

    expect(notebookViewCellsToReadOnlyCells(cells, (language) => language ?? "plain")).toEqual([
      {
        id: "code-1",
        cellType: "code",
        source: "print('hello')",
        language: "python",
        outputs: cells[0].outputs,
        executionId: "exec-1",
        executionCount: 1,
      },
      {
        id: "markdown-1",
        cellType: "markdown",
        source: "# Title",
        language: "plain",
        outputs: [],
        executionId: null,
        executionCount: null,
      },
    ]);
  });
});
