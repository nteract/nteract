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

  it("maps plain rendered markdown text selections back to exact source text", () => {
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

  it("snaps styled rendered markdown selections to the full source markup run", () => {
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
    ).toMatchObject({
      kind: "source_range",
      cell_id: "cell-1",
      start_line: 0,
      start_column: 0,
      end_line: 0,
      end_column: 8,
      exact_quote: "**bold**",
    });

    root.remove();
  });

  it("maps rendered markdown selections spanning styled runs to the full source range", () => {
    const source = "Intro **bold** and *em* outro";
    const root = document.createElement("div");
    root.innerHTML =
      '<p><span data-markdown-source-run="true" data-rendered-start="0" data-rendered-end="6" data-source-start="0" data-source-end="6">Intro </span><span data-markdown-source-run="true" data-rendered-start="6" data-rendered-end="10" data-source-start="6" data-source-end="14"><strong>bold</strong></span><span data-markdown-source-run="true" data-rendered-start="10" data-rendered-end="15" data-source-start="14" data-source-end="19"> and </span><span data-markdown-source-run="true" data-rendered-start="15" data-rendered-end="17" data-source-start="19" data-source-end="23"><em>em</em></span><span data-markdown-source-run="true" data-rendered-start="17" data-rendered-end="23" data-source-start="23" data-source-end="29"> outro</span></p>';
    document.body.append(root);
    const strongText = root.querySelector("strong")?.firstChild;
    const emText = root.querySelector("em")?.firstChild;
    if (!strongText || !emText) throw new Error("missing styled text");

    const range = document.createRange();
    range.setStart(strongText, 0);
    range.setEnd(emText, "em".length);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    expect(
      sourceRangeAnchorFromRenderedMarkdownSelection(
        "cell-1",
        source,
        root,
        window.getSelection(),
      ),
    ).toMatchObject({
      kind: "source_range",
      cell_id: "cell-1",
      start_line: 0,
      start_column: source.indexOf("**bold**"),
      end_line: 0,
      end_column: source.indexOf(" outro"),
      exact_quote: "**bold** and *em*",
    });

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

  it("maps styled rendered markdown runs back to source markup", () => {
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
    ).toMatchObject({
      kind: "source_range",
      cell_id: "cell-1",
      start_line: 0,
      start_column: 0,
      end_line: 0,
      end_column: 8,
      exact_quote: "**bold**",
    });
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

  function anchorFromOccurrence(
    sourceText: string,
    quote: string,
    occurrenceIndex: number,
    contextChars = 12,
  ): SourceRangeCommentAnchor {
    let from = -1;
    let searchFrom = 0;
    for (let index = 0; index <= occurrenceIndex; index += 1) {
      from = sourceText.indexOf(quote, searchFrom);
      if (from === -1) throw new Error(`missing quote occurrence: ${quote}`);
      searchFrom = from + quote.length;
    }
    const start = sourcePointFromStringOffset(sourceText, from);
    const end = sourcePointFromStringOffset(sourceText, from + quote.length);
    return {
      kind: "source_range",
      cell_id: "cell-1",
      start_line: start.line,
      start_column: start.column,
      end_line: end.line,
      end_column: end.column,
      prefix_quote: sourceText.slice(Math.max(0, from - contextChars), from),
      exact_quote: quote,
      suffix_quote: sourceText.slice(from + quote.length, from + quote.length + contextChars),
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

  it("repairs a single occurrence after the document shifts above the quote", () => {
    const anchor = anchorFor("sp.diff(f, x)");
    const shifted = `# added a comment line\n${source}`;
    const expected = shifted.indexOf("sp.diff(f, x)");
    expect(resolveSourceRangeAnchor(shifted, anchor)).toEqual({
      from: expected,
      to: expected + "sp.diff(f, x)".length,
    });
  });

  it("uses context to reanchor a shifted repeated quote instead of a nearby stale occurrence", () => {
    const original = "left foo right\nother foo other\n";
    const anchor = anchorFromOccurrence(original, "foo", 1, 6);
    const shifted = "left foo right\ninserted foo line\nother foo other\n";
    const expected = shifted.lastIndexOf("foo");

    expect(offsetFromSourcePoint(shifted, anchor.start_line, anchor.start_column)).not.toBe(
      expected,
    );
    expect(resolveSourceRangeAnchor(shifted, anchor)).toEqual({
      from: expected,
      to: expected + "foo".length,
    });
  });

  it("returns null for repeated quotes with no distinguishing prefix or suffix context", () => {
    const repeated = "same\nsame\n";
    const anchor: SourceRangeCommentAnchor = {
      kind: "source_range",
      cell_id: "cell-1",
      start_line: 99,
      start_column: 0,
      end_line: 99,
      end_column: 4,
      prefix_quote: "",
      exact_quote: "same",
      suffix_quote: "",
    };

    expect(resolveSourceRangeAnchor(repeated, anchor)).toBeNull();
  });

  it("uses prefix/suffix context to disambiguate repeated quotes", () => {
    const repeated = "alpha foo\nbeta foo\n";
    const second = repeated.lastIndexOf("foo");
    const anchor: SourceRangeCommentAnchor = {
      kind: "source_range",
      cell_id: "cell-1",
      start_line: 99,
      start_column: 0,
      end_line: 99,
      end_column: 3,
      prefix_quote: "beta ",
      exact_quote: "foo",
      suffix_quote: "\n",
    };
    expect(resolveSourceRangeAnchor(repeated, anchor)).toEqual({
      from: second,
      to: second + "foo".length,
    });
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
