import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import * as A from "@automerge/automerge";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { history, undo } from "prosemirror-history";
import {
  schema,
  parseMarkdown,
  exportMarkdown,
  RICH_FORMAT,
  setRichMarkdown,
  richDoc,
} from "../model/richtext.mjs";
import { bindRichEditor } from "./rich-binding.mjs";
import {
  CodeBlockView,
  codeBlockEditing,
  turnFenceIntoCode,
  leaveCodeBlock,
} from "./code-blocks.mjs";

function editor(doc) {
  const view = {
    state: EditorState.create({ schema, doc, plugins: [history()] }),
    editable: true,
    dispatch(tr) {
      view.state = view.state.apply(tr);
    },
  };
  view.select = (pos) =>
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  return view;
}

for (const [fence, language] of [
  ["```", ""],
  ["```mermaid", "mermaid"],
  ["```c++", "c++"],
]) {
  test(`a ${fence} fence creates a persisted code node and undo restores the literal fence`, () => {
    const view = editor(
      schema.node("doc", null, [schema.node("paragraph", null, schema.text(fence))]),
    );
    view.select(fence.length + 1);
    assert.ok(turnFenceIntoCode(view.state, view.dispatch));
    assert.equal(view.state.doc.firstChild.type.name, "code_block");
    assert.equal(view.state.doc.firstChild.attrs.params, language);
    assert.equal(view.state.doc.firstChild.textContent, "");
    assert.equal(view.state.selection.from, 1);
    assert.ok(undo(view.state, view.dispatch));
    assert.equal(view.state.doc.firstChild.type.name, "paragraph");
    assert.equal(view.state.doc.textContent, fence);
  });
}

test("fence conversion respects prose, parent constraints, composition and readonly mode", () => {
  for (const [source, pos] of [
    ["Prefix ```", 11],
    ["``` trailing", 13],
    ["```mermaid", 4],
  ]) {
    const view = editor(
      schema.node("doc", null, [schema.node("paragraph", null, schema.text(source))]),
    );
    view.select(Math.min(pos, source.length + 1));
    assert.equal(turnFenceIntoCode(view.state, view.dispatch), false);
  }
  const inList = editor(
    schema.node("doc", null, [
      schema.node("bullet_list", null, [
        schema.node("list_item", null, [schema.node("paragraph", null, schema.text("```"))]),
      ]),
    ]),
  );
  inList.select(6);
  assert.equal(
    turnFenceIntoCode(inList.state, inList.dispatch),
    false,
    "do not invalidate the first paragraph of a list item",
  );
  const view = editor(
    schema.node("doc", null, [schema.node("paragraph", null, schema.text("```"))]),
  );
  view.select(4);
  const plugin = codeBlockEditing();
  view.composing = true;
  assert.equal(plugin.props.handleKeyDown(view, { key: "Enter" }), false);
  view.composing = false;
  view.editable = false;
  assert.equal(plugin.props.handleTextInput(view, 4, 4, " "), false);
  view.editable = true;
  assert.ok(plugin.props.handleTextInput(view, 4, 4, " "));
  assert.equal(view.state.doc.firstChild.type.name, "code_block");
});

test("code exits to prose without losing source, including blank-line exit and undo", () => {
  const view = editor(parseMarkdown("```python\nprint(1)\n```"));
  view.select(4);
  assert.equal(leaveCodeBlock(view.state, view.dispatch, true), false);
  assert.ok(leaveCodeBlock(view.state, view.dispatch));
  assert.equal(view.state.doc.childCount, 2);
  assert.equal(view.state.doc.lastChild.type.name, "paragraph");
  assert.equal(view.state.doc.firstChild.textContent, "print(1)");
  assert.equal(view.state.selection.$from.parent.type.name, "paragraph");
  assert.ok(undo(view.state, view.dispatch));
  view.select(view.state.doc.firstChild.nodeSize - 1);
  view.dispatch(view.state.tr.insertText("\n\n"));
  assert.ok(leaveCodeBlock(view.state, view.dispatch, true));
  assert.equal(view.state.doc.firstChild.textContent, "print(1)");
  assert.equal(view.state.selection.$from.parent.type.name, "paragraph");
  assert.ok(undo(view.state, view.dispatch));
  assert.equal(view.state.doc.firstChild.textContent, "print(1)\n\n");
});

