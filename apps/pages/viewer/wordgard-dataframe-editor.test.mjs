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
// Wordgard hit-tests clicks; jsdom has no layout.
dom.window.document.elementFromPoint = () => null;

const { Wordgard } = await import("wordgard/editor");
const { GardState, GardSelection } = await import("wordgard/state");
const { Leaf } = await import("wordgard/doc");
const { schema, Paragraph, PagesDataframe, HorizontalRule } = await import("./wordgard-model.mjs");
const { insertTable } = await import("./wordgard-tables.mjs");
const { wordgardDataframes, dataframeEventReachesEditor, enterDataframeGrid, GRID_ARROW_STEP } =
  await import("./wordgard-dataframes.mjs");
const { collapseAtomOnLeave } = await import("./image-selection.mjs");
const { PARQUET_MEDIA_TYPE } = await import("../shared/dataset-assets.mjs");

test("image widget selects its native image", async () => {
  const { PagesImage } = await import("./wordgard-model.mjs");
  const { wordgardImages } = await import("./wordgard-images.mjs");
  const state = GardState.create({
    doc: schema.doc([
      Paragraph.create([PagesImage.of({ src: "https://example.com/image.png", alt: "x" })]),
    ]),
    config: [schema.elements.map((e) => GardState.schemaElement.of(e)), wordgardImages()],
  });
  const editor = new Wordgard({ state, parent: document.body });
  try {
    editor.flush();
    const frame = editor.dom.querySelector(".pages-image");
    assert.equal(editor.nodeFromDOM(frame)?.node.type, PagesImage);
    frame.click();
    editor.flush();
    assert.ok(editor.state.selection instanceof GardSelection.Node);
    assert.ok(frame.closest(".wg-selected-node"));
  } finally {
    editor.dom.remove();
  }
});

for (const direction of ["insert", "delete"])
  for (const count of [1, 2])
    test(`remote ${direction} before ${count} changed Mermaid shapes updates the view`, async () => {
      const { CodeBlock, CodeBlockLanguage } = await import("./wordgard-model.mjs");
      const { wordgardWidgets } = await import("./wordgard-widgets.mjs");
      const { Transaction } = await import("wordgard/state");
      const paragraph = Paragraph.create([Leaf.text("Weekly usage review")]);
      const diagrams = Array.from({ length: count }, (_, i) =>
        CodeBlock.withMarks([CodeBlockLanguage.of("mermaid")]).create([
          Leaf.text(`graph TD; A --> B${i}`),
        ]),
      );
      const state = GardState.create({
        doc: schema.doc([
          ...(direction === "delete" ? [paragraph] : []),
          ...diagrams,
          Paragraph.create([Leaf.text("after")]),
        ]),
        config: [
          schema.elements.map((e) => GardState.schemaElement.of(e)),
          wordgardWidgets(),
          GardState.readOnly.of(true),
        ],
      });
      const editor = new Wordgard({ state, parent: document.body });
      try {
        editor.flush();
        editor.dispatch({
          changes:
            direction === "insert"
              ? { from: 0, insert: [paragraph] }
              : { from: 0, to: paragraph.length },
          annotations: Transaction.remote.of(true),
        });
        let pos = direction === "insert" ? paragraph.length : 0;
        const changes = diagrams.map((node) => {
          const from = pos + 2;
          pos += node.length;
          return { from, insert: [Leaf.text(" ")] };
        });
        editor.dispatch({
          changes,
          annotations: Transaction.remote.of(true),
        });
        assert.doesNotThrow(() => editor.flush());
        assert.equal(
          editor.contentDOM.querySelectorAll(
            "pre[data-language='mermaid'], .wordgard-diagram-block",
          ).length,
          count,
        );
        assert.equal(
          editor.state.doc.textContent().includes("Weekly usage review"),
          direction === "insert",
        );
        for (let i = 0; i < count; i++)
          assert.ok(editor.state.doc.textContent().includes(`g raph TD; A --> B${i}`));
      } finally {
        editor.dom.remove();
      }
    });

const pageId = "33333333-3333-4333-8333-333333333333";
const attrs = {
  src: `/api/pages/${pageId}/assets/${"a".repeat(64)}`,
  media_type: PARQUET_MEDIA_TYPE,
  title: "Usage",
};

