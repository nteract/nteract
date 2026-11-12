import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// Wordgard mounts real DOM: give it a jsdom window. jsdom has no layout, so
// each test says which element the pointer is over.
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
const { GardState } = await import("wordgard/state");
const { decode, schema } = await import("./wordgard-model.mjs");
const { projectChanges } = await import("./wordgard-projection.mjs");
const { codeHighlighting } = await import("./code-highlight.mjs");

const block = (type, params) => ({
  type: "block",
  value: { type, parents: [], attrs: params === undefined ? {} : { params }, isEmbed: false },
});
const CODE = "interface A<T> { a: T }\ntype B = A<string>;";
const before = () =>
  decode([
    block("paragraph"),
    { type: "text", value: "First paragraph with some words." },
    block("code-block", "ts"),
    { type: "text", value: CODE },
    block("paragraph"),
    { type: "text", value: "Last paragraph." },
  ]).doc;
// A peer deletes the first paragraph: everything after it moves.
const after = () =>
  decode([
    block("code-block", "ts"),
    { type: "text", value: CODE },
    block("paragraph"),
    { type: "text", value: "Last paragraph." },
  ]).doc;

function mount() {
  const state = GardState.create({
    doc: before(),
    config: [...schema.elements.map((e) => GardState.schemaElement.of(e)), codeHighlighting],
  });
  return new Wordgard({ state, parent: document.body });
}
const pointAt = (element) => {
  document.elementFromPoint = () => element;
};

// Between a dispatched change and the next flush, the drawn tiles still
// describe the previous document. Wordgard's posAtCoords must walk them with
// the state they were drawn from, then map through the pending change.
test("a position under the pointer resolves while a remote change waits for its flush", () => {
  const wg = mount();
  try {
    const elements = [...wg.contentDOM.querySelectorAll("p, pre, pre *")];
    assert.ok(elements.some((element) => element.tagName === "PRE"));
    wg.dispatch({ changes: projectChanges(wg.state.doc, after()) });
    assert.equal(wg.state.doc.eq(after()), true, "the change is in the state");
    for (const element of elements) {
      pointAt(element);
      const { pos } = wg.posAtCoords({ x: 1, y: 1 });
      assert.ok(
        Number.isSafeInteger(pos) && pos >= 0 && pos <= wg.state.doc.length,
        `${element.tagName}: ${pos} is a position in the new document`,
      );
    }
  } finally {
    wg.dom.remove();
  }
});

// The same race inside a pointer gesture: a drag step that lands after a
// remote change must extend the selection, not throw out of Wordgard's
// mousemove listener, and the release must end the gesture.
test("a drag step after a remote change extends the selection and the release ends it", () => {
  const wg = mount();
  const errors = [];
  const onError = (event) => {
    errors.push(event.error ?? event.message);
    event.preventDefault();
  };
  dom.window.addEventListener("error", onError);
  try {
    const [first, pre] = wg.contentDOM.querySelectorAll("p, pre");
    const mouse = (type, target, options = {}) =>
      target.dispatchEvent(
        new dom.window.MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: type === "mouseup" ? 0 : 1,
          detail: 1,
          clientX: 0,
          clientY: 0,
          ...options,
        }),
      );
    pointAt(first);
    mouse("mousedown", first);
    assert.ok(wg.inputState.mouseSelection, "the gesture started");
    wg.dispatch({ changes: projectChanges(wg.state.doc, after()) });
    pointAt(pre);
    mouse("mousemove", document.body, { clientX: 40, clientY: 40 });
    assert.deepEqual(errors, [], "the drag step did not throw");
    mouse("mouseup", document.body, { clientX: 40, clientY: 40 });
    assert.equal(wg.inputState.mouseSelection, null, "the release ended the gesture");
    const { from, to } = wg.state.selection;
    assert.ok(from >= 0 && to <= wg.state.doc.length);
  } finally {
    dom.window.removeEventListener("error", onError);
    wg.dom.remove();
  }
});

// A click inside the selection selects on release. When that release lands
// after a remote change, the select must not throw: a throw skips the
// gesture's teardown, and the editor then keeps following every held-button
// mousemove on the page until the pointer moves with no button down.
test("a click released inside the selection after a remote change ends its gesture", async () => {
  const { GardSelection } = await import("wordgard/state");
  const wg = mount();
  const errors = [];
  const onError = (event) => {
    errors.push(event.error ?? event.message);
    event.preventDefault();
  };
  dom.window.addEventListener("error", onError);
  try {
    const [first, pre] = wg.contentDOM.querySelectorAll("p, pre");
    wg.dispatch({ selection: GardSelection.range(3, 20) });
    const mouse = (type, target) =>
      target.dispatchEvent(
        new dom.window.MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: type === "mouseup" ? 0 : 1,
          detail: 1,
        }),
      );
    // With no DOM range to measure, Wordgard counts the click as inside the
    // selection (jsdom has no layout to say otherwise).
    document.getSelection().removeAllRanges();
    pointAt(first);
    mouse("mousedown", first);
    assert.equal(wg.inputState.mouseSelection?.dragging, null, "a click in the selection");
    wg.dispatch({ changes: projectChanges(wg.state.doc, after()) });
    pointAt(pre);
    mouse("mouseup", document.body);
    assert.deepEqual(errors, [], "the release did not throw");
    assert.equal(wg.inputState.mouseSelection, null, "the release ended the gesture");
  } finally {
    dom.window.removeEventListener("error", onError);
    wg.dom.remove();
  }
});
