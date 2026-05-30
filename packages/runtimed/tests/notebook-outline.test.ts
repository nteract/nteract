import { describe, expect, it } from "vite-plus/test";
import {
  parseMarkdownHeadings,
  projectNotebookOutline,
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
          anchor: null,
          detail: "Raw",
          statusLabel: null,
        },
      ],
    });
  });
});

describe("slugifyNotebookHeading", () => {
  it("normalizes markdown heading titles into reusable anchors", () => {
    expect(slugifyNotebookHeading("`Load` **data** [now](./file.ipynb)")).toBe("load-data-now");
  });
});