test("language and code edits travel through the real binding and survive Automerge save/load", (t) => {
  let doc = A.from({
    blocks: {
      code: { id: "code", kind: "markdown", format: RICH_FORMAT, markdown: "", richText: "" },
    },
  });
  doc = A.change(doc, (d) => setRichMarkdown(d, "code", "```\ngraph TD\nA --> B\n```"));
  const observers = new Set();
  const replica = {
    get doc() {
      return doc;
    },
    change(fn) {
      const before = doc;
      doc = A.change(doc, fn);
      for (const observer of observers)
        observer({
          doc,
          patches: A.diff(doc, A.getHeads(before), A.getHeads(doc)),
          patchInfo: { before, after: doc },
          remote: false,
        });
    },
    observeChange(fn) {
      observers.add(fn);
      return () => observers.delete(fn);
    },
  };
  const binding = bindRichEditor(replica, "code");
  const view = {
    state: EditorState.create({ schema, doc: binding.pmDoc, plugins: [binding.plugin, history()] }),
    dispatch(tr) {
      view.state = view.state.apply(tr);
    },
  };
  const projection = binding.plugin.spec.view(view);
  t.after(() => {
    projection.destroy();
    binding.destroy();
  });
  view.dispatch(
    view.state.tr.setNodeMarkup(0, undefined, {
      ...view.state.doc.firstChild.attrs,
      params: "mermaid",
    }),
  );
  view.dispatch(view.state.tr.insertText("[Result]", view.state.doc.firstChild.nodeSize - 1));
  const reloaded = richDoc(A.load(A.save(doc)).blocks.code);
  assert.deepEqual(reloaded.toJSON(), view.state.doc.toJSON());
  assert.equal(exportMarkdown(reloaded), "```mermaid\ngraph TD\nA --> B[Result]\n```");
  assert.ok(undo(view.state, view.dispatch));
  assert.equal(exportMarkdown(richDoc(doc.blocks.code)), "```\ngraph TD\nA --> B\n```");
});

function domFixture(t) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Option: globalThis.Option,
  };
  globalThis.window = dom.window;
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  globalThis.document = dom.window.document;
  globalThis.Option = dom.window.Option;
  t.after(() => {
    dom.window.close();
    Object.assign(globalThis, previous);
  });
  return dom.window;
}
const waitForRender = () => new Promise((resolve) => setTimeout(resolve, 130));

test("Mermaid preview stays local, ignores renderer mutations and rejects late stale renders", async (t) => {
  domFixture(t);
  const view = editor(parseMarkdown("```mermaid\ngraph TD\nA --> B\n```"));
  view.focus = () => {};
  let resolveRenderer,
    renders = 0;
  const nodeView = new CodeBlockView(view.state.doc.firstChild, view, () => 0, {
    loadRenderer: () =>
      new Promise((resolve) => {
        resolveRenderer = resolve;
      }),
  });
  t.after(() => nodeView.destroy());
  const before = exportMarkdown(view.state.doc);
  assert.equal(nodeView.dom.dataset.mode, "preview");
  assert.equal(nodeView.pre.hidden, true);
  assert.equal(nodeView.ignoreMutation({ type: "childList", target: nodeView.canvas }), true);
  assert.equal(
    nodeView.ignoreMutation({ type: "characterData", target: nodeView.contentDOM }),
    false,
  );
  await waitForRender();
  nodeView.buttons.source.click();
  resolveRenderer({
    mountMermaid: () => {
      renders++;
      return { destroy() {} };
    },
  });
  await Promise.resolve();
  assert.equal(renders, 0, "switching to source cancels an outstanding render");
  assert.equal(nodeView.pre.hidden, false);
  assert.equal(nodeView.buttons.source.getAttribute("aria-pressed"), "true");
  assert.equal(exportMarkdown(view.state.doc), before, "view mode is not a CRDT mutation");
});

