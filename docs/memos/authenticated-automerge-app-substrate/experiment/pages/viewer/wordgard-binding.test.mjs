import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { GardState, GardSelection, Transaction } from "wordgard/state";
import { history, undo, redo } from "wordgard/history";
import { Command, deleteUnit, enter, toggleMark } from "wordgard/command";
import { codeBlock, codeBlockLanguage, orderedList } from "wordgard/schema";
import { createPeer, connectPeers, closePeers, eventually } from "../../backend.mjs";
import { applyPageOperation, createPageData, initializePage, projectPage } from "../model/page.mjs";
import { orderedBlockIds } from "../model/order.mjs";
import { Leaf, Slice } from "wordgard/doc";
import { enableRich, textPath, blockMarkdown } from "../model/richtext.mjs";
import {
  schema,
  Paragraph,
  Strong,
  Emphasis,
  PagesLink,
  Heading,
  CodeBlock,
  OrderedList,
  ListItem,
  CodeBlockLanguage,
  PagesImage,
  PagesHighlight,
  decode,
  encode,
} from "./wordgard-model.mjs";
import { MARK_REGISTRY } from "../model/marks.mjs";
import FEATURE_FILE from "../model/features.json" with { type: "json" };
import {
  documentFeatures,
  featureRegistry,
  installFeatureRegistryForTests,
} from "../model/schema-features.mjs";
import {
  commitEditorTransactions,
  createWordgardBinding,
  remoteEditorPosition,
  wordgardCodeNewlines,
  wordgardHistory,
  wordgardListStarts,
} from "./wordgard-binding.mjs";
import { projectChanges } from "./wordgard-projection.mjs";
import { encode as previousEncode } from "../test/wordgard-encode-d53a6e64b.mjs";
function fixture(markdown = "hello 🌊 world") {
  let doc = A.change(A.from({ blocks: { one: { id: "one", kind: "markdown", markdown } } }), (d) =>
    enableRich(d, "one"),
  );
  const observers = new Set();
  const publish = (before, after, remote) => {
    for (const fn of observers)
      fn({
        remote,
        patches: A.diff(after, A.getHeads(before), A.getHeads(after)),
        patchInfo: { before, after },
      });
  };
  return {
    get doc() {
      return doc;
    },
    change(fn) {
      const before = doc;
      doc = A.change(doc, fn);
      publish(before, doc, false);
    },
    receive(next) {
      const before = doc;
      doc = A.merge(doc, next);
      publish(before, doc, true);
    },
    observeChange(fn) {
      observers.add(fn);
      return () => observers.delete(fn);
    },
    get observerCount() {
      return observers.size;
    },
  };
}
const state = (binding) =>
  GardState.create({
    doc: binding.current.doc,
    config: schema.elements.map((e) => GardState.schemaElement.of(e)),
  });
test("typing and formatting retain native object identity and exact implicit offsets", () => {
  const replica = fixture(),
    binding = createWordgardBinding(replica, "one");
  const object = A.getObjectId(replica.doc.blocks.one, "richText"),
    cursor = A.getCursor(replica.doc, textPath("one"), 9);
  binding.applyEditorTransaction(
    state(binding).update({ changes: { from: 1, insert: [Leaf.text("New ")] } }),
  );
  assert.equal(replica.doc.blocks.one.richText, "New hello 🌊 world");
  assert.equal(A.spans(replica.doc, textPath("one"))[0].type, "text");
  assert.equal(A.getObjectId(replica.doc.blocks.one, "richText"), object);
  assert.equal(A.getCursorPosition(replica.doc, textPath("one"), cursor), 13);
  const before = replica.doc;
  binding.applyEditorTransaction(
    state(binding).update({ changes: { from: 5, to: 10, add: Strong } }),
  );
  assert.equal(A.marksAt(replica.doc, textPath("one"), 4).strong, true);
  assert.ok(
    !A.diff(replica.doc, A.getHeads(before), A.getHeads(replica.doc)).some(
      (p) => p.action === "splice" || p.action === "spliceText",
    ),
  );
  assert.equal(blockMarkdown(replica.doc.blocks.one), "New **hello** 🌊 world");
  binding.destroy();
  assert.equal(replica.observerCount, 0);
});
test("structural edits preserve surviving cursors and canonical Pages markers", () => {
  const replica = fixture("hello world"),
    binding = createWordgardBinding(replica, "one");
  const cursor = A.getCursor(replica.doc, textPath("one"), 8);
  const target = schema.doc([
    Heading.of(2).create([Leaf.text("hello")]),
    Paragraph.create([Leaf.text(" world")]),
  ]);
  const before = state(binding);
  binding.applyEditorTransaction(before.update({ changes: projectChanges(before.doc, target) }));
  assert.ok(binding.current.doc.eq(target));
  assert.equal(
    replica.doc.blocks.one.richText[A.getCursorPosition(replica.doc, textPath("one"), cursor)],
    "r",
  );
  assert.equal(blockMarkdown(replica.doc.blocks.one), "## hello\n\n world");
  binding.destroy();
});
test("incoming changes publish an incremental projection and actor metadata", () => {
  const replica = fixture("one two three"),
    binding = createWordgardBinding(replica, "one"),
    events = [];
  binding.observe((event) => events.push(event));
  const remote = A.change(A.clone(replica.doc), (d) => {
    A.splice(d, textPath("one"), 0, 3, "ONE");
    A.mark(d, textPath("one"), { start: 4, end: 7, expand: "both" }, "em", true);
  });
  replica.receive(remote);
  const event = events.at(-1);
  assert.equal(event.remote, true);
  assert.deepEqual(event.actors, [A.getActorId(remote)]);
  assert.equal(event.nativeAfter, replica.doc);
  assert.ok(event.changes.apply(event.before.doc).eq(event.after.doc));
  assert.equal(event.changes.mapPos(6), 6);
  assert.ok(binding.current.doc.eq(decode(A.spans(replica.doc, textPath("one"))).doc));
  binding.destroy();
});
test("stale editor transactions reject without changing shared state", () => {
  const replica = fixture(),
    binding = createWordgardBinding(replica, "one"),
    old = state(binding);
  replica.change((d) => A.splice(d, textPath("one"), 0, 0, "Ahead "));
  const heads = A.getHeads(replica.doc);
  assert.throws(
    () =>
      binding.applyEditorTransaction(
        old.update({ changes: { from: 1, insert: [Leaf.text("stale")] } }),
      ),
    /behind/,
  );
  assert.deepEqual(A.getHeads(replica.doc), heads);
  binding.destroy();
});

