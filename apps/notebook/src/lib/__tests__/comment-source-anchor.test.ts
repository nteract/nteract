// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { sourceRangeAnchorFromSelection, sourcePointFromOffset } from "../comment-source-anchor";

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
  });

  it("converts source offsets to zero-based line and column points", () => {
    const state = EditorState.create({ doc: "alpha\nbeta" });

    expect(sourcePointFromOffset(state.doc, 0)).toEqual({ line: 0, column: 0 });
    expect(sourcePointFromOffset(state.doc, 8)).toEqual({ line: 1, column: 2 });
  });

  it("builds a normalized source_range anchor for a selection", () => {
    const source = "first line\nsecond line\nthird line";
    const from = source.indexOf("second");
    const to = source.indexOf("third") - 1;
    const view = viewWithSelection(source, to, from);

    expect(sourceRangeAnchorFromSelection("cell-1", view, 6)).toEqual({
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
    const view = viewWithSelection("alpha", 2, 2);

    expect(sourceRangeAnchorFromSelection("cell-1", view)).toBeNull();
  });

  it("does not create an anchor for whitespace-only selections", () => {
    const view = viewWithSelection("alpha\n  \nomega", 6, 8);

    expect(sourceRangeAnchorFromSelection("cell-1", view)).toBeNull();
  });

  it("does not create an anchor for oversized selections", () => {
    const view = viewWithSelection("abcdef", 0, 6);

    expect(sourceRangeAnchorFromSelection("cell-1", view, 6, 4)).toBeNull();
  });

  it("checks oversized selections by UTF-8 bytes", () => {
    const source = "éé";
    const view = viewWithSelection(source, 0, source.length);

    expect(sourceRangeAnchorFromSelection("cell-1", view, 6, 3)).toBeNull();
    expect(sourceRangeAnchorFromSelection("cell-1", view, 6, 4)?.exact_quote).toBe(source);
  });
});
