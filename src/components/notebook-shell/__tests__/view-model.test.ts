import { describe, expect, it } from "vite-plus/test";
import {
  createNotebookViewModel,
  notebookMetadataToPackageViewModel,
  notebookOutlineItemsToMarkdownHeadingAnchors,
  notebookViewCellsToOutlineItems,
  notebookViewCellsToReadOnlyCells,
  notebookViewCellsToTracebackTargets,
  type NotebookViewCell,
} from "../view-model";

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

  it("projects shared notebook view cells into outline items", () => {
    const outline = notebookViewCellsToOutlineItems([
      {
        id: "intro",
        cellType: "markdown",
        source: "# Intro\n\n## Setup",
        language: null,
        executionId: null,
        executionCount: null,
        outputs: [],
        metadata: {},
      },
    ]);

    expect(outline.map((item) => [item.id, item.cellId, item.title, item.level])).toEqual([
      ["intro:heading:0", "intro", "Intro", 1],
      ["intro:heading:1", "intro", "Setup", 2],
    ]);
    expect(outline.map((item) => item.href)).toEqual([
      "#notebook-cell-intro-heading-intro",
      "#notebook-cell-intro-heading-setup",
    ]);
  });

  it("lets host adapters override outline status labels", () => {
    const outline = notebookViewCellsToOutlineItems(
      [
        {
          id: "code-1",
          cellType: "code",
          source: "print('ok')",
          language: "python",
          executionId: "exec-1",
          executionCount: 3,
          outputs: [],
          metadata: {},
        },
      ],
      {
        getStatusLabel: (cell) => (cell.id === "code-1" ? "Running" : null),
      },
    );

    expect(outline[0]).toMatchObject({
      cellId: "code-1",
      statusLabel: "Running",
    });
  });

  it("builds a normalized view model for host adapters", () => {
    const cells: NotebookViewCell[] = [
      {
        id: "code-1",
        cellType: "code",
        source: "print('ok')",
        language: "python",
        executionId: "exec-1",
        executionCount: 7,
        outputs: [],
        metadata: {},
      },
    ];

    const viewModel = createNotebookViewModel(cells, {
      resolveLanguage: (language) => language ?? "plain",
    });

    expect(viewModel.cells).toBe(cells);
    expect(viewModel.cellIds).toEqual(["code-1"]);
    expect(viewModel.codeCellCount).toBe(1);
    expect(viewModel.readOnlyCells[0]).toMatchObject({
      id: "code-1",
      cellType: "code",
      language: "python",
      executionCount: 7,
    });
    expect(viewModel.outlineItems[0]).toMatchObject({
      cellId: "code-1",
      statusLabel: "In [7]",
    });
    expect(viewModel.tracebackTargetsByExecutionId.get("exec-1")).toEqual({
      cellId: "code-1",
      label: "In [7]",
    });
    expect(viewModel.markdownHeadingAnchorsByCellId.get("code-1")).toBeUndefined();
    expect(viewModel.packages.sections).toEqual([]);
  });

  it("projects notebook dependency metadata for shared package panels", () => {
    const packageView = notebookMetadataToPackageViewModel({
      runt: {
        uv: {
          dependencies: ["pandas>=2", "polars"],
          "requires-python": ">=3.12",
        },
        pixi: {
          dependencies: ["numpy"],
          pypi_dependencies: ["altair"],
          channels: ["conda-forge"],
        },
      },
    });

    expect(packageView.summary).toBe("uv + pixi · 4 packages");
    expect(packageView.sections).toMatchObject([
      {
        manager: "uv",
        label: "uv",
        dependencies: ["pandas>=2", "polars"],
        details: [{ label: "Python", values: [">=3.12"] }],
      },
      {
        manager: "pixi",
        label: "pixi",
        dependencies: ["numpy"],
        details: [
          { label: "PyPI", values: ["altair"] },
          { label: "Channels", values: ["conda-forge"] },
        ],
      },
    ]);
  });

  it("can build outline-only projections without a read-only language resolver", () => {
    const viewModel = createNotebookViewModel([
      {
        id: "code-1",
        cellType: "code",
        source: "print('ok')",
        language: "python",
        executionId: null,
        executionCount: null,
        outputs: [],
        metadata: {},
      },
    ]);

    expect(viewModel.outlineItems[0]).toMatchObject({
      cellId: "code-1",
      statusLabel: null,
    });
    expect(viewModel.readOnlyCells[0].language).toBeNull();
  });

  it("projects traceback execution ids to notebook cells", () => {
    const targets = notebookViewCellsToTracebackTargets([
      {
        id: "markdown-1",
        cellType: "markdown",
        source: "# Intro",
        language: null,
        executionId: null,
        executionCount: null,
        outputs: [],
        metadata: {},
      },
      {
        id: "code-1",
        cellType: "code",
        source: "raise ValueError",
        language: "python",
        executionId: "exec-1",
        executionCount: 4,
        outputs: [],
        metadata: {},
      },
      {
        id: "code-2",
        cellType: "code",
        source: "print('pending')",
        language: "python",
        executionId: "exec-2",
        executionCount: null,
        outputs: [],
        metadata: {},
      },
    ]);

    expect([...targets.entries()]).toEqual([
      ["exec-1", { cellId: "code-1", label: "In [4]" }],
      ["exec-2", { cellId: "code-2" }],
    ]);
  });

  it("projects outline headings to markdown heading anchors by cell", () => {
    const outlineItems = notebookViewCellsToOutlineItems([
      {
        id: "intro",
        cellType: "markdown",
        source: "# Intro\n\n## Setup",
        language: null,
        executionId: null,
        executionCount: null,
        outputs: [],
        metadata: {},
      },
    ]);

    expect(notebookOutlineItemsToMarkdownHeadingAnchors(outlineItems).get("intro")).toEqual([
      {
        itemId: "intro:heading:0",
        title: "Intro",
        level: 1,
        anchor: "intro",
        headingAnchorId: "notebook-cell-intro-heading-intro",
      },
      {
        itemId: "intro:heading:1",
        title: "Setup",
        level: 2,
        anchor: "setup",
        headingAnchorId: "notebook-cell-intro-heading-setup",
      },
    ]);
  });
});
