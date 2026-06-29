import { describe, expect, it } from "vite-plus/test";
import { setMarkdownProjectionProjector } from "@/lib/markdown-projection";
import {
  createDocumentAnchorMap,
  createNotebookDocumentAnchors,
  documentMarkdownBlockAnchorId,
  type DocumentAnchor,
} from "../document-anchors";
import type { NotebookViewCell } from "../view-model";

describe("notebook document anchors", () => {
  it("keeps cell anchors stable when visual order changes", () => {
    const first = codeViewCell("cell-a", "a = 1");
    const second = codeViewCell("cell-b", "b = 2");

    const original = createNotebookDocumentAnchors([first, second]);
    const reordered = createNotebookDocumentAnchors([second, first]);

    expect(cellAnchorIds(original)).toEqual(["notebook-cell-cell-a", "notebook-cell-cell-b"]);
    expect(cellAnchorIds(reordered)).toEqual(["notebook-cell-cell-b", "notebook-cell-cell-a"]);
    expect(anchorMap(reordered).get("notebook-cell-cell-a")).toMatchObject({
      id: "notebook-cell-cell-a",
      kind: "cell",
      cellId: "cell-a",
      domId: "notebook-cell-cell-a",
    });
  });

  it("derives markdown heading and block anchors from the current projection", () => {
    const source = "# Intro\n\nBody";
    const cell = markdownViewCell("md-1", source, {
      anchors: [{ title: "Intro", level: 1, slug: "intro", blockId: "heading-1" }],
      blocks: [
        { blockId: "heading-1", blockIndex: 0, kind: "heading", span: [0, 7] },
        { blockId: "paragraph-1", blockIndex: 1, kind: "paragraph", span: [9, 13] },
      ],
    });

    const anchors = createNotebookDocumentAnchors([cell]);

    expect(anchors).toContainEqual(
      expect.objectContaining({
        id: "notebook-cell-md-1-heading-intro",
        kind: "markdown_heading",
        cellId: "md-1",
        domId: "notebook-cell-md-1-heading-intro",
        markdownAnchorSlug: "intro",
      }),
    );
    expect(anchors).toContainEqual(
      expect.objectContaining({
        id: documentMarkdownBlockAnchorId("md-1", "paragraph-1"),
        kind: "markdown_block",
        cellId: "md-1",
        domId: "notebook-cell-md-1",
        markdownBlockId: "paragraph-1",
        sourceSpanUtf16: [9, 13],
      }),
    );
  });

  it("projects output anchors from stable output ids", () => {
    const anchors = createNotebookDocumentAnchors([
      {
        ...codeViewCell("plot", "plot()"),
        outputs: [
          {
            output_id: "plot-output",
            output_type: "display_data",
            data: { "image/png": "iVBORw0KGgo=" },
            metadata: {},
          },
        ],
      },
    ]);

    expect(anchors).toContainEqual(
      expect.objectContaining({
        id: "notebook-cell-plot-output-plot-output",
        kind: "output",
        cellId: "plot",
        domId: "notebook-cell-plot-output-plot-output",
        outputId: "plot-output",
      }),
    );
  });

  it("drops markdown anchors when the current source is blank", () => {
    const staleCell = markdownViewCell("md-blank", "# Old", {
      anchors: [{ title: "Old", level: 1, slug: "old", blockId: "old-heading" }],
      blocks: [{ blockId: "old-heading", blockIndex: 0, kind: "heading", span: [0, 5] }],
    });

    const anchors = createNotebookDocumentAnchors([{ ...staleCell, source: "  \n" }]);

    expect(anchors.map((anchor) => anchor.kind)).toEqual(["cell"]);
  });

  it("falls back to stale attached markdown anchors when no projector is registered", () => {
    const staleCell = markdownViewCell("md-stale", "# Old", {
      anchors: [{ title: "Old", level: 1, slug: "old", blockId: "old-heading" }],
      blocks: [{ blockId: "old-heading", blockIndex: 0, kind: "heading", span: [0, 5] }],
    });

    const anchors = createNotebookDocumentAnchors([{ ...staleCell, source: "# New" }]);

    expect(anchorMap(anchors).get("notebook-cell-md-stale-heading-old")).toMatchObject({
      kind: "markdown_heading",
      cellId: "md-stale",
      markdownAnchorSlug: "old",
    });
  });

  it("reprojects stale markdown anchors when a projector is available", () => {
    const restore = setMarkdownProjectionProjector((source) =>
      JSON.stringify(
        testMarkdownProjection(source, {
          anchors: [{ title: "New", level: 1, slug: "new", blockId: "new-heading" }],
          blocks: [{ blockId: "new-heading", blockIndex: 0, kind: "heading", span: [0, 5] }],
        }),
      ),
    );

    try {
      const staleCell = markdownViewCell("md-reproject", "# Old", {
        anchors: [{ title: "Old", level: 1, slug: "old", blockId: "old-heading" }],
        blocks: [{ blockId: "old-heading", blockIndex: 0, kind: "heading", span: [0, 5] }],
      });

      const anchors = createNotebookDocumentAnchors([{ ...staleCell, source: "# New" }]);

      expect(anchorMap(anchors).has("notebook-cell-md-reproject-heading-old")).toBe(false);
      expect(anchorMap(anchors).get("notebook-cell-md-reproject-heading-new")).toMatchObject({
        kind: "markdown_heading",
        cellId: "md-reproject",
        markdownAnchorSlug: "new",
      });
    } finally {
      restore();
    }
  });
});