test("real Repo handles drive Wordgard changes while undo preserves a remote insertion", async (t) => {
  const peers = [createPeer(), createPeer()],
    wires = [];
  let binding;
  t.after(async () => {
    binding?.destroy();
    await closePeers(peers, wires);
  });
  const first = await peers[0].repo.create(
    createPageData({ pageId: "wordgard-history", title: "Fixture" }),
  );
  await first.change((d) => initializePage(d, "Original"));
  wires.push(await connectPeers(peers[0], peers[1]));
  const second = await peers[1].repo.find(first.documentId),
    id = orderedBlockIds(first.doc())[0];
  let local = 0;
  const replica = {
    get doc() {
      return second.doc();
    },
    change(fn) {
      local++;
      try {
        return second.change(fn);
      } finally {
        local--;
      }
    },
    observeChange(fn) {
      const listener = (e) => fn({ ...e, remote: !local });
      second.on("change", listener);
      return () => second.off("change", listener);
    },
  };
  binding = createWordgardBinding(replica, id);
  let editorState = GardState.create({
    doc: binding.current.doc,
    config: [...schema.elements.map((e) => GardState.schemaElement.of(e)), history()],
  });
  binding.observe((event) => {
    if (event.remote)
      editorState = editorState.update({
        changes: event.changes,
        annotations: [
          Transaction.remote.of(true),
          Transaction.addToHistory.of(false),
          history.isolate.of(true),
        ],
      }).state;
  });
  const localChange = (spec) => {
    const tr = editorState.update(spec);
    binding.applyEditorTransaction(tr);
    editorState = tr.state;
  };
  localChange({ changes: { from: 1, insert: [Leaf.text("Local ")] } });
  await peers[1].repo.flush();
  await eventually(() => assert.equal(first.doc().blocks[id].richText, "Local Original"));
  await first.change((d) =>
    A.splice(d, ["blocks", id, "richText"], d.blocks[id].richText.length, 0, " Remote"),
  );
  await eventually(() => assert.equal(editorState.doc.textContent(), "Local Original Remote"));
  const undoSpec = undo({ state: editorState });
  assert.ok(undoSpec);
  localChange(undoSpec);
  assert.equal(replica.doc.blocks[id].richText, "Original Remote");
  const redoSpec = redo({ state: editorState });
  assert.ok(redoSpec);
  localChange(redoSpec);
  assert.equal(replica.doc.blocks[id].richText, "Local Original Remote");
  await peers[1].repo.flush();
  await eventually(() => assert.equal(first.doc().blocks[id].richText, "Local Original Remote"));
  await first.change((d) =>
    A.updateSpans(
      d,
      ["blocks", id, "richText"],
      encode(schema.doc([Heading.of(2).create([Leaf.text("Local Original Remote")])])),
    ),
  );
  await eventually(() => assert.equal(editorState.doc.content[0].type, Heading));
  localChange(undo({ state: editorState }));
  assert.equal(
    binding.current.doc.content[0].type,
    Heading,
    "undo retains the collaborator's structural edit",
  );
  assert.equal(binding.current.doc.textContent(), "Original Remote");
});

