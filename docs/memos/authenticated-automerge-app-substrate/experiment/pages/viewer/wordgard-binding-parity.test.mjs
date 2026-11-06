// The binding carries its decoded block forward without rereading it for
// plain typing and remote text patches. After every generated local edit,
// remote edit, and merge, its tree and position maps must equal a fresh
// decode of the Automerge document, and the editor must show that tree.
// Replay a failure with --test-name-pattern plus PAGES_FUZZ_SEED and
// PAGES_FUZZ_PATH.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import * as A from "@automerge/automerge";
import { GardSelection, GardState, Transaction } from "wordgard/state";
import { Leaf } from "wordgard/doc";
import { history, undo, redo } from "wordgard/history";
import { Command, deleteUnit, enter, insertText, toggleMark } from "wordgard/command";
import {
  decode,
  encode,
  schema,
  Code,
  Emphasis,
  PagesLink,
  Paragraph,
  Strong,
} from "./wordgard-model.mjs";
import { projectChanges } from "./wordgard-projection.mjs";
import {
  commitEditorTransactions,
  createWordgardBinding,
  wordgardCodeNewlines,
  wordgardHistory,
  wordgardListStarts,
} from "./wordgard-binding.mjs";
import { createPageData } from "../model/page.mjs";
import { orderedBlockIds } from "../model/order.mjs";
import { RICH_FORMAT, textPath } from "../model/richtext.mjs";
import { updateSpansConfig } from "../model/marks.mjs";
import { stampSpans } from "../model/schema-features.mjs";
import { PAGE_ID, pageTreeArbitrary, toWordgardTree } from "../test/random-page-tree.mjs";
import { fuzzDepth, fuzzParameters as parameters } from "../test/fuzz-parameters.mjs";
import { freeing } from "../test/free-docs.mjs";

const ACTORS = ["0c".repeat(16), "0d".repeat(16)];
const MARKS = [
  Strong,
  Emphasis,
  Code,
  PagesLink.of({ href: "https://example.org/p", title: null }),
];
const LOCAL_TEXT = ["x", "ab", " ", "é", "😀"];
// A newline and a native mark reach the binding's fallback read.
const REMOTE_TEXT = ["R", "rs", " ", "ü", "😀", "\n"];
const REMOTE_MARKS = [
  ["strong", true],
  ["em", true],
  ["link", JSON.stringify({ href: "https://example.org/r", title: null })],
  ["strong", null],
];

/** A replica like the Pages session: change events carry the patches since
 * the previous document, and merges are remote. */
function replicaFor(doc) {
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
      if (doc !== before) publish(before, doc, false);
    },
    receive(other) {
      const before = doc;
      doc = A.merge(doc, other);
      publish(before, doc, true);
    },
    observeChange(fn) {
      observers.add(fn);
      return () => observers.delete(fn);
    },
  };
}

/** The browser editor's loop: local transactions commit through the binding,
 * and binding events update the editor as remote transactions. */
function editorFor(replica, id) {
  const binding = createWordgardBinding(replica, id),
    undoHistory = wordgardHistory(),
    errors = [];
  let writing = false;
  let state = GardState.create({
    doc: binding.current.doc,
    config: [
      GardState.schemaElement.of(schema.elements),
      wordgardCodeNewlines,
      wordgardListStarts,
      undoHistory.extension,
    ],
  });
  const remoteAnnotations = [Transaction.remote.of(true), Transaction.addToHistory.of(false)];
  const editor = {
    binding,
    errors,
    get state() {
      return state;
    },
    dispatch(spec) {
      const annotations = [spec.annotations ?? []].flat().concat(history.isolate.of(true));
      const trs = Transaction.append(state.update({ ...spec, annotations }));
      state = trs.at(-1).state;
      writing = true;
      try {
        commitEditorTransactions(editor, binding, trs, {
          annotations: remoteAnnotations,
          undoHistory,
        });
      } catch (error) {
        errors.push(error.message);
      } finally {
        writing = false;
      }
    },
  };
  binding.observe((event) => {
    if (writing) return;
    state = state.update({
      changes:
        state.doc === event.before.doc ? event.changes : projectChanges(state.doc, event.after.doc),
      annotations: [...remoteAnnotations, history.isolate.of(true)],
    }).state;
  });
  return editor;
}

function pageWith(tree) {
  let doc = A.from(createPageData({ pageId: PAGE_ID, title: "Parity" }), { actor: ACTORS[0] });
  const id = orderedBlockIds(doc)[0];
  const spans = encode(tree);
  doc = A.change(doc, (draft) => {
    draft.blocks[id].format = RICH_FORMAT;
    draft.blocks[id].richText = "";
    A.updateSpans(draft, textPath(id), spans, updateSpansConfig);
    stampSpans(draft, spans);
  });
  return { doc, id };
}