function cellAnchorIds(anchors: readonly DocumentAnchor[]): string[] {
  return anchors.filter((anchor) => anchor.kind === "cell").map((anchor) => anchor.id);
}

function anchorMap(anchors: readonly DocumentAnchor[]) {
  return createDocumentAnchorMap(anchors);
}

function codeViewCell(id: string, source: string): NotebookViewCell {
  return {
    id,
    cellType: "code",
    source,
    language: "python",
    executionId: null,
    executionCount: null,
    outputs: [],
    metadata: {},
  };
}

function markdownViewCell(
  id: string,
  source: string,
  projection: {
    anchors: readonly { title: string; level: number; slug: string; blockId: string }[];
    blocks: readonly {
      blockId: string;
      blockIndex: number;
      kind: string;
      span: readonly [number, number];
    }[];
  },
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
    markdownProjection: testMarkdownProjection(source, projection),
  };
}

function testMarkdownProjection(
  source: string,
  projection: {
    anchors: readonly { title: string; level: number; slug: string; blockId: string }[];
    blocks: readonly {
      blockId: string;
      blockIndex: number;
      kind: string;
      span: readonly [number, number];
    }[];
  },
) {
  return {
    version: 1 as const,
    engine: "test",
    source,
    byteLength: source.length,
    utf16Length: source.length,
    measurement: {
      estimatedHeight: 32,
      confidence: "high",
      width: 720,
    },
    anchors: projection.anchors.map((anchor) => ({
      anchorId: `anchor:${anchor.slug}`,
      blockId: anchor.blockId,
      level: anchor.level,
      slug: anchor.slug,
      sourceSpanByte: [0, source.length] as [number, number],
      sourceSpanUtf16: [0, source.length] as [number, number],
      title: anchor.title,
    })),
    blocks: projection.blocks.map((block) => ({
      anchorSlug:
        projection.anchors.find((anchor) => anchor.blockId === block.blockId)?.slug ?? undefined,
      blockId: block.blockId,
      blockIndex: block.blockIndex,
      element: block.kind === "heading" ? "h1" : "p",
      kind: block.kind,
      measurement: {
        estimatedHeight: 24,
        confidence: "medium",
        width: 720,
      },
      sourceSpanByte: block.span,
      sourceSpanUtf16: block.span,
      syntaxSpans: [],
      text: source.slice(block.span[0], block.span[1]),
    })),
    runs: [],
  };
}