test("unrelated comments, titles and blocks do not redraw the Wordgard projection", () => {
  const replica = fixture(),
    binding = createWordgardBinding(replica, "one");
  const original = binding.current;
  let notified = 0;
  binding.observe(() => notified++);
  replica.change((d) => {
    d.title = "Renamed";
    d.comments = { thread: { body: "Note" } };
    d.blocks.other = { richText: "Elsewhere" };
  });
  replica.change((d) => A.updateText(d, ["blocks", "other", "richText"], "Another edit"));
  assert.equal(notified, 0);
  assert.equal(binding.current, original);
  replica.change((d) => A.splice(d, textPath("one"), 0, 0, "Own "));
  assert.equal(notified, 1);
  binding.destroy();
});

test("formatting across a hard break applies to text without unsupported embed marks", () => {
  const replica = fixture("One  \nTwo"),
    binding = createWordgardBinding(replica, "one");
  const initial = state(binding);
  binding.applyEditorTransaction(
    initial.update({ changes: { from: 1, to: initial.doc.length - 1, add: Strong } }),
  );
  assert.equal(blockMarkdown(replica.doc.blocks.one), "**One**\\\n**Two**");
  binding.destroy();
});

test("the Enter fence command creates native code and language changes round-trip", () => {
  for (const fence of ["```", "```mermaid"]) {
    const replica = fixture(""),
      binding = createWordgardBinding(replica, "one");
    let editorState = GardState.create({
      doc: binding.current.doc,
      selection: { anchor: 1 },
      config: [
        GardState.schemaElement.of(schema.elements),
        wordgardCodeNewlines,
        codeBlock(),
        codeBlockLanguage({ languages: ["Mermaid"] }),
      ],
    });
    const editor = {
      get state() {
        return editorState;
      },
      dispatch(spec) {
        const tr = editorState.update(spec);
        binding.applyEditorTransaction(tr);
        editorState = tr.state;
        assert.ok(binding.current.doc.eq(editorState.doc));
      },
    };
    for (const character of fence) {
      const from = editorState.selection.head;
      editor.dispatch({
        changes: { from, insert: [Leaf.text(character)] },
        selection: { anchor: from + 1 },
      });
    }
    assert.equal(Command.dispatch(editor, enter), true);
    assert.equal(editorState.doc.content[0].type, CodeBlock.type);
    assert.equal(editorState.doc.textContent(), "");
    assert.equal(
      editorState.doc.content[0].mark(CodeBlockLanguage),
      fence === "```" ? undefined : "mermaid",
    );
    assert.equal(
      String(A.spans(replica.doc, textPath("one"))[0].value.attrs.params),
      fence === "```" ? "" : "mermaid",
    );
    const type = (text) => {
      const from = editorState.selection.head;
      editor.dispatch({
        changes: { from, insert: [Leaf.text(text)] },
        selection: { anchor: from + text.length },
      });
    };
    type("graph TD");
    assert.equal(Command.dispatch(editor, enter), true);
    type(" A[🌊] --> B");
    assert.equal(Command.dispatch(editor, enter), true);
    type(" B --> C");
    const source = "graph TD\n A[🌊] --> B\n B --> C";
    editor.dispatch({ changes: { from: 0, add: CodeBlockLanguage.of("mermaid") } });
    assert.equal(String(A.spans(replica.doc, textPath("one"))[0].value.attrs.params), "mermaid");
    editor.dispatch({
      changes: { from: 0, remove: CodeBlockLanguage.isInSet(editorState.doc.content[0].tag.marks) },
    });
    assert.equal(String(A.spans(replica.doc, textPath("one"))[0].value.attrs.params), "");
    assert.equal(editorState.doc.content[0].mark(CodeBlockLanguage), undefined);
    assert.equal(editorState.doc.textContent(), source);
    assert.equal(
      A.spans(replica.doc, textPath("one"))
        .filter((span) => span.type === "text")
        .map((span) => span.value)
        .join(""),
      source,
    );
    for (let i = 0; i < 3; i++) assert.equal(Command.dispatch(editor, enter), true);
    type("After code");
    assert.equal(editorState.doc.content[0].textContent(), source);
    assert.equal(editorState.doc.content[1].type, Paragraph.type);
    assert.equal(editorState.doc.content[1].textContent(), "After code");
    binding.destroy();
  }
});

