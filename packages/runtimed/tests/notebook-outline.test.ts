import { describe, expect, it } from "vite-plus/test";
import {
  buildNotebookOutlineTree,
  notebookCellAnchorHref,
  notebookCellAnchorId,
  notebookHeadingAnchorHref,
  notebookHeadingAnchorId,
  notebookOutlineItemHref,
  projectNotebookOutline,
  resolveNotebookOutlineSelection,
  resolveNotebookOutlineContextItemId,
  slugifyNotebookHeading,
} from "../src/notebook-outline";

describe("projectNotebookOutline", () => {
  it("returns projected markdown headings before cell fallbacks", () => {
    const projection = projectNotebookOutline([
      markdownCell("a", "# Load data\ntext", [{ title: "Load data", level: 1, slug: "load-data" }]),
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

  it("uses markdown engine duplicate heading anchors", () => {
    const projection = projectNotebookOutline([
      markdownCell("a", "# Results\n## Results!", [
        { title: "Results", level: 1, slug: "results" },
        { title: "Results!", level: 2, slug: "results-2" },
      ]),
      markdownCell("b", "# Results", [{ title: "Results", level: 1, slug: "results" }]),
    ]);

    expect(projection.items.map((item) => item.anchor)).toEqual([
      "results",
      "results-2",
      "results",
    ]);
    expect(projection.items.map((item) => item.headingAnchorId)).toEqual([
      "notebook-cell-a-heading-results",
      "notebook-cell-a-heading-results-2",
      "notebook-cell-b-heading-results",
    ]);
  });

  it("does not parse markdown source when no projection anchors are available", () => {
    const projection = projectNotebookOutline([
      { id: "a", cell_type: "markdown", source: "# Intro" },
    ]);

    expect(projection.source).toBe("cells");
    expect(projection.items[0]).toMatchObject({
      id: "a:cell",
      title: "Intro",
      kind: "cell",
    });
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

  it("prefers explicit metadata and leading section comments for code fallback titles", () => {
    const projection = projectNotebookOutline([
      {
        id: "a",
        cell_type: "code",
        source: "df = pandas.read_csv(path)",
        metadata: { title: "Load raw data" },
      },
      {
        id: "b",
        cell_type: "code",
        source: "# ---- Clean columns ----\ndf = df.dropna()",
      },
      {
        id: "c",
        cell_type: "code",
        source: "# noqa: F401\nimport pandas as pd",
      },
    ]);

    expect(projection.items.map((item) => item.title)).toEqual([
      "Load raw data",
      "Clean columns",
      "# noqa: F401",
    ]);
  });

  it("cleans prose markdown fallback titles when no headings exist", () => {
    const projection = projectNotebookOutline([
      {
        id: "a",
        cell_type: "markdown",
        source: "> **Summary:** [model findings](./findings.md) <br />",
      },
    ]);

    expect(projection.items[0].title).toBe("Summary: model findings");
  });

  it("can project heading hrefs when a host exposes heading anchors", () => {
    const projection = projectNotebookOutline(
      [
        markdownCell("cell:1", "# Load data", [
          { title: "Load data", level: 1, slug: "load-data" },
        ]),
      ],
      { hrefTarget: "heading" },
    );

    expect(projection.items[0]).toMatchObject({
      cellAnchorId: "notebook-cell-cell_3a_1",
      headingAnchorId: "notebook-cell-cell_3a_1-heading-load-data",
      href: "#notebook-cell-cell_3a_1-heading-load-data",
    });
  });

  it("keeps multiple markdown headings in one cell on the cell href by default", () => {
    const projection = projectNotebookOutline([
      markdownCell("a", "# Load data\n\n## Clean columns", [
        { title: "Load data", level: 1, slug: "load-data" },
        { title: "Clean columns", level: 2, slug: "clean-columns" },
      ]),
    ]);

    expect(projection.items.map((item) => item.href)).toEqual([
      "#notebook-cell-a",
      "#notebook-cell-a",
    ]);
    expect(projection.items.map((item) => item.headingAnchorId)).toEqual([
      "notebook-cell-a-heading-load-data",
      "notebook-cell-a-heading-clean-columns",
    ]);
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
      markdownCell("cell:1", "# Load data", [{ title: "Load data", level: 1, slug: "load-data" }]),
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
      markdownCell("a", "# Load data\n## Load details", [
        { title: "Load data", level: 1, slug: "load-data" },
        { title: "Load details", level: 2, slug: "load-details" },
      ]),
      markdownCell("b", "# Clean columns", [
        { title: "Clean columns", level: 1, slug: "clean-columns" },
      ]),
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
      markdownCell("a", "# Load data\n## Load details", [
        { title: "Load data", level: 1, slug: "load-data" },
        { title: "Load details", level: 2, slug: "load-details" },
      ]),
    ]).items;

    expect(resolveNotebookOutlineSelection(items, { selectedCellId: "a" })).toBe("a:heading:0");
  });

  it("resolves focused code cells to the nearest preceding heading when cell order is available", () => {
    const items = projectNotebookOutline([
      markdownCell("intro", "# Load data", [{ title: "Load data", level: 1, slug: "load-data" }]),
      { id: "load", cell_type: "code", source: "df = pandas.read_csv(path)" },
      markdownCell("clean-heading", "## Clean columns", [
        { title: "Clean columns", level: 2, slug: "clean-columns" },
      ]),
      { id: "clean", cell_type: "code", source: "df = df.dropna()" },
    ]).items;

    const cellIds = ["intro", "load", "clean-heading", "clean"];

    expect(resolveNotebookOutlineContextItemId(items, cellIds, "load")).toBe("intro:heading:0");
    expect(
      resolveNotebookOutlineSelection(items, {
        selectedCellId: "clean",
        cellIds,
      }),
    ).toBe("clean-heading:heading:0");
  });

  it("keeps following code cells in the deepest trailing heading from a multi-heading cell", () => {
    const items = projectNotebookOutline([
      markdownCell("intro", "# Load data\n\n## CSV import", [
        { title: "Load data", level: 1, slug: "load-data" },
        { title: "CSV import", level: 2, slug: "csv-import" },
      ]),
      { id: "load", cell_type: "code", source: "df = pandas.read_csv(path)" },
    ]).items;

    expect(
      resolveNotebookOutlineSelection(items, {
        selectedCellId: "load",
        cellIds: ["intro", "load"],
      }),
    ).toBe("intro:heading:1");
  });
});

describe("buildNotebookOutlineTree", () => {
  it("nests headings by markdown level without losing document order", () => {
    const items = projectNotebookOutline([
      markdownCell("a", "# Load data\n\n## CSV\n\n### Schema", [
        { title: "Load data", level: 1, slug: "load-data" },
        { title: "CSV", level: 2, slug: "csv" },
        { title: "Schema", level: 3, slug: "schema" },
      ]),
      markdownCell("b", "## Warehouse", [{ title: "Warehouse", level: 2, slug: "warehouse" }]),
      markdownCell("c", "# Model", [{ title: "Model", level: 1, slug: "model" }]),
    ]).items;

    const tree = buildNotebookOutlineTree(items);

    expect(tree.map((node) => node.item.title)).toEqual(["Load data", "Model"]);
    expect(tree[0].children.map((node) => node.item.title)).toEqual(["CSV", "Warehouse"]);
    expect(tree[0].children[0].children.map((node) => node.item.title)).toEqual(["Schema"]);
  });
});

function markdownCell(
  id: string,
  source: string,
  anchors: readonly { title: string; level: number; slug: string }[],
) {
  return {
    id,
    cell_type: "markdown" as const,
    source,
    markdownProjection: { anchors },
  };
}
