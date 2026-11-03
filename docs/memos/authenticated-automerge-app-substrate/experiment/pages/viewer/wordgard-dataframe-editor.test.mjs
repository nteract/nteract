import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// Wordgard mounts real DOM: give it a jsdom window.
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
for (const name of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Text",
  "Range",
  "Selection",
  "DocumentFragment",
  "ShadowRoot",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "customElements",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "InputEvent",
  "FocusEvent",
  "MouseEvent",
])
  globalThis[name] ??= dom.window[name];
const empty = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 });
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = empty;

const { Wordgard } = await import("wordgard/editor");
const { GardState, GardSelection } = await import("wordgard/state");
const { Leaf } = await import("wordgard/doc");
const { schema, Paragraph, PagesDataframe } = await import("./wordgard-model.mjs");
const { wordgardDataframes } = await import("./wordgard-dataframes.mjs");
const { PARQUET_MEDIA_TYPE } = await import("../shared/dataset-assets.mjs");

const pageId = "33333333-3333-4333-8333-333333333333";
const attrs = {
  src: `/api/pages/${pageId}/assets/${"a".repeat(64)}`,
  media_type: PARQUET_MEDIA_TYPE,
  title: "Usage",
};

// The editor draws a dataframe with a tag shape. A shaped point decoration
// that first appears at an insertion boundary at the end of a document makes
// Wordgard 0.6.2 throw "Moving past end of document" when the view updates;
// that's where a dropped dataset usually lands.
for (const [where, at] of [
  ["at the end of the document", (doc) => doc.length - 1],
  ["mid-paragraph", () => 6],
])
  test(`inserting a dataframe ${where} updates the view`, () => {
    const state = GardState.create({
      doc: schema.doc([Paragraph.create([Leaf.text("hello world")])]),
      config: [
        ...schema.elements.map((e) => GardState.schemaElement.of(e)),
        wordgardDataframes({ pageId }),
      ],
    });
    const editor = new Wordgard({ state, parent: document.body });
    try {
      editor.dispatch({
        changes: { from: at(editor.state.doc), insert: [PagesDataframe.of(attrs)], fit: true },
        selection: GardSelection.cursor(1),
      });
      assert.doesNotThrow(() => editor.flush());
      assert.equal(
        editor.state.doc.content.filter((node) => node.type === PagesDataframe).length,
        1,
      );
      assert.equal(document.querySelectorAll("section.wordgard-dataframe-table").length, 1);
    } finally {
      editor.dom.remove();
    }
  });