test("code clipboard text normalizes locally, supports history, and skips remote corrections", () => {
  const replica = fixture("```mermaid\nprefix 🌊\n```"),
    binding = createWordgardBinding(replica, "one");
  let editorState = GardState.create({
    doc: binding.current.doc,
    selection: { anchor: binding.current.doc.length - 1 },
    config: [GardState.schemaElement.of(schema.elements), wordgardCodeNewlines, history()],
  });
  const dispatch = (spec) => {
    const tr = editorState.update(spec);
    binding.applyEditorTransaction(tr);
    editorState = tr.state;
    assert.ok(binding.current.doc.eq(editorState.doc));
  };
  const pasted = "\n Alpha 🌊\n Beta",
    from = editorState.selection.head;
  dispatch({
    changes: { from, insert: Slice.of([Leaf.text(pasted)]), fit: true },
    selection: { anchor: from + pasted.length },
    userEvent: "input.paste",
    annotations: history.isolate.of(true),
  });
  const source = "prefix 🌊" + pasted;
  assert.equal(editorState.doc.textContent(), source);
  assert.equal(editorState.selection.head, from + pasted.length);
  assert.equal(editorState.doc.content[0].content.filter((node) => !node.isText).length, 2);
  assert.ok(
    editorState.doc.content[0].content.every((node) => !node.isText || !node.param.includes("\n")),
  );
  dispatch(undo({ state: editorState }));
  assert.equal(editorState.doc.textContent(), "prefix 🌊");
  dispatch(redo({ state: editorState }));
  assert.equal(editorState.doc.textContent(), source);
  const remote = editorState.update({
    changes: { from: 1, insert: Slice.of([Leaf.text("remote\n")]), fit: true },
    annotations: Transaction.remote.of(true),
  });
  assert.ok(
    remote.newDoc.content[0].content.some((node) => node.isText && node.param.includes("remote\n")),
  );
  binding.destroy();
});

test("combined bold, italic and titled links retain canonical marks through undo and redo", () => {
  const replica = fixture("alpha beta"),
    binding = createWordgardBinding(replica, "one");
  let editorState = GardState.create({
    doc: binding.current.doc,
    selection: { anchor: 1, head: 6 },
    config: [GardState.schemaElement.of(schema.elements), wordgardCodeNewlines, history()],
  });
  const editor = {
    get state() {
      return editorState;
    },
    dispatch(spec) {
      const tr = editorState.update({ ...spec, annotations: history.isolate.of(true) });
      binding.applyEditorTransaction(tr);
      editorState = tr.state;
      assert.ok(binding.current.doc.eq(editorState.doc));
      assert.ok(decode(A.spans(replica.doc, textPath("one"))).doc.eq(editorState.doc));
    },
  };
  const link = { href: "/p/fixture", title: "Stable title" };
  assert.equal(Command.dispatch(editor, toggleMark, Strong), true);
  assert.equal(Command.dispatch(editor, toggleMark, Emphasis), true);
  assert.equal(Command.dispatch(editor, toggleMark, PagesLink.of(link)), true);
  const combined = editorState.doc;
  const spans = A.spans(replica.doc, textPath("one"));
  assert.equal(spans[0].value, "alpha");
  assert.deepEqual(spans[0].marks, { strong: true, em: true, link: JSON.stringify(link) });
  assert.deepEqual(spans[1], { type: "text", value: " beta" });
  assert.deepEqual(A.marksAt(replica.doc, textPath("one"), 0), spans[0].marks);
  assert.ok(
    decode([
      { ...spans[0], marks: { link: JSON.stringify(link), em: true, strong: true } },
      spans[1],
    ]).doc.eq(combined),
  );
  editor.dispatch(undo({ state: editorState }));
  assert.deepEqual(A.marksAt(replica.doc, textPath("one"), 0), { strong: true, em: true });
  editor.dispatch(undo({ state: editorState }));
  assert.deepEqual(A.marksAt(replica.doc, textPath("one"), 0), { strong: true });
  editor.dispatch(undo({ state: editorState }));
  assert.deepEqual(A.marksAt(replica.doc, textPath("one"), 0), {});
  for (let i = 0; i < 3; i++) editor.dispatch(redo({ state: editorState }));
  assert.ok(editorState.doc.eq(combined));
  assert.equal(replica.doc.blocks.one.richText, "alpha beta");
  binding.destroy();
});

test("non-default ordered-list input and paste normalize before native commit with undo", () => {
  for (const mode of ["input rule", "paste"]) {
    const replica = fixture(""),
      binding = createWordgardBinding(replica, "one");
    let editorState = GardState.create({
      doc: binding.current.doc,
      selection: { anchor: 1 },
      config: [
        GardState.schemaElement.of(schema.elements),
        wordgardListStarts,
        orderedList(),
        history(),
      ],
    });
    const dispatch = (spec) => {
      for (const tr of Transaction.append(editorState.update(spec))) {
        binding.applyEditorTransaction(tr);
        editorState = tr.state;
        assert.ok(binding.current.doc.eq(editorState.doc));
      }
    };
    if (mode === "input rule") {
      for (const character of "2. ") {
        const from = editorState.selection.head;
        dispatch({
          changes: { from, insert: [Leaf.text(character)] },
          selection: { anchor: from + 1 },
          userEvent: "input.type",
        });
      }
    } else {
      const list = OrderedList.of(2).create([
        ListItem.create([Paragraph.create([Leaf.text("Pasted 🌊")])]),
      ]);
      dispatch({
        changes: { from: 0, to: editorState.doc.length, insert: Slice.of([list]), fit: true },
        userEvent: "input.paste",
        annotations: history.isolate.of(true),
      });
    }
    assert.equal(editorState.doc.content[0].type, OrderedList);
    assert.equal(editorState.doc.content[0].tag.param, 1);
    const normalized = editorState.doc;
    assert.ok(
      A.spans(replica.doc, textPath("one")).some(
        (span) => span.type === "block" && String(span.value.type) === "ordered-list-item",
      ),
    );
    dispatch(undo({ state: editorState }));
    assert.equal(editorState.doc.content[0].type, Paragraph.type);
    assert.equal(editorState.doc.textContent(), mode === "input rule" ? "2. " : "");
    dispatch(redo({ state: editorState }));
    assert.ok(editorState.doc.eq(normalized));
    assert.equal(editorState.doc.textContent(), mode === "paste" ? "Pasted 🌊" : "");
    binding.destroy();
  }
});