test("invalid diagrams leave source accessible; remote updates render and readonly disables language edits", async (t) => {
  domFixture(t);
  const view = editor(parseMarkdown("```mermaid\ninvalid diagram\n```"));
  view.focus = () => {};
  let renders = 0,
    destroyed = 0;
  const nodeView = new CodeBlockView(view.state.doc.firstChild, view, () => 0, {
    loadRenderer: async () => ({
      mountMermaid(element, source, _id, callbacks) {
        renders++;
        if (source === "invalid diagram") throw new Error("Unsupported diagram");
        element.textContent = "local rendered output";
        callbacks.onRender();
        return {
          destroy() {
            destroyed++;
          },
        };
      },
    }),
  });
  t.after(() => nodeView.destroy());
  await waitForRender();
  assert.match(nodeView.status.textContent, /Diagram unavailable.*Unsupported diagram/);
  assert.equal(nodeView.buttons.source.hidden, false);
  const updated = parseMarkdown("```mermaid\ngraph TD\nA --> B\n```").firstChild;
  nodeView.update(updated);
  await waitForRender();
  assert.equal(renders, 2);
  assert.equal(nodeView.status.hidden, true);
  assert.equal(nodeView.canvas.textContent, "local rendered output");
  view.editable = false;
  nodeView.update(updated);
  assert.equal(nodeView.select.disabled, true);
  nodeView.buttons.source.click();
  assert.equal(destroyed, 1);
  assert.equal(nodeView.pre.hidden, false);
});

test("the shared notebook renderer renders the supplied flowchart through its SVG sanitizer", async (t) => {
  domFixture(t);
  const source =
    "graph TD\nA[Ingest] --> B{Valid?}\nB -->|Yes| C[Transform]\nB -->|No| D[Quarantine]\nC --> E[(Warehouse)]\nC --> F[Metrics]\nF --> G[Dashboard]\nE --> G";
  const view = editor(
    schema.node("doc", null, [
      schema.node("code_block", { params: "mermaid" }, schema.text(source)),
    ]),
  );
  const nodeView = new CodeBlockView(view.state.doc.firstChild, view, () => 0);
  document.body.append(nodeView.dom);
  t.after(() => nodeView.destroy());
  for (let attempt = 0; attempt < 20 && !nodeView.canvas.querySelector("svg"); attempt++)
    await waitForRender();
  assert.ok(nodeView.canvas.querySelector("svg"), nodeView.status.textContent);
  assert.match(nodeView.canvas.textContent, /Ingest/);
  assert.match(nodeView.canvas.textContent, /Dashboard/);
  assert.equal(nodeView.canvas.querySelector("script,foreignObject,iframe,image,use,a"), null);
  assert.equal(view.state.doc.textContent, source, "rendered SVG stays out of document source");
});

test("Preview moves the caret outside source and keyboard entry reveals source before placing selection", (t) => {
  domFixture(t);
  const view = editor(parseMarkdown("```mermaid\ngraph TD\nA --> B\n```"));
  view.focus = () => {};
  const nodeView = new CodeBlockView(view.state.doc.firstChild, view, () => 0, {
    loadRenderer: async () => ({}),
  });
  t.after(() => nodeView.destroy());
  document.body.append(nodeView.dom);
  nodeView.contentDOM.textContent = view.state.doc.firstChild.textContent;
  view.select(5);
  nodeView.buttons.preview.click();
  assert.ok(view.state.selection instanceof NodeSelection);
  assert.equal(nodeView.pre.hidden, true);
  view.domAtPos = (position) => ({ node: nodeView.contentDOM.firstChild, offset: position - 1 });
  nodeView.setSelection(4, 4, document);
  assert.equal(nodeView.pre.hidden, false);
  assert.equal(nodeView.dom.dataset.mode, "source");
  assert.equal(document.getSelection().anchorNode, nodeView.contentDOM.firstChild);
  assert.equal(document.getSelection().anchorOffset, 4);
});
