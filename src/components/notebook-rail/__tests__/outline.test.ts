import { describe, expect, it } from "vite-plus/test";
import { deriveNotebookOutlineItems, parseMarkdownHeadings } from "../outline";

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

describe("deriveNotebookOutlineItems", () => {
  it("returns markdown headings before cell fallbacks", () => {
    const items = deriveNotebookOutlineItems([
      { id: "a", cell_type: "markdown", source: "# Load data\ntext" },
      { id: "b", cell_type: "code", source: "df.head()", execution_count: 3 },
    ]);

    expect(items).toEqual([
      {
        id: "a:heading:0",
        cellId: "a",
        title: "Load data",
        level: 1,
        kind: "heading",
        statusLabel: null,
      },
    ]);
  });

  it("falls back to scrollable cell summaries when there are no headings", () => {
    const items = deriveNotebookOutlineItems(
      [
        { id: "a", cell_type: "markdown", source: "Notebook intro" },
        { id: "b", cell_type: "code", source: "df = pandas.read_csv(path)" },
        { id: "c", cell_type: "raw", source: "" },
      ],
      {
        getStatusLabel: (cell) => (cell.id === "b" ? "Running" : null),
      },
    );

    expect(items).toEqual([
      {
        id: "a:cell",
        cellId: "a",
        title: "Notebook intro",
        level: 1,
        kind: "cell",
        detail: "Markdown",
        statusLabel: null,
      },
      {
        id: "b:cell",
        cellId: "b",
        title: "df = pandas.read_csv(path)",
        level: 1,
        kind: "cell",
        detail: "Code",
        statusLabel: "Running",
      },
      {
        id: "c:cell",
        cellId: "c",
        title: "Raw 3",
        level: 1,
        kind: "cell",
        detail: "Raw",
        statusLabel: null,
      },
    ]);
  });
});