const imageSrc = `/api/pages/${"3".repeat(8)}/assets/${"a".repeat(64)}`;
const image = PagesImage.of({ src: imageSrc, alt: "cat", title: null });
// The browser editor's commit path: local transactions through the binding,
// remote projections back into the editor, Backspace/Delete as deleteUnit.
// `previousBuild` stands in for a tab running d53a6e64b: its encoder, and a
// rejection path that restores the projection but keeps the undo history.
function editorFor(replica, id, { previousBuild = false } = {}) {
  const binding = createWordgardBinding(
      replica,
      id,
      previousBuild ? { encodeSpans: previousEncode } : {},
    ),
    undoHistory = wordgardHistory(),
    errors = [];
  let editorState = GardState.create({
    doc: binding.current.doc,
    config: [
      GardState.schemaElement.of(schema.elements),
      wordgardCodeNewlines,
      wordgardListStarts,
      undoHistory.extension,
    ],
  });
  const editor = {
    binding,
    errors,
    get state() {
      return editorState;
    },
    dispatch(spec) {
      // Each keystroke here is its own undo step, as when a person pauses.
      const annotations = [spec.annotations ?? []].flat().concat(history.isolate.of(true));
      const trs = Transaction.append(editorState.update({ ...spec, annotations }));
      editorState = trs.at(-1).state;
      try {
        commitEditorTransactions(editor, binding, trs, {
          annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
          undoHistory: previousBuild ? null : undoHistory,
        });
      } catch (error) {
        errors.push(error.message);
      }
    },
    run(command, arg) {
      return Command.dispatch(editor, command, arg);
    },
  };
  return editor;
}
const nativeSpans = (replica, id) => A.spans(replica.doc, ["blocks", id, "richText"]);
const imagePositions = (doc) => {
  const positions = [];
  for (let pos = 0; pos < doc.length; pos++)
    if (doc.nodeAt(pos)?.type === PagesImage) positions.push(pos);
  return positions;
};
function assertInSync(editor, replica, id, label) {
  assert.deepEqual(editor.errors, [], label);
  assert.ok(editor.binding.current.doc.eq(editor.state.doc), `${label}: ${editor.state.doc}`);
  assert.ok(decode(nativeSpans(replica, id)).doc.eq(editor.state.doc), label);
}
const deletions = {
  "Backspace on the selected image"(editor, pos) {
    editor.dispatch({ selection: GardSelection.node(pos, editor.state.doc.nodeAt(pos)) });
    assert.equal(editor.run(deleteUnit, "backward"), true);
  },
  "Delete on the selected image"(editor, pos) {
    editor.dispatch({ selection: GardSelection.node(pos, editor.state.doc.nodeAt(pos)) });
    assert.equal(editor.run(deleteUnit, "forward"), true);
  },
  "a range spanning the image"(editor, pos) {
    const doc = editor.state.doc;
    editor.dispatch({ selection: { anchor: pos, head: pos + 1 } });
    // Widen to the neighbouring text when there is any, crossing block edges.
    const from = Math.max(1, pos - 2),
      to = Math.min(doc.length - 1, pos + 3);
    editor.dispatch({ selection: { anchor: from, head: to } });
    assert.equal(editor.run(deleteUnit, "backward"), true);
  },
};
// Each shape builds a block the way the browser does: type, Enter, insert the
// uploaded image at the cursor with the same transaction as image-upload.mjs.
const shapes = {
  "alone in the first paragraph, before text (the reported Page)": {
    markdown: "Hope you can edit this with me.",
    place(editor) {
      editor.dispatch({ changes: { from: 1, insert: [image], fit: true } });
      editor.dispatch({ selection: { anchor: 2 } });
      assert.equal(editor.run(enter), true);
    },
  },
  "alone in a middle paragraph": {
    markdown: "With image!\n\nHope you can edit this with me.",
    place(editor) {
      editor.dispatch({ selection: { anchor: 12 } });
      assert.equal(editor.run(enter), true);
      editor.dispatch({
        changes: { from: editor.state.selection.head, insert: [image], fit: true },
      });
    },
  },
  "alone at the end of the document": {
    markdown: "With image!",
    place(editor) {
      editor.dispatch({ selection: { anchor: 12 } });
      assert.equal(editor.run(enter), true);
      editor.dispatch({
        changes: { from: editor.state.selection.head, insert: [image], fit: true },
      });
    },
  },
  "inline at the start of the document": {
    markdown: "Hope",
    place(editor) {
      editor.dispatch({ changes: { from: 1, insert: [image], fit: true } });
    },
  },
};
test("deleting an image keeps the editor and native Page projection identical", () => {
  for (const [shape, { markdown, place }] of Object.entries(shapes))
    for (const [method, remove] of Object.entries(deletions)) {
      const label = `${shape} / ${method}`,
        replica = fixture(markdown),
        editor = editorFor(replica, "one");
      place(editor);
      assertInSync(editor, replica, "one", `${label} (inserted)`);
      const inserted = editor.state.doc,
        [pos] = imagePositions(inserted);
      assert.ok(pos > 0, label);
      remove(editor, pos);
      assertInSync(editor, replica, "one", `${label} (deleted)`);
      assert.deepEqual(imagePositions(editor.state.doc), [], label);
      assert.ok(!JSON.stringify(nativeSpans(replica, "one")).includes(imageSrc), label);
      assert.ok(!blockMarkdown(replica.doc.blocks.one).includes(imageSrc), label);
      editor.dispatch(undo({ state: editor.state }));
      assertInSync(editor, replica, "one", `${label} (undo)`);
      assert.equal(imagePositions(editor.state.doc).length, 1, label);
      assert.ok(blockMarkdown(replica.doc.blocks.one).includes(imageSrc), label);
      editor.dispatch(redo({ state: editor.state }));
      assertInSync(editor, replica, "one", `${label} (redo)`);
      assert.deepEqual(imagePositions(editor.state.doc), [], label);
      editor.binding.destroy();
    }
});