// A dropped dataset usually lands at an insertion boundary at the end of the
// document. Drawing it there must not throw when the view updates.
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

// A press on the frame (the header or the select handle) selects the table as
// one node, so cut and paste act on it. A press inside Sift's canvas doesn't.

test("the editor asks its binding what each table draws, with the node's read attrs", () => {
  const asked = [];
  const state = GardState.create({
    doc: schema.doc([Paragraph.create([Leaf.text("hello")]), PagesDataframe.of(attrs)]),
    config: [
      ...schema.elements.map((e) => GardState.schemaElement.of(e)),
      wordgardDataframes({
        pageId,
        binding: (dataframe) => {
          asked.push(dataframe);
          return { source_id: "usage" };
        },
      }),
    ],
  });
  const editor = new Wordgard({ state, parent: document.body });
  try {
    editor.flush();
    assert.deepEqual(asked.at(-1), attrs);
    assert.equal(document.querySelectorAll("section.wordgard-dataframe-table").length, 1);
  } finally {
    editor.dom.remove();
  }
});

test("wordgardDataframes refuses to run without the Page it shows", () => {
  for (const options of [undefined, {}, { pageId: "" }, { pageId: 42 }])
    assert.throws(() => wordgardDataframes(options), /needs the Page id/);
});

test("Escape on a selected dataframe moves the caret off it; elsewhere it passes through", async () => {
  const { deselectDataframe } = await import("./wordgard-dataframes.mjs");
  for (const doc of [
    schema.doc([Paragraph.create([Leaf.text("hello")]), PagesDataframe.of(attrs)]),
    schema.doc([
      Paragraph.create([Leaf.text("hello")]),
      PagesDataframe.of(attrs),
      Paragraph.create([Leaf.text("after")]),
    ]),
  ]) {
    const state = GardState.create({
      doc,
      config: [
        ...schema.elements.map((e) => GardState.schemaElement.of(e)),
        wordgardDataframes({ pageId }),
      ],
    });
    const editor = new Wordgard({ state, parent: document.body });
    try {
      editor.dispatch({ selection: GardSelection.cursor(1) });
      assert.equal(deselectDataframe(editor), false);
      const block = editor.nodeFromDOM(document.querySelector("section.wordgard-dataframe-table"));
      editor.dispatch({ selection: GardSelection.node(block.pos, block.node) });
      assert.equal(deselectDataframe(editor), true);
      assert.equal(editor.state.selection instanceof GardSelection.Node, false);
      assert.ok(editor.state.doc.eq(doc));
    } finally {
      editor.dom.remove();
    }
  }
});

function editorWith(doc) {
  const state = GardState.create({
    doc,
    config: [
      ...schema.elements.map((e) => GardState.schemaElement.of(e)),
      wordgardDataframes({ pageId }),
      Wordgard.editable.of(true),
    ],
  });
  const editor = new Wordgard({ state, parent: document.body });
  editor.flush();
  const frame = () => document.querySelector("section.wordgard-dataframe-table");
  const select = () => {
    const block = editor.nodeFromDOM(frame());
    editor.dispatch({ selection: GardSelection.node(block.pos, block.node) });
  };
  return { editor, frame, select };
}
const withTable = () =>
  editorWith(schema.doc([Paragraph.create([Leaf.text("hello")]), PagesDataframe.of(attrs)]));

test("events inside the canvas stay with Sift; frame events reach Wordgard", () => {
  const frame = document.createElement("section");
  frame.innerHTML =
    '<div class="wordgard-dataframe-header"><div class="wordgard-dataframe-title"></div></div><div class="wordgard-dataframe-canvas"><span></span></div>';
  const at = (selector, type) => ({ type, target: frame.querySelector(selector) });
  for (const type of ["mousedown", "keydown", "copy"]) {
    assert.equal(dataframeEventReachesEditor(at(".wordgard-dataframe-canvas span", type)), false);
    assert.equal(dataframeEventReachesEditor(at(".wordgard-dataframe-title", type)), true);
  }
});

