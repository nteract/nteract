// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  offsetFromSourcePoint,
  resolveSourceRangeAnchor,
  type SourceRangeCommentAnchor,
  sourceRangeAnchorFromOffsets,
  sourceRangeAnchorFromSelection,
  sourcePointFromOffset,
  sourcePointFromStringOffset,
} from "../comment-source-anchor";
import {
  sourceRangeAnchorFromRenderedMarkdownRuns,
  sourceRangeAnchorFromRenderedMarkdownSelection,
} from "../rendered-markdown-source-comment";

let view: EditorView | null = null;

function viewWithSelection(doc: string, anchor: number, head: number): EditorView {
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor, head },
    }),
  });
  return view;
}

describe("comment-source-anchor", () => {
  afterEach(() => {
    view?.destroy();
    view = null;
    window.getSelection()?.removeAllRanges();
  });

  it("converts source offsets to zero-based line and column points", () => {
    const state = EditorState.create({ doc: "alpha\nbeta" });

    expect(sourcePointFromOffset(state.doc, 0)).toEqual({ line: 0, column: 0 });
    expect(sourcePointFromOffset(state.doc, 8)).toEqual({ line: 1, column: 2 });
    expect(sourcePointFromStringOffset("alpha\nbeta", 8)).toEqual({ line: 1, column: 2 });
  });

  it("builds a normalized source_range anchor for a selection", () => {
    const source = "first line\nsecond line\nthird line";
    const from = source.indexOf("second");
    const to = source.indexOf("third") - 1;
    const selectedView = viewWithSelection(source, to, from);

    expect(sourceRangeAnchorFromSelection("cell-1", selectedView, 6)).toEqual({
      kind: "source_range",
      cell_id: "cell-1",
      start_line: 1,
      start_column: 0,
      end_line: 1,
      end_column: "second line".length,
      prefix_quote: " line\n",
      exact_quote: "second line",
      suffix_quote: "\nthird",
    });
  });

  it("does not create an anchor for a collapsed selection", () => {
    const selectedView = viewWithSelection("alpha", 2, 2);

    expect(sourceRangeAnchorFromSelection("cell-1", selectedView)).toBeNull();
  });

  it("does not create an anchor for whitespace-only selections", () => {
    const selectedView = viewWithSelection("alpha\n  \nomega", 6, 8);

    expect(sourceRangeAnchorFromSelection("cell-1", selectedView)).toBeNull();
  });

  it("does not create an anchor for oversized selections", () => {
    const selectedView = viewWithSelection("abcdef", 0, 6);

    expect(sourceRangeAnchorFromSelection("cell-1", selectedView, 6, 4)).toBeNull();
  });

  it("checks oversized selections by UTF-8 bytes", () => {
    const source = "éé";
    const selectedView = viewWithSelection(source, 0, source.length);

    expect(sourceRangeAnchorFromSelection("cell-1", selectedView, 6, 3)).toBeNull();
    expect(sourceRangeAnchorFromSelection("cell-1", selectedView, 6, 4)?.exact_quote).toBe(source);
  });

  it("builds source_range anchors from raw source offsets", () => {
    const source = "alpha\nbeta\n";
    const from = source.indexOf("beta");
    const to = from + "beta".length;

    expect(sourceRangeAnchorFromOffsets("cell-1", source, from, to, 6)).toEqual({
      kind: "source_range",
      cell_id: "cell-1",
      start_line: 1,
      start_column: 0,
      end_line: 1,
      end_column: 4,
      prefix_quote: "alpha\n",
      exact_quote: "beta",
      suffix_quote: "\n",
    });
  });

  it("maps rendered markdown text selections back to source_range anchors", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <p>
        <span data-markdown-source-run="true" data-rendered-start="0" data-rendered-end="11" data-source-start="0" data-source-end="11">plain prose</span>
      </p>
    `;
    document.body.append(root);
    const run = root.querySelector("[data-markdown-source-run='true']");
    const text = run?.firstChild;
    if (!text) throw new Error("missing run text");

    const range = document.createRange();
    range.setStart(text, "plain ".length);
    range.setEnd(text, "plain prose".length);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    expect(
      sourceRangeAnchorFromRenderedMarkdownSelection(
        "cell-1",
        "plain prose",
        root,
        window.getSelection(),
      ),
    ).toMatchObject({
      kind: "source_range",
      cell_id: "cell-1",
      start_line: 0,
      start_column: "plain ".length,
      end_line: 0,
      end_column: "plain prose".length,
      exact_quote: "prose",
    });

    root.remove();
  });

  it("rejects rendered markdown selections when hidden source markup changes selected text", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <p>
        <span data-markdown-source-run="true" data-rendered-start="0" data-rendered-end="4" data-source-start="0" data-source-end="8"><strong>bold</strong></span>
      </p>
    `;
    document.body.append(root);
    const run = root.querySelector("[data-markdown-source-run='true']");
    const text = run?.textContent ? run.querySelector("strong")?.firstChild : null;
    if (!text) throw new Error("missing strong text");

    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 3);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    expect(
      sourceRangeAnchorFromRenderedMarkdownSelection(
        "cell-1",
        "**bold**",
        root,
        window.getSelection(),
      ),
    ).toBeNull();

    root.remove();
  });

  it("maps rendered markdown runs back to keyboard-created source_range anchors", () => {
    expect(
      sourceRangeAnchorFromRenderedMarkdownRuns("cell-1", "plain prose", [
        {
          blockId: "p0",
          inlineId: "r0",
          listItemIndex: null,
          renderedText: "plain prose",
          renderedTextUtf16: [0, 11],
          semantic: "text",
          sourceSpanByte: [0, 11],
          sourceSpanUtf16: [0, 11],
        },
      ]),
    ).toMatchObject({
      kind: "source_range",
      cell_id: "cell-1",
      exact_quote: "plain prose",
    });
  });

  it("rejects rendered markdown runs when hidden source markup changes selected text", () => {
    expect(
      sourceRangeAnchorFromRenderedMarkdownRuns("cell-1", "**bold**", [
        {
          blockId: "p0",
          inlineId: "r0",
          listItemIndex: null,
          renderedText: "bold",
          renderedTextUtf16: [0, 4],
          semantic: "strong",
          sourceSpanByte: [0, 8],
          sourceSpanUtf16: [0, 8],
        },
      ]),
    ).toBeNull();
  });
});