test("deleting an insert_image block by hand leaves an empty, exportable block", () => {
  for (const [method, remove] of Object.entries(deletions)) {
    let doc = A.change(A.from(createPageData({ pageId: "3".repeat(8) })), (d) =>
      initializePage(d, "With image!"),
    );
    let result;
    doc = A.change(doc, (d) => {
      result = applyPageOperation(d, {
        operation: "edit_page",
        arguments: { operations: [{ op: "insert_image", asset_id: "a".repeat(64), alt: "cat" }] },
      });
    });
    const id = result.inserted_images[0].block_id,
      replica = {
        get doc() {
          return doc;
        },
        change(fn) {
          doc = A.change(doc, fn);
        },
        observeChange: () => () => {},
      };
    const editor = editorFor(replica, id),
      [pos] = imagePositions(editor.state.doc);
    remove(editor, pos);
    assert.deepEqual(editor.errors, [], method);
    assert.ok(decode(nativeSpans(replica, id)).doc.eq(editor.state.doc), method);
    assert.deepEqual(imagePositions(editor.state.doc), [], method);
    const page = projectPage(doc);
    assert.equal(page.blocks.find((block) => block.id === id).markdown, "", method);
    assert.ok(!JSON.stringify(page).includes(imageSrc.split("/assets/")[1]), method);
    editor.binding.destroy();
  }
});

test("Enter at the start of a block keeps the empty paragraph it creates", () => {
  const replica = fixture("Hope"),
    editor = editorFor(replica, "one");
  editor.dispatch({ selection: { anchor: 1 } });
  assert.equal(editor.run(enter), true);
  assertInSync(editor, replica, "one", "Enter at start");
  assert.equal(editor.state.doc.content.length, 2);
  editor.binding.destroy();
});

test("a rejected local transaction restores the editor and drops its undo history", () => {
  const replica = fixture("Hope"),
    editor = editorFor(replica, "one");
  editor.dispatch({ changes: { from: 1, insert: [image] } });
  const accepted = editor.state.doc,
    heads = A.getHeads(replica.doc);
  // Force the safety check to fail for one structural commit.
  const original = replica.change;
  replica.change = (fn) =>
    original((d) => {
      fn(d);
      throw Error("Wordgard operation did not reproduce its native Pages projection");
    });
  editor.dispatch({ changes: { from: 1, to: 2 } });
  replica.change = original;
  assert.deepEqual(editor.errors, [
    "Wordgard operation did not reproduce its native Pages projection",
  ]);
  editor.errors.length = 0;
  assert.deepEqual(A.getHeads(replica.doc), heads, "the native change rolled back");
  assert.ok(editor.state.doc.eq(accepted), "the editor shows the accepted document");
  assertInSync(editor, replica, "one", "after rejection");
  // Undo must not replay the inverse of the rejected deletion (a second image).
  assert.equal(undo({ state: editor.state }), false);
  editor.dispatch({ changes: { from: 2, insert: [Leaf.text(" again")] } });
  assertInSync(editor, replica, "one", "later edits");
  assert.equal(replica.doc.blocks.one.richText.length, " again".length + "Hope".length + 1);
  editor.binding.destroy();
});

