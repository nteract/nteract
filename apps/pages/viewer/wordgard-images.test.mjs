// The Page image widget in a mounted editor: a node selection must not redraw
// the img, and its corner controls expand and comment on the image.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// Wordgard mounts real DOM: give it a jsdom window. jsdom has no layout.
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
const { schema, Paragraph, PagesImage } = await import("./wordgard-model.mjs");
const { COMMENT_ACCESS_EVENT, wordgardImages } = await import("./wordgard-images.mjs");

function mount({ editable = true, ...options } = {}) {
  const doc = schema.doc([
    Paragraph.create([Leaf.text("Intro")]),
    Paragraph.create([
      Leaf.text("Before "),
      PagesImage.of({ src: "https://example.com/cat.png", alt: "A cat" }),
      Leaf.text(" after"),
    ]),
  ]);
  const state = GardState.create({
    doc,
    config: [
      ...schema.elements.map((e) => GardState.schemaElement.of(e)),
      wordgardImages(options),
      GardState.readOnly.of(!editable),
      Wordgard.editable.of(editable),
    ],
  });
  const editor = new Wordgard({ state, parent: document.body });
  editor.flush();
  const frame = editor.contentDOM.querySelector(".pages-image");
  return { editor, frame, img: () => frame.querySelector(".pages-image-slot > img") };
}

/** Load the drawn img at a natural size, as a browser would. */
function load(img, width = 800, height = 600) {
  Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
  img.onload();
}

const click = (target, type = "click") =>
  target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true }));

test("selecting and deselecting an image keeps the drawn img, so the line keeps its height", () => {
  const { editor, frame, img } = mount();
  try {
    const drawn = img();
    load(drawn);
    const { pos, node } = editor.nodeFromDOM(frame);
    editor.dispatch({ selection: GardSelection.node(pos, node) });
    editor.flush();
    assert.ok(frame.closest(".wg-selected-node"), "Wordgard wrapped the image");
    assert.equal(img(), drawn);
    assert.equal(frame.dataset.imageState, "ready");
    editor.dispatch({ selection: { anchor: 1 } });
    editor.flush();
    assert.equal(frame.closest(".wg-selected-node"), null);
    assert.equal(img(), drawn);
  } finally {
    editor.dom.remove();
  }
});

test("Expand shows once the image loads and opens a copy in the viewer", () => {
  const { editor, frame, img } = mount({ expand: true });
  try {
    const expand = frame.querySelector(".wordgard-diagram-maximize");
    assert.equal(expand.getAttribute("aria-label"), "Expand image");
    assert.equal(expand.hidden, true, "nothing to expand before the image loads");
    load(img());
    assert.equal(expand.hidden, false);
    click(expand);
    const viewer = document.querySelector(".diagram-viewer");
    assert.ok(viewer);
    assert.equal(viewer.querySelector(".diagram-viewer-title").textContent, "A cat");
    assert.equal(viewer.querySelector(".diagram-viewer-content > img").src, img().src);
    viewer.querySelector(".diagram-viewer-close").click();
    assert.equal(document.querySelector(".diagram-viewer"), null);
    assert.equal(
      editor.state.selection instanceof GardSelection.Node,
      false,
      "Expand doesn't select the node",
    );
  } finally {
    editor.dom.remove();
  }
});

test("editing, a click selects the image and a double-click expands it", () => {
  const { editor, frame, img } = mount({ expand: true });
  try {
    load(img());
    click(img());
    editor.flush();
    assert.ok(editor.state.selection instanceof GardSelection.Node);
    assert.equal(document.querySelector(".diagram-viewer"), null);
    click(img(), "dblclick");
    const viewer = document.querySelector(".diagram-viewer");
    assert.ok(viewer);
    viewer.querySelector(".diagram-viewer-close").click();
  } finally {
    editor.dom.remove();
  }
});

test("reading, a click on a loaded image expands it; before it loads, it selects", () => {
  const { editor, frame, img } = mount({ editable: false, expand: true });
  try {
    click(img());
    assert.equal(document.querySelector(".diagram-viewer"), null);
    load(img());
    click(img());
    const viewer = document.querySelector(".diagram-viewer");
    assert.ok(viewer);
    viewer.querySelector(".diagram-viewer-close").click();
  } finally {
    editor.dom.remove();
  }
});

test("Comment on image follows comment access and opens on its own node", () => {
  let allowed = false;
  const opened = [];
  const { editor, frame } = mount({
    comments: { allowed: () => allowed, open: (target) => opened.push(target) },
  });
  try {
    const comment = frame.querySelector("[data-image-comment]");
    assert.equal(comment.getAttribute("aria-label"), "Comment on image");
    assert.equal(comment.hidden, true);
    allowed = true;
    comment.dispatchEvent(new dom.window.Event(COMMENT_ACCESS_EVENT));
    assert.equal(comment.hidden, false);
    click(comment);
    assert.deepEqual(opened, [frame]);
    assert.equal(
      editor.state.selection instanceof GardSelection.Node,
      false,
      "the control's click doesn't also reach Wordgard",
    );
  } finally {
    editor.dom.remove();
  }
});

test("without options an image draws no controls", () => {
  const { editor, frame } = mount();
  try {
    assert.equal(frame.querySelector(".wordgard-diagram-actions"), null);
  } finally {
    editor.dom.remove();
  }
});
