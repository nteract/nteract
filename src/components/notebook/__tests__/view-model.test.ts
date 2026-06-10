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
import type { SupportedLanguage } from "@/components/editor/languages";
import { setMarkdownProjectionProjector } from "@/lib/markdown-projection";

const resolveTestLanguage = (language: string | null | undefined): SupportedLanguage | null =>
  (language ?? "plain") as SupportedLanguage;

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

    expect(notebookViewCellsToReadOnlyCells(cells, resolveTestLanguage)).toEqual([
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
      markdownViewCell("intro", "# Intro\n\n## Setup", [
        { title: "Intro", level: 1, slug: "intro" },
        { title: "Setup", level: 2, slug: "setup" },
      ]),
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

  it("projects missing markdownProjection through the host markdown projector", () => {
    const restore = setMarkdownProjectionProjector((source) =>
      JSON.stringify(testMarkdownProjection(source, [{ title: "Intro", level: 1, slug: "intro" }])),
    );

    try {
      const outline = notebookViewCellsToOutlineItems([
        {
          id: "intro",
          cellType: "markdown",
          source: "# Intro",
          language: null,
          executionId: null,
          executionCount: null,
          outputs: [],
          metadata: {},
        },
      ]);

      expect(outline.map((item) => [item.id, item.title, item.anchor])).toEqual([
        ["intro:heading:0", "Intro", "intro"],
      ]);
    } finally {
      restore();
    }
  });

  it("prefers current source projection over attached empty markdownProjection anchors", () => {
    let calls = 0;
    const restore = setMarkdownProjectionProjector((source) => {
      calls += 1;
      return JSON.stringify(
        testMarkdownProjection(source, [{ title: "Intro", level: 1, slug: "intro" }]),
      );
    });

    try {
      const outline = notebookViewCellsToOutlineItems([markdownViewCell("intro", "# Intro", [])]);

      expect(calls).toBe(1);
      expect(outline.map((item) => [item.id, item.title, item.anchor])).toEqual([
        ["intro:heading:0", "Intro", "intro"],
      ]);
    } finally {
      restore();
    }
  });

  it("reprojects same-length stale markdownProjection anchors from current source", () => {
    let calls = 0;
    const restore = setMarkdownProjectionProjector((source) => {
      calls += 1;
      return JSON.stringify(
        testMarkdownProjection(
          source,
          source.includes("Deep in the emoji train")
            ? [
                { title: "Later section", level: 2, slug: "later-section" },
                { title: "Deep in the emoji train", level: 3, slug: "deep-in-the-emoji-train" },
                { title: "Deeper note", level: 3, slug: "deeper-note" },
              ]
            : [
                { title: "Later section", level: 2, slug: "later-section" },
                { title: "Deeper note", level: 3, slug: "deeper-note" },
              ],
        ),
      );
    });

    try {
      const currentSource = "## Later section\n\n### Deep in the emoji train\n\n### Deeper note";
      const staleSource = "## Later section\n\n### Deeper note\n\n".padEnd(
        currentSource.length,
        "X",
      );
      expect(currentSource.length).toBe(staleSource.length);
      const staleCell = markdownViewCell("later", staleSource, [
        { title: "Later section", level: 2, slug: "later-section" },
        { title: "Deeper note", level: 3, slug: "deeper-note" },
      ]);
      const outline = notebookViewCellsToOutlineItems([
        {
          ...staleCell,
          source: currentSource,
        },
      ]);

      expect(calls).toBe(1);
      expect(outline.map((item) => [item.id, item.title, item.anchor])).toEqual([
        ["later:heading:0", "Later section", "later-section"],
        ["later:heading:1", "Deep in the emoji train", "deep-in-the-emoji-train"],
        ["later:heading:2", "Deeper note", "deeper-note"],
      ]);
    } finally {
      restore();
    }
  });

  it("projects Jupyter hidden metadata into read-only render cells", () => {
    const cells: NotebookViewCell[] = [
      {
        id: "hidden-code",
        cellType: "code",
        source: "setup()",
        language: "python",
        executionId: null,
        executionCount: 2,
        outputs: [],
        metadata: { jupyter: { source_hidden: true, outputs_hidden: true } },
      },
      {
        id: "visible-markdown",
        cellType: "markdown",
        source: "# Visible",
        language: null,
        executionId: null,
        executionCount: null,
        outputs: [],
        metadata: { jupyter: { source_hidden: true, outputs_hidden: true } },
      },
    ];

    expect(notebookViewCellsToReadOnlyCells(cells, resolveTestLanguage)).toEqual([
      {
        id: "hidden-code",
        cellType: "code",
        source: "setup()",
        language: "python",
        outputs: [],
        executionId: null,
        executionCount: 2,
        sourceHidden: true,
        outputsHidden: true,
      },
      {
        id: "visible-markdown",
        cellType: "markdown",
        source: "# Visible",
        language: "plain",
        outputs: [],
        executionId: null,
        executionCount: null,
      },
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

  it("omits empty code cells from outline fallbacks without code badges", () => {
    const outline = notebookViewCellsToOutlineItems([
      codeViewCell("empty-code", " \n\t"),
      codeViewCell("hidden-input", "secret = 1", { jupyter: { source_hidden: true } }),
      codeViewCell("code-1", "print('ok')"),
      codeViewCell("hidden-output", "print('visible input')", {
        jupyter: { outputs_hidden: true },
      }),
    ]);

    expect(outline.map((item) => item.cellId)).toEqual(["code-1", "hidden-output"]);
    expect(outline[0]).toMatchObject({
      cellType: "code",
      title: "print('ok')",
      kind: "cell",
    });
    expect("detail" in outline[0]).toBe(false);
    expect(outline[1]).toMatchObject({
      cellType: "code",
      title: "print('visible input')",
      kind: "cell",
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
      resolveLanguage: resolveTestLanguage,
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
      statusLabel: "run 7",
    });
    expect(viewModel.tracebackTargetsByExecutionId.get("exec-1")).toEqual({
      cellId: "code-1",
      label: "run 7",
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
      ["exec-1", { cellId: "code-1", label: "run 4" }],
      ["exec-2", { cellId: "code-2" }],
    ]);
  });

  it("projects outline headings to markdown heading anchors by cell", () => {
    const outlineItems = notebookViewCellsToOutlineItems([
      markdownViewCell("intro", "# Intro\n\n## Setup", [
        { title: "Intro", level: 1, slug: "intro" },
        { title: "Setup", level: 2, slug: "setup" },
      ]),
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

function markdownViewCell(
  id: string,
  source: string,
  anchors: readonly { title: string; level: number; slug: string }[],
): NotebookViewCell {
  return {
    id,
    cellType: "markdown",
    source,
    language: null,
    executionId: null,
    executionCount: null,
    outputs: [],
    metadata: {},
    markdownProjection: testMarkdownProjection(source, anchors),
  };
}

function codeViewCell(
  id: string,
  source: string,
  metadata: Record<string, unknown> = {},
): NotebookViewCell {
  return {
    id,
    cellType: "code",
    source,
    language: "python",
    executionId: null,
    executionCount: null,
    outputs: [],
    metadata,
  };
}

function testMarkdownProjection(
  source: string,
  anchors: readonly { title: string; level: number; slug: string }[],
) {
  return {
    version: 1 as const,
    engine: "test",
    byteLength: source.length,
    utf16Length: source.length,
    measurement: {
      estimatedHeight: 32,
      confidence: "high",
      width: 720,
    },
    anchors: anchors.map((anchor, index) => ({
      anchorId: `anchor:${anchor.slug}`,
      blockId: `block:${index}`,
      level: anchor.level,
      slug: anchor.slug,
      sourceSpanByte: [0, source.length] as [number, number],
      sourceSpanUtf16: [0, source.length] as [number, number],
      title: anchor.title,
    })),
    blocks: [],
    runs: [],
  };
}