test("a tab from the previous build rejects structural edits to the new shape without corruption", () => {
  // The current build writes an explicit marker for an empty first paragraph:
  // Paragraph(), Paragraph(image), Paragraph("Hope").
  const replica = fixture("Hope"),
    current = editorFor(replica, "one");
  current.dispatch({ changes: { from: 1, insert: [image] } });
  current.dispatch({ selection: { anchor: 2 } });
  assert.equal(current.run(enter), true);
  current.dispatch({ selection: { anchor: 1 } });
  assert.equal(current.run(enter), true);
  assertInSync(current, replica, "one", "current build");
  assert.equal(current.state.doc.content.length, 3);
  assert.equal(String(nativeSpans(replica, "one")[0].value.type), "paragraph");
  current.binding.destroy();

  // The previous build decodes it, and plain typing still commits.
  const previous = editorFor(replica, "one", { previousBuild: true }),
    text = () =>
      nativeSpans(replica, "one")
        .filter((span) => span.type === "text")
        .map((span) => span.value)
        .join("");
  assert.ok(previous.state.doc.eq(decode(nativeSpans(replica, "one")).doc));
  const hope = previous.state.doc.length - 1 - "Hope".length;
  previous.dispatch({ changes: { from: hope, insert: [Leaf.text("Still ")] } });
  assertInSync(previous, replica, "one", "previous build typing");
  assert.equal(text(), "Still Hope");

  // Its encoder drops the empty first paragraph, so the safety check rejects
  // any structural edit that keeps it. The native change rolls back and the
  // editor shows the accepted Page again.
  const rejection = ["Wordgard operation did not reproduce its native Pages projection"],
    accepted = A.save(replica.doc),
    restored = previous.state.doc,
    [pos] = imagePositions(restored);
  previous.dispatch({ selection: GardSelection.node(pos, restored.nodeAt(pos)) });
  assert.equal(previous.run(deleteUnit, "backward"), true);
  assert.deepEqual(previous.errors, rejection);
  assert.deepEqual(A.save(replica.doc), accepted, "the Page is unchanged");
  assert.ok(previous.state.doc.eq(restored), "the editor shows the accepted Page");

  // That build keeps the rejected deletion in its undo history, and undo would
  // insert a second image. The inverse is structural too, so it is rejected
  // the same way while the empty first paragraph remains.
  previous.errors.length = 0;
  const undoSpec = undo({ state: previous.state });
  assert.ok(undoSpec);
  assert.equal(imagePositions(previous.state.update(undoSpec).newDoc).length, 2);
  previous.dispatch(undoSpec);
  assert.deepEqual(previous.errors, rejection);
  assert.deepEqual(A.save(replica.doc), accepted, "no duplicate image reaches the Page");
  assert.ok(previous.state.doc.eq(restored));
  previous.binding.destroy();
});

test("editor writes stamp the schema features their content needs in the same change", (t) => {
  // A test-only registry makes highlights non-baseline.
  t.after(
    installFeatureRegistryForTests(
      featureRegistry(
        {
          version: 1,
          features: [...FEATURE_FILE.features, { id: "test-highlight", description: "For tests." }],
        },
        {
          marks: MARK_REGISTRY.marks.map((mark) =>
            mark.name === "highlight" ? { ...mark, feature: "test-highlight" } : mark,
          ),
        },
      ),
    ),
  );
  const stampedIn = (replica, before) => {
    const changes = A.getChanges(before, replica.doc);
    assert.equal(changes.length, 1);
    const [applied] = A.applyChanges(A.load(A.save(before)), changes);
    return documentFeatures(applied);
  };
  // Baseline formatting writes no stamp.
  let replica = fixture("hello world"),
    binding = createWordgardBinding(replica, "one");
  binding.applyEditorTransaction(
    state(binding).update({ changes: { from: 1, to: 6, add: Strong } }),
  );
  assert.equal(replica.doc.schema, undefined);
  // A mark-only change.
  let before = replica.doc;
  binding.applyEditorTransaction(
    state(binding).update({ changes: { from: 7, to: 12, add: PagesHighlight.of("green") } }),
  );
  assert.deepEqual(stampedIn(replica, before), ["test-highlight"]);
  binding.destroy();
  // Typed text that carries the mark.
  replica = fixture("hello");
  binding = createWordgardBinding(replica, "one");
  before = replica.doc;
  binding.applyEditorTransaction(
    state(binding).update({
      changes: { from: 1, insert: [Leaf.text("new ", [PagesHighlight.of("pink")])] },
    }),
  );
  assert.equal(A.marksAt(replica.doc, textPath("one"), 1).highlight, "pink");
  assert.deepEqual(stampedIn(replica, before), ["test-highlight"]);
  binding.destroy();
  // A structural change re-encodes the block.
  replica = fixture("hello world");
  binding = createWordgardBinding(replica, "one");
  before = replica.doc;
  const target = schema.doc([
    Heading.of(2).create([Leaf.text("hello", [PagesHighlight.of("blue")])]),
    Paragraph.create([Leaf.text(" world")]),
  ]);
  const start = state(binding);
  binding.applyEditorTransaction(start.update({ changes: projectChanges(start.doc, target) }));
  assert.deepEqual(stampedIn(replica, before), ["test-highlight"]);
  binding.destroy();
});