test("Enter on a selected table focuses Sift's grid; Escape there returns to the table", () => {
  const { editor, frame, select } = withTable();
  try {
    // Stand in for Sift's focusable grid container.
    const grid = document.createElement("div");
    grid.tabIndex = 0;
    frame().querySelector(".wordgard-dataframe-canvas").append(grid);
    editor.dispatch({ selection: GardSelection.cursor(1) });
    assert.equal(enterDataframeGrid(editor), false, "Enter passes through with no table selected");
    select();
    assert.equal(enterDataframeGrid(editor), true);
    assert.equal(document.activeElement, grid);
    editor.dispatch({ selection: GardSelection.cursor(1) });
    // Sift clears filters on its first Escape and prevents the default.
    const taken = new window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    grid.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    grid.dispatchEvent(taken);
    assert.equal(editor.state.selection instanceof GardSelection.Node, false);
    grid.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    assert.ok(editor.state.selection instanceof GardSelection.Node);
    assert.equal(editor.state.selection.node.type, PagesDataframe);
  } finally {
    editor.dom.remove();
  }
});

test("Enter before the grid has loaded keeps the selected table", () => {
  const { editor, select } = withTable();
  try {
    select();
    const before = editor.state.doc.toString();
    assert.equal(enterDataframeGrid(editor), true);
    // Through the editor's own key handling too: Enter's usual work would
    // replace the selected table with an empty paragraph.
    editor.contentDOM.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    assert.equal(editor.state.doc.toString(), before);
    assert.match(before, /PagesDataframe/);
  } finally {
    editor.dom.remove();
  }
});

test("focus moving to another block deselects the table; into its grid or a toolbar doesn't", () => {
  const { editor, frame, select } = withTable();
  const otherBlock = document.body.appendChild(document.createElement("wg-content"));
  const toolbar = document.body.appendChild(document.createElement("div"));
  try {
    const grid = frame().querySelector(".wordgard-dataframe-canvas");
    for (const relatedTarget of [grid, toolbar, null]) {
      select();
      assert.equal(collapseAtomOnLeave(editor, { relatedTarget }), false);
      assert.ok(editor.state.selection instanceof GardSelection.Node);
    }
    select();
    assert.equal(collapseAtomOnLeave(editor, { relatedTarget: otherBlock }), true);
    assert.equal(editor.state.selection instanceof GardSelection.Node, false);
  } finally {
    editor.dom.remove();
    otherBlock.remove();
    toolbar.remove();
  }
});

test("insertTable refuses to replace a selected node", () => {
  const { editor, select } = withTable();
  try {
    select();
    const before = editor.state.doc.toString();
    assert.equal(insertTable(editor), false);
    assert.equal(editor.state.doc.toString(), before);
    assert.match(before, /PagesDataframe/);
  } finally {
    editor.dom.remove();
  }
});

test("ArrowLeft and ArrowRight in the grid scroll it sideways and never move the editor caret", () => {
  const { editor, frame, select } = withTable();
  try {
    // Stand in for Sift's grid: a focusable container and a wider body.
    const grid = document.createElement("div");
    grid.tabIndex = 0;
    // A header that clips its label overflows too, and comes first.
    const header = grid.appendChild(document.createElement("div"));
    header.className = "sift-th";
    Object.defineProperty(header, "scrollWidth", { value: 200 });
    Object.defineProperty(header, "clientWidth", { value: 100 });
    const body = grid.appendChild(document.createElement("div"));
    body.className = "sift-viewport";
    let width = 800;
    Object.defineProperty(body, "scrollWidth", { get: () => width });
    Object.defineProperty(body, "clientWidth", { value: 300 });
    frame().querySelector(".wordgard-dataframe-canvas").append(grid);
    select();
    assert.equal(enterDataframeGrid(editor), true);
    const before = editor.state.selection;
    const press = (key, target = grid) => {
      const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    };
    // The browser's default would move the DOM caret out of the table.
    assert.equal(press("ArrowRight").defaultPrevented, true);
    assert.equal(press("ArrowRight").defaultPrevented, true);
    assert.equal(body.scrollLeft, 2 * GRID_ARROW_STEP);
    assert.equal(press("ArrowLeft").defaultPrevented, true);
    assert.equal(body.scrollLeft, GRID_ARROW_STEP);
    assert.ok(editor.state.selection.eq(before), "the editor selection stayed on the table");
    assert.equal(header.scrollLeft, 0, "a clipped header is never scrolled");
    // A table that fits its frame: the arrow is still kept from the editor,
    // and nothing scrolls.
    width = 300;
    assert.equal(press("ArrowRight").defaultPrevented, true);
    assert.equal(body.scrollLeft, GRID_ARROW_STEP);
    assert.equal(header.scrollLeft, 0);
    width = 800;
    // A key Sift handled itself (a header moving focus) is left to it.
    const cell = grid.appendChild(document.createElement("div"));
    cell.addEventListener("keydown", (event) => event.preventDefault());
    press("ArrowRight", cell);
    assert.equal(body.scrollLeft, GRID_ARROW_STEP);
    // Outside the canvas, arrows are the editor's: the grid doesn't scroll.
    press("ArrowRight", frame().querySelector(".wordgard-dataframe-title"));
    assert.equal(body.scrollLeft, GRID_ARROW_STEP);
  } finally {
    editor.dom.remove();
  }
});

