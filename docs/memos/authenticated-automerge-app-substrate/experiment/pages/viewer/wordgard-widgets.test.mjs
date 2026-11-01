import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { Leaf } from "wordgard/doc";
import { GardState, GardSelection, Transaction } from "wordgard/state";
import { history, undo } from "wordgard/history";
import { schema, CodeBlock, CodeBlockLanguage } from "./wordgard-model.mjs";

// These tests exercise native editor transactions; styles and SVG mounting
// are qualified separately by the real-browser Wordgard smoke.
const { wordgardWidgets, selectCodeLanguage, diagramFrame } =
  await import("./wordgard-widgets.mjs");

function withDocument(run) {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const previous = globalThis.document;
  globalThis.document = window.document;
  try {
    return run();
  } finally {
    globalThis.document = previous;
    window.close();
  }
}

// The renderer draws a diagram's title inside its SVG; the header must not
// repeat it or label the block as Mermaid.
test("a titled diagram has no visible header label and is named by its title", () =>
  withDocument(() => {
    const { dom, header } = diagramFrame("---\ntitle: Checkout flow\n---\nflowchart LR\nA --> B");
    assert.equal(dom.getAttribute("aria-label"), "Checkout flow");
    assert.equal(header.childElementCount, 0);
    assert.equal(dom.textContent, "");
  }));

test("an untitled diagram has no visible header label and a generic name", () =>
  withDocument(() => {
    const { dom, header } = diagramFrame("flowchart LR\nA --> B");
    assert.equal(dom.getAttribute("aria-label"), "Diagram");
    assert.equal(header.childElementCount, 0);
    assert.equal(dom.textContent, "");
  }));

test("an HTML-looking title stays an attribute value, never markup", () =>
  withDocument(() => {
    const title = "<img src=x onerror=alert(1)><b>bold</b>";
    const { dom } = diagramFrame(`---\ntitle: ${title}\n---\ngraph TD`);
    assert.equal(dom.getAttribute("aria-label"), title);
    assert.equal(dom.querySelector("img, b"), null);
    assert.equal(dom.textContent, "");
  }));

function editorFixture(source = "graph TD; A --> B", language) {
  const widgets = wordgardWidgets();
  const tag = language ? CodeBlock.withMarks([CodeBlockLanguage.of(language)]) : CodeBlock;
  const editor = {
    state: GardState.create({
      doc: schema.doc([tag.create(source ? [Leaf.text(source)] : [])]),
      config: [schema.elements.map((e) => GardState.schemaElement.of(e)), widgets, history()],
    }),
    editable: true,
    focused: null,
    dispatch(spec) {
      this.state = this.state.update(spec).state;
    },
    nodeDOM() {
      return { querySelector: () => ({ focus: () => (editor.focused = "preview") }) };
    },
    focus() {
      this.focused = "source";
    },
  };
  return {
    editor,
    block: () => ({ pos: 0, node: editor.state.doc.nodeAt(0) }),
    sourceIsOpen: () => editor.state.field(widgets[0]).has(0),
  };
}

test("choosing Mermaid renders an edited code block without a second Preview action", () => {
  const { editor, block, sourceIsOpen } = editorFixture();
  editor.dispatch({ selection: GardSelection.cursor(6) });
  assert.equal(sourceIsOpen(), true);
  const source = editor.state.doc.textContent();
  assert.equal(selectCodeLanguage(editor, block(), "mermaid"), true);
  assert.equal(block().node.mark(CodeBlockLanguage), "mermaid");
  assert.equal(sourceIsOpen(), false);
  assert.equal(editor.state.selection.head, 0);
  assert.equal(editor.focused, "preview");
  assert.equal(editor.state.doc.textContent(), source);
  editor.dispatch(undo(editor));
  assert.equal(block().node.mark(CodeBlockLanguage), undefined);
  assert.equal(editor.state.doc.textContent(), source);
});

test("choosing Mermaid on empty code keeps an editable source caret", () => {
  const { editor, block, sourceIsOpen } = editorFixture("");
  editor.dispatch({ selection: GardSelection.cursor(1) });
  selectCodeLanguage(editor, block(), "mermaid");
  assert.equal(block().node.mark(CodeBlockLanguage), "mermaid");
  assert.equal(sourceIsOpen(), true);
  assert.equal(editor.state.selection.head, 1);
  assert.equal(editor.focused, "source");
});

test("a peer's language choice preserves local source editing but previews in an untouched editor", () => {
  for (const active of [false, true]) {
    const { editor, sourceIsOpen } = editorFixture();
    if (active) editor.dispatch({ selection: GardSelection.cursor(6) });
    editor.dispatch({
      changes: { from: 0, add: CodeBlockLanguage.of("mermaid") },
      annotations: Transaction.remote.of(true),
    });
    assert.equal(sourceIsOpen(), active);
    assert.equal(editor.state.selection.head, active ? 6 : 0);
  }
});

test("explicit source editing survives remote edits and other language choices stay editable", () => {
  const { editor, block, sourceIsOpen } = editorFixture(undefined, "mermaid");
  editor.dispatch({ selection: GardSelection.cursor(6) });
  editor.dispatch({
    changes: { from: 2, insert: [Leaf.text("x")] },
    annotations: Transaction.remote.of(true),
  });
  assert.equal(sourceIsOpen(), true);
  selectCodeLanguage(editor, block(), "javascript");
  assert.equal(block().node.mark(CodeBlockLanguage), "javascript");
  assert.equal(sourceIsOpen(), true);
  assert.equal(editor.focused, "source");
  selectCodeLanguage(editor, block(), "");
  assert.equal(block().node.mark(CodeBlockLanguage), undefined);
});

test("read-only language selection cannot mutate or focus the editor", () => {
  const { editor, block } = editorFixture();
  editor.editable = false;
  const before = editor.state;
  assert.equal(selectCodeLanguage(editor, block(), "mermaid"), false);
  assert.equal(editor.state, before);
  assert.equal(editor.focused, null);
});
