import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { GardState, Transaction } from "wordgard/state";
import { history, undo, redo } from "wordgard/history";
import { Command, enter, toggleMark } from "wordgard/command";
import { codeBlock, codeBlockLanguage, orderedList } from "wordgard/schema";
import { createPeer, connectPeers, closePeers, eventually } from "../../backend.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
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
  decode,
  encode,
} from "./wordgard-model.mjs";
import {
  createWordgardBinding,
  wordgardCodeNewlines,
  wordgardListStarts,
} from "./wordgard-binding.mjs";
import { projectChanges } from "./wordgard-projection.mjs";
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