test("insertTable refuses a node-selected rule, which has no atom label", () => {
  const state = GardState.create({
    doc: schema.doc([
      Paragraph.create([Leaf.text("above")]),
      HorizontalRule,
      Paragraph.create([Leaf.text("below")]),
    ]),
    config: schema.elements.map((e) => GardState.schemaElement.of(e)),
  });
  const editor = new Wordgard({ state, parent: document.body });
  try {
    let at = -1;
    editor.state.doc.content.reduce((pos, node) => {
      if (node.type === HorizontalRule.type) at = pos;
      return pos + node.size;
    }, 0);
    const rule = editor.state.doc.content.find((node) => node.type === HorizontalRule.type);
    editor.dispatch({ selection: GardSelection.node(at, rule) });
    assert.ok(editor.state.selection instanceof GardSelection.Node);
    const before = editor.state.doc.toString();
    assert.equal(insertTable(editor), false);
    assert.equal(editor.state.doc.toString(), before);
  } finally {
    editor.dom.remove();
  }
});

test("a tap on the title row (a click with no mousedown) selects the table", () => {
  const { editor, frame } = withTable();
  try {
    const title = frame().querySelector(".wordgard-dataframe-title");
    // On touch, Wordgard ignores mousedown and waits for a DOM selection that
    // a tap on the non-editable frame never makes. Only the click arrives.
    title.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
    const selection = editor.state.selection;
    assert.ok(selection instanceof GardSelection.Node, "the table is selected");
    assert.equal(selection.node.type, PagesDataframe);
    // A click inside the grid is Sift's, not a selection.
    editor.dispatch({ selection: GardSelection.cursor(1) });
    const canvas = frame().querySelector(".wordgard-dataframe-canvas");
    canvas.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
    assert.equal(editor.state.selection instanceof GardSelection.Node, false);
  } finally {
    editor.dom.remove();
  }
});

test("a tap on an already-selected table, or a modified click, dispatches nothing", () => {
  const { editor, frame } = withTable();
  try {
    const title = frame().querySelector(".wordgard-dataframe-title");
    const click = (init = {}) =>
      title.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }),
      );
    let dispatched = 0;
    const dispatch = editor.dispatch.bind(editor);
    editor.dispatch = (...args) => {
      dispatched++;
      return dispatch(...args);
    };
    click();
    assert.equal(dispatched, 1);
    assert.ok(editor.state.selection instanceof GardSelection.Node);
    click();
    assert.equal(dispatched, 1, "an already-selected table is selected again");
    // With the caret in text, modified clicks leave the selection alone.
    dispatch({ selection: GardSelection.cursor(1) });
    for (const modifier of ["shiftKey", "metaKey", "ctrlKey", "altKey"]) {
      click({ [modifier]: true });
      assert.equal(editor.state.selection instanceof GardSelection.Node, false, modifier);
    }
    assert.equal(dispatched, 1);
  } finally {
    editor.dom.remove();
  }
});