// Two people typing at the same spot each keep an unbroken run: a caret sticks
// to the character before it, so text a peer inserts there lands after it.
test("a caret keeps its side of a peer's insertion at the same spot", () => {
  for (const peerActor of ["00".repeat(16), "ff".repeat(16)]) {
    const replica = fixture("ab cd"),
      binding = createWordgardBinding(replica, "one"),
      events = [];
    binding.observe((event) => events.push(event));
    const path = textPath("one");
    const base = A.clone(replica.doc, { actor: peerActor });
    // Local typing: "L" after "ab", caret after it at editor position 4.
    replica.change((d) => A.splice(d, path, 2, 0, "L"));
    const caret = 4;
    // The peer typed "R" at the same spot without seeing "L".
    replica.receive(A.change(base, (d) => A.splice(d, path, 2, 0, "R")));
    const event = events.at(-1);
    assert.equal(event.remote, true);
    const text = replica.doc.blocks.one.richText;
    const at = remoteEditorPosition(event, path, caret, { caret: true });
    assert.equal(text.slice(0, at - 1), text.slice(0, text.indexOf("L") + 1), peerActor);
    binding.destroy();
  }
});

test("a caret at a peer's insertion point stays before the inserted text", () => {
  const replica = fixture("ab cd"),
    binding = createWordgardBinding(replica, "one"),
    events = [];
  binding.observe((event) => events.push(event));
  const path = textPath("one");
  replica.receive(A.change(A.clone(replica.doc), (d) => A.splice(d, path, 2, 0, "XY")));
  const event = events.at(-1);
  // Caret after "ab" (editor position 3) stays there; a selection end moves.
  assert.equal(remoteEditorPosition(event, path, 3, { caret: true }), 3);
  assert.equal(remoteEditorPosition(event, path, 3), 5);
  // A caret at the start of the paragraph has no character before it.
  assert.equal(remoteEditorPosition(event, path, 1, { caret: true }), 1);
  binding.destroy();
});

test("a caret whose preceding character a peer deletes stays in place", () => {
  const replica = fixture("ab cd"),
    binding = createWordgardBinding(replica, "one"),
    events = [];
  binding.observe((event) => events.push(event));
  const path = textPath("one");
  replica.receive(A.change(A.clone(replica.doc), (d) => A.splice(d, path, 1, 1)));
  const event = events.at(-1);
  assert.equal(replica.doc.blocks.one.richText, "a cd");
  assert.equal(remoteEditorPosition(event, path, 3, { caret: true }), 2);
  // Deleting the whole run before the caret leaves it at the paragraph start.
  replica.receive(A.change(A.clone(replica.doc), (d) => A.splice(d, path, 0, 1)));
  assert.equal(remoteEditorPosition(events.at(-1), path, 2, { caret: true }), 1);
  binding.destroy();
});

test("a caret after an emoji keeps its side of a peer's insertion", () => {
  const replica = fixture("Wave 🌊 end"),
    binding = createWordgardBinding(replica, "one"),
    events = [];
  binding.observe((event) => events.push(event));
  const path = textPath("one");
  const raw = () => replica.doc.blocks.one.richText;
  // The caret sits right after the emoji.
  const caret = binding.current.map.amToWg[raw().indexOf(" end")];
  replica.receive(
    A.change(A.clone(replica.doc), (d) => A.splice(d, path, raw().indexOf(" end"), 0, "XY")),
  );
  const at = remoteEditorPosition(events.at(-1), path, caret, { caret: true });
  // Still right after the emoji, before the peer's text.
  assert.equal(at, binding.current.map.amToWg[raw().indexOf("XY")]);
  // A peer's emoji typed before the caret moves it by one whole code point.
  const before = binding.current.map.amToWg[raw().indexOf("XY")];
  replica.receive(A.change(A.clone(replica.doc), (d) => A.splice(d, path, 0, 0, "🌍")));
  const moved = remoteEditorPosition(events.at(-1), path, before, { caret: true });
  assert.equal(moved, binding.current.map.amToWg[raw().indexOf("XY")]);
  binding.destroy();
});
