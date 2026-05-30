import { describe, expect, it } from "vite-plus/test";
import {
  notebookCellAnchorHref,
  notebookCellAnchorId,
  notebookHeadingAnchorHref,
  notebookHeadingAnchorId,
  notebookOutlineItemHref,
  parseMarkdownHeadings,
  projectNotebookOutline,
  resolveNotebookOutlineSelection,
  slugifyNotebookHeading,
} from "../src/notebook-outline";

describe("parseMarkdownHeadings", () => {
  it("extracts ATX headings and ignores fenced code blocks", () => {
    expect(
      parseMarkdownHeadings(
        [
          "# Load data",
          "",
          "```md",
          "# Not a heading",
          "```",
          "## Clean columns ##",
          "    # indented code",
          "### `Model` run",
        ].join("\n"),
      ),
    ).toEqual([
      { title: "Load data", level: 1 },
      { title: "Clean columns", level: 2 },
      { title: "Model run", level: 3 },
    ]);
  });
});

describe("projectNotebookOutline", () => {
  it("returns markdown headings before cell fallbacks", () => {
    const projection = projectNotebookOutline([
      { id: "a", cell_type: "markdown", source: "# Load data\ntext" },
      { id: "b", cell_type: "code", source: "df.head()", execution_count: 3 },
    ]);

    expect(projection).toEqual({
      source: "headings",
      items: [
        {
          id: "a:heading:0",
          cellId: "a",
          title: "Load data",
          level: 1,
          kind: "heading",
          cellAnchorId: "notebook-cell-a",
          headingAnchorId: "notebook-cell-a-heading-load-data",
          href: "#notebook-cell-a",
          anchor: "load-data",
          statusLabel: null,
        },
      ],
    });
  });

  it("assigns deterministic duplicate heading anchors across cells", () => {
    const projection = projectNotebookOutline([
      { id: "a", cell_type: "markdown", source: "# Results\n## Results!" },
      { id: "b", cell_type: "markdown", source: "# Results" },
    ]);

    expect(projection.items.map((item) => item.anchor)).toEqual([
      "results",
      "results-1",
      "results-2",
    ]);
  });

  it("falls back to scrollable cell summaries when there are no headings", () => {
    const projection = projectNotebookOutline(
      [
        { id: "a", cell_type: "markdown", source: "Notebook intro" },
        { id: "b", cell_type: "code", source: "df = pandas.read_csv(path)" },
        { id: "c", cell_type: "raw", source: "" },
      ],
      {
        getStatusLabel: (cell) => (cell.id === "b" ? "Running" : null),
      },
    );

    expect(projection).toEqual({
      source: "cells",
      items: [
        {
          id: "a:cell",
          cellId: "a",
          title: "Notebook intro",
          level: 1,
          kind: "cell",
          cellAnchorId: "notebook-cell-a",
          headingAnchorId: null,
          href: "#notebook-cell-a",
          anchor: null,
          detail: "Markdown",
          statusLabel: null,
        },
        {
          id: "b:cell",
          cellId: "b",
          title: "df = pandas.read_csv(path)",
          level: 1,
          kind: "cell",
          cellAnchorId: "notebook-cell-b",
          headingAnchorId: null,
          href: "#notebook-cell-b",
          anchor: null,
          detail: "Code",
          statusLabel: "Running",
        },
        {
          id: "c:cell",
          cellId: "c",
          title: "Raw 3",
          level: 1,
          kind: "cell",
          cellAnchorId: "notebook-cell-c",
          headingAnchorId: null,
          href: "#notebook-cell-c",
          anchor: null,
          detail: "Raw",
          statusLabel: null,
        },
      ],
    });
  });

  it("can project heading hrefs when a host exposes heading anchors", () => {
    const projection = projectNotebookOutline(
      [{ id: "cell:1", cell_type: "markdown", source: "# Load data" }],
      { hrefTarget: "heading" },
    );

    expect(projection.items[0]).toMatchObject({
      cellAnchorId: "notebook-cell-cell_3a_1",
      headingAnchorId: "notebook-cell-cell_3a_1-heading-load-data",
      href: "#notebook-cell-cell_3a_1-heading-load-data",
    });
  });
});

describe("slugifyNotebookHeading", () => {
  it("normalizes markdown heading titles into reusable anchors", () => {
    expect(slugifyNotebookHeading("`Load` **data** [now](./file.ipynb)")).toBe("load-data-now");
  });
});

describe("notebook outline anchors", () => {
  it("creates stable cell and heading anchor targets without DOM or React", () => {
    expect(notebookCellAnchorId("cell:1")).toBe("notebook-cell-cell_3a_1");
    expect(notebookCellAnchorHref("cell:1")).toBe("#notebook-cell-cell_3a_1");
    expect(notebookHeadingAnchorId("cell:1", "load-data")).toBe(
      "notebook-cell-cell_3a_1-heading-load-data",
    );
    expect(notebookHeadingAnchorHref("cell:1", "load-data")).toBe(
      "#notebook-cell-cell_3a_1-heading-load-data",
    );
  });

  it("resolves an outline item href for cell or heading targets", () => {
    const item = projectNotebookOutline([
      { id: "cell:1", cell_type: "markdown", source: "# Load data" },
    ]).items[0];

    expect(notebookOutlineItemHref(item)).toBe("#notebook-cell-cell_3a_1");
    expect(notebookOutlineItemHref(item, "heading")).toBe(
      "#notebook-cell-cell_3a_1-heading-load-data",
    );
  });
});

describe("resolveNotebookOutlineSelection", () => {
  it("prefers a valid pinned item over the focused cell fallback", () => {
    const items = projectNotebookOutline([
      { id: "a", cell_type: "markdown", source: "# Load data\n## Load details" },
      { id: "b", cell_type: "markdown", source: "# Clean columns" },
    ]).items;

    expect(
      resolveNotebookOutlineSelection(items, {
        selectedItemId: "a:heading:1",
        selectedCellId: "b",
      }),
    ).toBe("a:heading:1");
  });

  it("falls back to the first item for the focused cell", () => {
    const items = projectNotebookOutline([
      { id: "a", cell_type: "markdown", source: "# Load data\n## Load details" },
    ]).items;

    expect(resolveNotebookOutlineSelection(items, { selectedCellId: "a" })).toBe("a:heading:0");
  });
});