const textPositions = (doc) => {
  const out = [];
  for (let pos = 0; pos <= doc.length; pos++) {
    const at = doc.resolve(pos);
    // The editor never puts a position inside a surrogate pair.
    if (at.nodeBefore?.isText && /[\uD800-\uDBFF]$/.test(String(at.nodeBefore.param))) continue;
    if (at.parent.node.type.spec.inlineContent) out.push(pos);
  }
  return out;
};
const pick = (list, n) => list[n % list.length];

function local(editor, op) {
  const positions = textPositions(editor.state.doc);
  if (!positions.length) return;
  const anchor = pick(positions, op.a),
    head = pick(positions, op.a + op.span);
  const select = (from, to = from) =>
    editor.dispatch({ selection: GardSelection.Text.create({ anchor: from, head: to }) });
  switch (op.kind) {
    case "type":
      select(anchor);
      Command.dispatch(editor, insertText, {
        from: anchor,
        to: anchor,
        insert: pick(LOCAL_TEXT, op.n),
      });
      break;
    case "replace":
      // Two positions in one textblock replace text with text.
      select(Math.min(anchor, head), Math.max(anchor, head));
      Command.dispatch(editor, insertText, {
        from: Math.min(anchor, head),
        to: Math.max(anchor, head),
        insert: pick(LOCAL_TEXT, op.n),
      });
      break;
    case "delete":
      select(anchor, head);
      Command.dispatch(editor, deleteUnit, op.n % 2 ? "forward" : "backward");
      break;
    case "clear": {
      // Delete all of one textblock's text: a textblock with no native marker
      // of its own then has nothing to decode from.
      const block = editor.state.doc.resolve(anchor).parent;
      const from = block.node.isPlot ? block.before + 1 : anchor,
        to = from + block.node.content.reduce((n, node) => n + node.length, 0);
      if (to > from) {
        select(from, to);
        Command.dispatch(editor, deleteUnit, "backward");
      }
      break;
    }
    case "mark":
      select(Math.min(anchor, head), Math.max(anchor, head));
      Command.dispatch(editor, toggleMark, pick(MARKS, op.n));
      break;
    case "marked-type":
      editor.dispatch({
        changes: {
          from: anchor,
          insert: [Leaf.text(pick(LOCAL_TEXT, op.n), [pick(MARKS, op.span)])],
        },
      });
      break;
    case "enter":
      select(anchor);
      Command.dispatch(editor, enter);
      break;
    case "undo": {
      const spec = undo({ state: editor.state });
      if (spec) editor.dispatch(spec);
      break;
    }
    case "redo": {
      const spec = redo({ state: editor.state });
      if (spec) editor.dispatch(spec);
      break;
    }
  }
}

// A peer's raw native edit can leave a shape decode refuses (text between
// table rows), with any binding. The generator skips those edits. Frees `doc`
// unless `free` is false and it decodes.
function drawable(doc, path, free = true) {
  let ok = true;
  try {
    decode(A.spans(doc, path));
  } catch {
    ok = false;
  }
  if (free || !ok) A.free(doc);
  return ok;
}

function remote(peer, path, op) {
  const source = String(peer.blocks[path[1]].richText),
    length = source.length;
  const at = op.a % (length + 1);
  return A.change(peer, (d) => {
    switch (op.kind) {
      case "remote-type":
        A.splice(d, path, at, 0, pick(REMOTE_TEXT, op.n));
        break;
      case "remote-delete": {
        // Text only: a peer's deleted block marker can leave a shape decode
        // refuses (a table with a paragraph in it), with any binding.
        const text = source.slice(at, at + 1 + (op.span % 3));
        const count = text.includes("\uFFFC") ? text.indexOf("\uFFFC") : text.length;
        if (count) A.splice(d, path, at, count);
        break;
      }
      case "remote-mark": {
        const end = Math.min(length, at + 1 + (op.span % 4));
        if (end <= at) break;
        const [name, value] = pick(REMOTE_MARKS, op.n);
        if (value === null) A.unmark(d, path, { start: at, end, expand: "both" }, name);
        else A.mark(d, path, { start: at, end, expand: "both" }, name, value);
        break;
      }
    }
  });
}

