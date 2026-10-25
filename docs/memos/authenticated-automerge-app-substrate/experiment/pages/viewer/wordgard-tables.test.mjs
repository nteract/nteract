import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { Leaf } from "wordgard/doc";
import { history, undo } from "wordgard/history";
import { GardState, GardSelection } from "wordgard/state";
import { addColumn, addRow, deleteColumn, deleteRow, tables } from "wordgard/table";
import {
  enableRich,
  textPath,
  validateRich,
  blockMarkdown,
  parseMarkdown,
  exportMarkdown,
  nativeTableSpans,
} from "../model/richtext.mjs";
import {
  decode,
  encode,
  schema,
  Table,
  TableRow,
  Cell,
  HeaderCell,
  Alignment,
  Strong,
  OpaqueBlock,
} from "./wordgard-model.mjs";
import { createWordgardBinding } from "./wordgard-binding.mjs";

const path = textPath("one");
function fixture(source, initialDoc) {
  let doc =
    initialDoc ??
    A.change(A.from({ blocks: { one: { id: "one", kind: "markdown", markdown: source } } }), (d) =>
      enableRich(d, "one"),
    );
  const observers = new Set();
  return {
    get doc() {
      return doc;
    },
    change(fn) {
      const before = doc;
      doc = A.change(doc, fn);
      for (const fn of observers) fn({ remote: false, patchInfo: { before, after: doc } });
    },
    observeChange(fn) {
      observers.add(fn);
      return () => observers.delete(fn);
    },
  };
}
const source =
  "| Capability | Try it |\n| :--- | ---: |\n| Shared editing | **Two** tabs |\n| Comments | [Select words](https://example.com) |";
const editorState = (binding, selection) =>
  GardState.create({
    doc: binding.current.doc,
    selection,
    config: [
      schema.elements.map((e) => GardState.schemaElement.of(e)),
      tables({ cellContent: "inline", cellSpanning: false }),
    ],
  });
function textPosition(tree, text) {
  let result;
  tree.iterate((node, pos) => {
    if (node.isText && String(node.param).includes(text))
      result = pos + String(node.param).indexOf(text);
  });
  assert.notEqual(result, undefined, text);
  return result;
}

test("Markdown tables project into native cells with alignment, marks and empty cells", () => {
  for (const markdown of [
    source,
    "| A | B |\n| --- | --- |\n| | |",
    "Prose\n\n| A |\n| --- |\n| 🌊 |\n\nTail",
  ]) {
    const replica = fixture(markdown),
      spans = A.spans(replica.doc, path),
      tree = decode(spans).doc;
    assert.ok(spans.some((s) => s.type === "block" && String(s.value.type) === "table-cell"));
    assert.ok(decode(encode(tree)).doc.eq(tree));
    const rewritten = A.change(replica.doc, (d) => A.updateSpans(d, path, encode(tree)));
    validateRich(rewritten.blocks.one);
    assert.equal(blockMarkdown(rewritten.blocks.one), markdown);
  }
  const table = decode(A.spans(fixture(source).doc, path)).doc.content[0];
  assert.equal(table.type, Table.type);
  assert.equal(table.content[0].content[0].type, HeaderCell.type);
  assert.equal(table.content[1].content[0].type, Cell.type);
  assert.equal(table.content[0].content[1].mark(Alignment), "right");
  assert.ok(table.content[1].content[1].content[0].marks.some((mark) => mark.type === Strong.type));
});

test("table export reimports pipes, code, literal slashes, breaks, links and marks", () => {
  for (const markdown of [
    source,
    "| A | B |\n| --- | --- |\n| a\\|b | `a\\|b` |",
    "| A | B |\n| --- | --- |\n| a\\\\\\|b | c |",
    "| A | B |\n| --- | --- |\n| one<br>two | *🌊* |",
  ]) {
    const tree = parseMarkdown(markdown);
    assert.deepEqual(parseMarkdown(exportMarkdown(tree)).toJSON(), tree.toJSON());
  }
  assert.equal(nativeTableSpans("| A |\n| --- |\n| ~~unsupported~~ |"), null);
  assert.equal(nativeTableSpans("prose only"), null);
  assert.ok(nativeTableSpans(source));
});

