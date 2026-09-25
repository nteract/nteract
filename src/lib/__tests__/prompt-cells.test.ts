import { describe, expect, it } from "vite-plus/test";
import {
  answeredPromptId,
  contextToggleWrites,
  isContextExcluded,
  promptMode,
  sectionCellIds,
  type PromptCellLike,
} from "../prompt-cells";

function cell(
  id: string,
  cell_type: string,
  source = "",
  metadata: Record<string, unknown> = {},
): PromptCellLike {
  return { id, cell_type, source, metadata };
}

function headings(levels: Record<string, number>) {
  return new Map(Object.entries(levels).map(([cellId, level]) => [cellId, [{ level }]]));
}

describe("prompt cells", () => {
  it("recognizes raw cells carrying the prompt marker and their mode", () => {
    expect(promptMode(cell("p", "raw", "q", { nteract: { prompt: {} } }))).toBe("explore");
    expect(promptMode(cell("p", "raw", "q", { nteract: { prompt: { mode: "full" } } }))).toBe(
      "full",
    );
    expect(promptMode(cell("r", "raw", "q"))).toBeNull();
    expect(promptMode(cell("c", "code", "q", { nteract: { prompt: {} } }))).toBeNull();
  });

  it("reads the context exclusion flag and the answered prompt", () => {
    expect(isContextExcluded(cell("c", "code", "x", { nteract: { context_exclude: true } }))).toBe(
      true,
    );
    expect(isContextExcluded(cell("c", "code", "x"))).toBe(false);
    expect(
      answeredPromptId(
        cell("a", "markdown", "hi", { nteract: { prompt_response: { prompt_cell_id: "p" } } }),
      ),
    ).toBe("p");
    expect(answeredPromptId(cell("m", "markdown", "hi"))).toBeNull();
  });

  it("spans a section from its heading to the next heading of the same or higher level", () => {
    const cells = [
      cell("intro", "markdown", "# Intro"),
      cell("setup", "markdown", "## Setup\nsome text"),
      cell("code-1", "code", "x = 1"),
      cell("detail", "markdown", "### Detail"),
      cell("code-2", "code", "y = 2"),
      cell("results", "markdown", "## Results"),
      cell("code-3", "code", "z = 3"),
    ];

    const levels = headings({ intro: 1, setup: 2, detail: 3, results: 2 });

    expect(sectionCellIds(cells, "setup", levels)).toEqual(["setup", "code-1", "detail", "code-2"]);
    expect(sectionCellIds(cells, "detail", levels)).toEqual(["detail", "code-2"]);
    expect(sectionCellIds(cells, "intro", levels)).toEqual(cells.map((c) => c.id));
  });

  it("toggling a heading's context flips its whole section to the opposite of the heading", () => {
    const cells = [
      cell("setup", "markdown", "## Setup"),
      cell("code-1", "code", "x = 1", { nteract: { context_exclude: true } }),
      cell("code-2", "code", "y = 2"),
      cell("next", "markdown", "## Next"),
    ];

    const levels = headings({ setup: 2, next: 2 });

    expect(contextToggleWrites(cells, "setup", levels)).toEqual([
      { cellId: "setup", exclude: true },
      { cellId: "code-1", exclude: true },
      { cellId: "code-2", exclude: true },
    ]);

    const excluded = cells.map((c) =>
      c.id === "next" ? c : { ...c, metadata: { nteract: { context_exclude: true } } },
    );
    expect(contextToggleWrites(excluded, "setup", levels)).toEqual([
      { cellId: "setup", exclude: false },
      { cellId: "code-1", exclude: false },
      { cellId: "code-2", exclude: false },
    ]);
    expect(contextToggleWrites(cells, "code-2", levels)).toEqual([
      { cellId: "code-2", exclude: true },
    ]);
  });

  it("treats a cell without a heading as its own section", () => {
    const cells = [cell("text", "markdown", "plain words"), cell("code", "code", "x")];

    expect(sectionCellIds(cells, "text", headings({}))).toEqual(["text"]);
  });

  it("uses the outline's headings, so a # comment in a fenced block is not a section", () => {
    const cells = [
      cell("setup", "markdown", "## Setup"),
      cell("snippet", "markdown", "Run this:\n```bash\n# install deps\n```"),
      cell("code", "code", "x = 1"),
    ];

    expect(sectionCellIds(cells, "setup", headings({ setup: 2 }))).toEqual([
      "setup",
      "snippet",
      "code",
    ]);
  });
});
