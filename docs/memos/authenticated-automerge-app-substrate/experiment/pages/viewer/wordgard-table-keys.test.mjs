import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { JSDOM } from "jsdom";

// Wordgard mounts real DOM: give it a jsdom window for these key tests.
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
// jsdom has no layout. Wordgard measures after updates; report empty boxes.
const empty = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 });
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = empty;

const { Wordgard } = await import("wordgard/editor");
const { GardState, GardSelection } = await import("wordgard/state");
const { tables } = await import("wordgard/table");
const { Cell, HeaderCell } = await import("wordgard/types");
const { enableRich, textPath } = await import("../model/richtext.mjs");
const { decode, schema } = await import("./wordgard-model.mjs");
const { selectedTable, tableKeys } = await import("./wordgard-tables.mjs");

function editor(markdown) {
  const native = A.change(
    A.from({ blocks: { one: { id: "one", kind: "markdown", markdown } } }),
    (d) => enableRich(d, "one"),
  );
  const state = GardState.create({
    doc: decode(A.spans(native, textPath("one"))).doc,
    config: [...schema.elements.map((e) => GardState.schemaElement.of(e)), tables(), tableKeys],
  });
  return new Wordgard({ state, parent: document.body });
}

function press(wg, key, shiftKey = false) {
  const event = new dom.window.KeyboardEvent("keydown", {
    key,
    keyCode: 9,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  wg.contentDOM.dispatchEvent(event);
  return event;
}

test("Tab and Shift-Tab outside a table leave focus movement to the browser", () => {
  const wg = editor("First paragraph.\n\nSecond paragraph.");
  wg.dispatch({ selection: GardSelection.cursor(5) });
  assert.equal(press(wg, "Tab").defaultPrevented, false);
  assert.equal(press(wg, "Tab", true).defaultPrevented, false);
  assert.equal(wg.state.selection.head, 5, "the editor does not handle the key");
  wg.dom.remove();
});

test("Tab inside a table moves to the next cell and keeps the key", () => {
  const wg = editor("| a | b |\n| --- | --- |\n| c | d |");
  let inside = -1;
  for (let pos = 0; pos < wg.state.doc.length && inside < 0; pos++) {
    wg.dispatch({ selection: GardSelection.cursor(pos) });
    const cell = wg.state.sel.head.matchingParent((node) =>
      [Cell.type, HeaderCell.type].includes(node.type),
    );
    if (selectedTable(wg.state) && cell) inside = wg.state.selection.head;
  }
  assert.ok(inside >= 0, "fixture has a table cell");
  const event = press(wg, "Tab");
  assert.equal(event.defaultPrevented, true);
  assert.notEqual(wg.state.selection.head, inside);
  wg.dom.remove();
});