test("typing into cells preserves the native text object and unrelated cell cursor", () => {
  const replica = fixture(source),
    binding = createWordgardBinding(replica, "one");
  const object = A.getObjectId(replica.doc.blocks.one, "richText");
  const kept = textPosition(binding.current.doc, "Select words"),
    target = textPosition(binding.current.doc, "Shared editing");
  const cursor = A.getCursor(replica.doc, path, binding.current.map.wgToAm[kept]);
  const before = replica.doc;
  binding.applyEditorTransaction(
    editorState(binding).update({ changes: { from: target, insert: [Leaf.text("Live ")] } }),
  );
  assert.equal(A.getObjectId(replica.doc.blocks.one, "richText"), object);
  assert.equal(
    replica.doc.blocks.one.richText[A.getCursorPosition(replica.doc, path, cursor)],
    "S",
  );
  assert.ok(blockMarkdown(replica.doc.blocks.one).includes("Live Shared editing"));
  assert.ok(
    A.diff(replica.doc, A.getHeads(before), A.getHeads(replica.doc)).every(
      (p) => p.action !== "del",
    ),
  );
  validateRich(replica.doc.blocks.one);
  binding.destroy();
});

test("independent edits in different table cells merge without a source replacement", () => {
  const base = fixture(source).doc,
    tree = decode(A.spans(base, path));
  const one = tree.map.wgToAm[textPosition(tree.doc, "Shared editing")];
  const two = tree.map.wgToAm[textPosition(tree.doc, "Select words")];
  const a = A.change(A.clone(base), (d) => A.splice(d, path, one, 0, "Live "));
  const b = A.change(A.clone(base), (d) => A.splice(d, path, two, 0, "These "));
  const merged = A.merge(a, b);
  validateRich(merged.blocks.one);
  assert.ok(blockMarkdown(merged.blocks.one).includes("Live Shared editing"));
  assert.ok(merged.blocks.one.richText.includes("These Select words"));
  assert.ok(decode(A.spans(merged, path)).doc.eq(decode(A.spans(A.merge(b, a), path)).doc));
});

test("native row and column operations keep untouched cell identities and text", () => {
  const replica = fixture(source),
    binding = createWordgardBinding(replica, "one");
  const keep = binding.current.map.wgToAm[textPosition(binding.current.doc, "Select words")];
  const cursor = A.getCursor(replica.doc, path, keep);
  const run = (command, arg) => {
    const position = textPosition(binding.current.doc, "Shared editing");
    const state = editorState(binding, GardSelection.cursor(position));
    const spec = command({ state }, arg);
    assert.ok(spec);
    binding.applyEditorTransaction(state.update(spec));
    validateRich(replica.doc.blocks.one);
    assert.equal(
      replica.doc.blocks.one.richText[A.getCursorPosition(replica.doc, path, cursor)],
      "S",
    );
  };
  run(addColumn, "before");
  assert.equal(binding.current.doc.content[0].content[0].content.length, 3);
  run(addRow, "after");
  assert.equal(binding.current.doc.content[0].content.length, 4);
  assert.ok(blockMarkdown(replica.doc.blocks.one).includes("Select words"));
  binding.destroy();
});

test("a concurrent row insertion and cell edit retain the target cell", () => {
  const base = fixture(source).doc,
    decoded = decode(A.spans(base, path));
  const table = decoded.doc.content[0];
  const inserted = schema.doc([
    Table.create([
      table.content[0],
      TableRow.create([Cell.create([Leaf.text("New row")]), Cell.create([])]),
      ...table.content.slice(1),
    ]),
  ]);
  const cursor = A.getCursor(
    base,
    path,
    decoded.map.wgToAm[textPosition(decoded.doc, "Select words")],
  );
  const a = A.change(A.clone(base), (d) => A.updateSpans(d, path, encode(inserted)));
  const b = A.change(A.clone(base), (d) =>
    A.splice(d, path, A.getCursorPosition(d, path, cursor), 0, "These "),
  );
  const merged = A.merge(a, b);
  validateRich(merged.blocks.one);
  assert.equal(decode(A.spans(merged, path)).doc.content[0].content.length, 4);
  assert.ok(merged.blocks.one.richText.includes("These Select words"));
  assert.ok(merged.blocks.one.richText.includes("New row"));
});

test("ragged concurrent table projections do not drop cells on Markdown export", () => {
  const native = schema.doc([
    Table.create([
      TableRow.create([HeaderCell.create([Leaf.text("Header")])]),
      TableRow.create([Cell.create([Leaf.text("One")]), Cell.create([Leaf.text("Keep me")])]),
    ]),
  ]);
  const replica = fixture(source);
  replica.change((d) => A.updateSpans(d, path, encode(native)));
  validateRich(replica.doc.blocks.one);
  const exported = blockMarkdown(replica.doc.blocks.one);
  const parsed = decode(nativeTableSpans(exported)).doc.content[0];
  assert.equal(parsed.content[0].content.length, 2);
  assert.equal(parsed.content[1].content[1].content[0].param, "Keep me");
});

test("HTML-looking text remains literal outside tables and unsupported mixed syntax stays opaque", () => {
  assert.equal(parseMarkdown("text<br>tail").firstChild.textContent, "text<br>tail");
  assert.equal(parseMarkdown(`${source}\n\n~~unknown~~`).firstChild.type.name, "raw");
});