const operation = fc.record({
  kind: fc.constantFrom(
    "type",
    "type",
    "type",
    "replace",
    "delete",
    "delete",
    "clear",
    "mark",
    "marked-type",
    "enter",
    "undo",
    "redo",
    "remote-type",
    "remote-type",
    "remote-delete",
    "remote-mark",
    "receive",
    "receive",
    "catch-up",
  ),
  a: fc.nat(),
  span: fc.nat({ max: 8 }),
  n: fc.nat(),
});

function assertParity(editor, replica, id, label) {
  const fresh = decode(A.spans(replica.doc, textPath(id)));
  const { current } = editor.binding;
  assert.ok(current.doc.eq(fresh.doc), `${label}: binding tree\n${current.doc}\n${fresh.doc}`);
  assert.deepEqual(current.map.wgToAm, fresh.map.wgToAm, `${label}: editor-to-native map`);
  assert.deepEqual(current.map.amToWg, fresh.map.amToWg, `${label}: native-to-editor map`);
  assert.ok(editor.state.doc.eq(fresh.doc), `${label}: editor tree`);
}

test("the binding's projection equals a fresh decode after every local and remote change", () => {
  fc.assert(
    fc.property(
      pageTreeArbitrary({ maxDepth: fuzzDepth }),
      fc.array(operation, { minLength: 1, maxLength: 30 }),
      (description, operations) =>
        freeing((keep) => {
          const { doc, id } = pageWith(toWordgardTree(description));
          const path = textPath(id);
          // Each lineage frees only its latest version.
          const replica = replicaFor(doc);
          let peer = A.clone(doc, { actor: ACTORS[1] });
          const editor = editorFor(replica, id);
          try {
            assertParity(editor, replica, id, "initial");
            operations.forEach((op, step) => {
              const label = `step ${step} ${op.kind}`;
              if (op.kind === "receive") {
                if (drawable(A.merge(A.clone(replica.doc), peer), path)) replica.receive(peer);
              } else if (op.kind === "catch-up") peer = A.merge(peer, replica.doc);
              else if (op.kind.startsWith("remote-")) {
                const next = remote(A.clone(peer), path, op);
                if (drawable(next, path, false)) {
                  A.free(peer);
                  peer = next;
                }
              } else local(editor, op);
              // Some generated structural edits can't be stored or drawn
              // back (with this binding and the one before it). The binding
              // rejects them and the editor rolls back to the accepted Page;
              // parity must still hold.
              editor.errors.length = 0;
              assertParity(editor, replica, id, label);
            });
          } finally {
            editor.binding.destroy();
            keep(replica.doc);
            keep(peer);
          }
        }),
    ),
    parameters,
  );
});

test("plain typing and remote text patches carry the projection without a read", () => {
  freeing((keep) => {
    const { doc, id } = pageWith(schema.doc([Paragraph.create([Leaf.text("start")])]));
    const replica = replicaFor(doc);
    const editor = editorFor(replica, id),
      events = [];
    editor.binding.observe((event) => events.push(event));
    Command.dispatch(editor, insertText, { from: 1, to: 1, insert: "hello" });
    // The projection is the editor's own tree only when the binding skipped
    // the read.
    assert.equal(editor.binding.current.doc, editor.state.doc);
    const peer = A.change(A.clone(replica.doc, { actor: ACTORS[1] }), (d) =>
      A.splice(d, textPath(id), 2, 0, "XY"),
    );
    replica.receive(peer);
    const event = events.at(-1);
    assert.equal(event.remote, true);
    // Remote patches built the change set and the tree it produces.
    assert.equal(event.changes.apply(event.before.doc), event.after.doc);
    assert.equal(editor.binding.current.doc, editor.state.doc);
    assertParity(editor, replica, id, "after remote typing");
    editor.binding.destroy();
    keep(replica.doc);
    keep(peer);
  });
});

test("verify mode reads and compares the block after every local write", () => {
  freeing((keep) => {
    const { doc, id } = pageWith(schema.doc([Paragraph.create([Leaf.text("start")])]));
    const replica = replicaFor(doc);
    const binding = createWordgardBinding(replica, id, { verify: true });
    const state = GardState.create({
      doc: binding.current.doc,
      config: [GardState.schemaElement.of(schema.elements)],
    });
    const tr = state.update({ changes: { from: 1, insert: [Leaf.text("x")] } });
    binding.applyEditorTransaction(tr);
    // A decoded tree, equal to the editor's but not the editor's own object.
    assert.notEqual(binding.current.doc, tr.newDoc);
    assert.ok(binding.current.doc.eq(tr.newDoc));
    binding.destroy();
    keep(replica.doc);
  });
});