describe("resolveSourceRangeAnchor", () => {
  const source = "import sympy as sp\nf = sp.sin(x) * sp.exp(x)\ndf = sp.diff(f, x)\n";

  function anchorFor(quote: string): SourceRangeCommentAnchor {
    const from = source.indexOf(quote);
    const start = sourcePointFromStringOffset(source, from);
    const end = sourcePointFromStringOffset(source, from + quote.length);
    return {
      kind: "source_range",
      cell_id: "cell-1",
      start_line: start.line,
      start_column: start.column,
      end_line: end.line,
      end_column: end.column,
      prefix_quote: source.slice(Math.max(0, from - 12), from),
      exact_quote: quote,
      suffix_quote: source.slice(from + quote.length, from + quote.length + 12),
    };
  }

  it("maps stored line/column straight through when the text is unchanged", () => {
    const anchor = anchorFor("sp.diff(f, x)");
    const expected = source.indexOf("sp.diff(f, x)");
    expect(resolveSourceRangeAnchor(source, anchor)).toEqual({
      from: expected,
      to: expected + "sp.diff(f, x)".length,
    });
  });

  it("repairs the offset after the document shifts above the quote", () => {
    const anchor = anchorFor("sp.diff(f, x)");
    const shifted = `# added a comment line\n${source}`;
    const expected = shifted.indexOf("sp.diff(f, x)");
    expect(resolveSourceRangeAnchor(shifted, anchor)).toEqual({
      from: expected,
      to: expected + "sp.diff(f, x)".length,
    });
  });

  it("uses prefix/suffix to disambiguate repeated quotes", () => {
    const repeated = "value = 1\nvalue = 1\n";
    const second = repeated.lastIndexOf("value");
    const anchor: SourceRangeCommentAnchor = {
      kind: "source_range",
      cell_id: "cell-1",
      start_line: 1,
      start_column: 0,
      end_line: 1,
      end_column: 5,
      prefix_quote: "value = 1\n",
      exact_quote: "value",
      suffix_quote: " = 1",
    };
    expect(resolveSourceRangeAnchor(repeated, anchor)).toEqual({ from: second, to: second + 5 });
  });

  it("returns null when the quoted text no longer exists", () => {
    const anchor = anchorFor("sp.diff(f, x)");
    expect(resolveSourceRangeAnchor("totally different source", anchor)).toBeNull();
  });

  it("computes offsets from zero-based points", () => {
    expect(offsetFromSourcePoint("alpha\nbeta", 1, 2)).toBe(8);
    expect(offsetFromSourcePoint("alpha\nbeta", 0, 0)).toBe(0);
  });
});