test("row and column deletion preserve other cells, and inserting before the header preserves content", () => {
  for (const [command, arg, target] of [
    [deleteColumn, undefined, "Shared editing"],
    [deleteRow, undefined, "Shared editing"],
    [addRow, "before", "Capability"],
  ]) {
    const replica = fixture(source),
      binding = createWordgardBinding(replica, "one");
    const state = editorState(
      binding,
      GardSelection.cursor(textPosition(binding.current.doc, target)),
    );
    binding.applyEditorTransaction(state.update(command({ state }, arg)));
    validateRich(replica.doc.blocks.one);
    assert.ok(replica.doc.blocks.one.richText.includes("Select words"));
    const exported = decode(nativeTableSpans(blockMarkdown(replica.doc.blocks.one))).doc.content[0];
    assert.ok(exported.content[0].content.every((cell) => cell.type === HeaderCell.type));
    assert.ok(
      exported.content
        .slice(1)
        .every((row) => row.content.every((cell) => cell.type === Cell.type)),
    );
    binding.destroy();
  }
});

test("escaped literal br tags survive cell editing and Markdown export", () => {
  for (const cell of ["before\\<br>after", "before&lt;br&gt;after", "`before<br>after`"]) {
    const parsed = parseMarkdown(`| Header |\n| --- |\n| ${cell} |`);
    assert.equal(parsed.firstChild.child(1).firstChild.textContent, "before<br>after");
    assert.deepEqual(parseMarkdown(exportMarkdown(parsed)).toJSON(), parsed.toJSON());
  }
});

test("explicit opaque table conversion is one undoable native operation", () => {
  const replica = fixture(source);
  const original = schema.doc([OpaqueBlock.of({ source, importId: "fixture", kind: "markdown" })]);
  replica.change((d) => A.updateSpans(d, path, encode(original)));
  const binding = createWordgardBinding(replica, "one");
  let state = GardState.create({
    doc: binding.current.doc,
    config: [
      schema.elements.map((element) => GardState.schemaElement.of(element)),
      tables({ cellContent: "inline", cellSpanning: false }),
      history(),
    ],
  });
  const imported = decode(nativeTableSpans(source)).doc;
  const tr = state.update({
    changes: { from: 0, to: 1, insert: imported.slice(0, imported.length) },
  });
  binding.applyEditorTransaction(tr);
  state = tr.state;
  assert.equal(binding.current.doc.content[0].type, Table.type);
  validateRich(replica.doc.blocks.one);
  binding.applyEditorTransaction(state.update(undo({ state })));
  assert.ok(binding.current.doc.eq(original));
  assert.equal(blockMarkdown(replica.doc.blocks.one), source);
  binding.destroy();
});

test("concurrent row insertion before the displayed header does not duplicate cell text", () => {
  const markdown = "| H |\n| --- |\n| Value |",
    base = fixture(markdown).doc;
  const peers = [fixture(markdown, A.clone(base)), fixture(markdown, A.clone(base))];
  for (const replica of peers) {
    const binding = createWordgardBinding(replica, "one");
    const state = editorState(
      binding,
      GardSelection.cursor(textPosition(binding.current.doc, "H")),
    );
    binding.applyEditorTransaction(state.update(addRow({ state }, "before")));
    binding.destroy();
  }
  const merged = A.merge(peers[0].doc, peers[1].doc);
  assert.equal(decode(A.spans(merged, path)).doc.content[0].content.length, 4);
  assert.equal(merged.blocks.one.richText.match(/H/g)?.length, 1);
  assert.equal(merged.blocks.one.richText.match(/Value/g)?.length, 1);
  validateRich(merged.blocks.one);
});

test("concurrent header deletion retains surviving rows exactly once", () => {
  const markdown = "| H |\n| --- |\n| First |\n| Second |",
    base = fixture(markdown).doc;
  const peers = [fixture(markdown, A.clone(base)), fixture(markdown, A.clone(base))];
  for (const replica of peers) {
    const binding = createWordgardBinding(replica, "one");
    const state = editorState(
      binding,
      GardSelection.cursor(textPosition(binding.current.doc, "H")),
    );
    binding.applyEditorTransaction(state.update(deleteRow({ state })));
    binding.destroy();
  }
  const merged = A.merge(peers[0].doc, peers[1].doc);
  assert.equal(decode(A.spans(merged, path)).doc.content[0].content.length, 2);
  assert.equal(merged.blocks.one.richText.match(/First/g)?.length, 1);
  assert.equal(merged.blocks.one.richText.match(/Second/g)?.length, 1);
  validateRich(merged.blocks.one);
});
