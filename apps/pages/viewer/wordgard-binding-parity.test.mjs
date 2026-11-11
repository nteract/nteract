// The binding carries its decoded block forward without rereading it for
// plain typing and remote text patches. After every generated step its tree
// and position maps must equal a fresh decode of the Automerge document, and
// the editor must show that tree. A `verify` binding on a twin replica takes
// every local transaction in lockstep: it reads the block for every write and
// takes mark positions from that read, so both must accept or reject the same
// transactions and end at the same heads.
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
  createWordgardBinding,
  wordgardCodeNewlines,
  wordgardHistory,
  wordgardListStarts,
} from "./wordgard-binding.mjs";
import { createPageData } from "../model/page.mjs";
import { orderedBlockIds } from "../model/order.mjs";
import { textPath } from "../model/richtext.mjs";
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
// A newline, U+FFFC and a lone surrogate reach the binding's checked path.
const LOCAL_TEXT = ["x", "ab", " ", "é", "😀", "x", "ab", "\n", "\uFFFC", "\uD83D"];
// A newline and a native mark reach the binding's fallback read.
const REMOTE_TEXT = ["R", "rs", " ", "ü", "😀", "\n"];
const REMOTE_MARKS = [
  ["strong", true],
  ["em", true],
  ["link", JSON.stringify({ href: "https://example.org/r", title: null })],
  ["strong", null],
];
// Fixed change times make the twin replicas write identical changes, so a
// peer that merged one replica's writes merges cleanly into the other.
const CHANGE = { time: 0 };

/** A replica like the Pages session: change events carry the patches since
 * the previous document, and merges are remote. `hold()` defers remote events
 * as the session does during composition; `silently` moves the heads with no
 * event. */
function replicaFor(doc) {
  const observers = new Set();
  let held = false,
    deferredBefore = null;
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
    get held() {
      return held;
    },
    change(fn) {
      const before = doc;
      doc = A.change(doc, CHANGE, fn);
      if (doc !== before) publish(before, doc, false);
    },
    silently(fn) {
      doc = A.change(doc, CHANGE, fn);
    },
    receive(other) {
      const before = doc;
      doc = A.merge(doc, other);
      if (held) deferredBefore ??= before;
      else publish(before, doc, true);
    },
    hold() {
      held = true;
    },
    release() {
      held = false;
      const before = deferredBefore;
      deferredBefore = null;
      if (before) publish(before, doc, true);
    },
    observeChange(fn) {
      observers.add(fn);
      return () => observers.delete(fn);
    },
  };
}

/** The browser editor's loop, as WordgardEditor runs it: local transactions
 * commit through the binding, and binding events update the editor as remote
 * transactions. Every local transaction also goes to `twin` (a binding on an
 * identical replica); `outcomes` records whether each binding accepted it. */
function editorFor(replica, id, { twin, trace, onRemote = () => {} } = {}) {
  const binding = createWordgardBinding(replica, id, { trace }),
    undoHistory = wordgardHistory(),
    outcomes = [];
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
  const commit = (target, tr) => {
    try {
      target.applyEditorTransaction(tr);
      return "accepted";
    } catch (error) {
      return error.message;
    }
  };
  const editor = {
    binding,
    outcomes,
    get state() {
      return state;
    },
    dispatch(spec) {
      const annotations = [spec.annotations ?? []].flat().concat(history.isolate.of(true));
      const trs = Transaction.append(state.update({ ...spec, annotations }));
      state = trs.at(-1).state;
      writing = true;
      let rejected = false;
      try {
        for (const tr of trs) {
          if (tr.annotation(Transaction.remote)) continue;
          const fast = commit(binding, tr),
            checked = commit(twin, tr);
          outcomes.push({ fast, checked });
          if (fast !== "accepted" || checked !== "accepted") {
            rejected = true;
            break;
          }
        }
      } finally {
        writing = false;
      }
      // commitEditorTransactions: back to the accepted Page, without history.
      if (rejected) {
        state = state.update({
          changes: projectChanges(state.doc, binding.current.doc),
          annotations: [...remoteAnnotations, history.isolate.of(true)],
        }).state;
        for (const effects of undoHistory.reset())
          state = state.update({ effects, annotations: remoteAnnotations }).state;
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
    if (event.remote) onRemote();
  });
  return editor;
}

function pageWith(tree) {
  let doc = A.from(createPageData({ pageId: PAGE_ID, title: "Parity" }), { actor: ACTORS[0] });
  const id = orderedBlockIds(doc)[0];
  const spans = encode(tree);
  doc = A.change(doc, CHANGE, (draft) => {
    draft.blocks[id].richText = "";
    A.updateSpans(draft, textPath(id), spans, updateSpansConfig);
    stampSpans(draft, spans);
  });
  return { doc, id };
}

const insidePair = (at) =>
  !!at.nodeBefore?.isText && /[\uD800-\uDBFF]$/.test(String(at.nodeBefore.param));
// Positions inside textblocks. The editor never puts a caret inside a
// surrogate pair; `split` asks for exactly those positions.
const textPositions = (doc, { split = false } = {}) => {
  const out = [];
  for (let pos = 0; pos <= doc.length; pos++) {
    const at = doc.resolve(pos);
    if (at.parent.node.type.spec.inlineContent && insidePair(at) === split) out.push(pos);
  }
  return out;
};
const pick = (list, n) => list[n % list.length];

function local(editor, op) {
  const positions = textPositions(editor.state.doc, { split: op.kind === "split-type" });
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
    case "split-type":
      // A transaction that splits a surrogate pair, as a buggy input path could.
      editor.dispatch({ changes: { from: anchor, insert: [Leaf.text(pick(LOCAL_TEXT, op.n))] } });
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

/** A raw native edit to this block's text, by a peer or a writer outside the
 * binding. */
function nativeEdit(d, path, op) {
  const source = String(d.blocks[path[1]].richText),
    length = source.length;
  const at = op.a % (length + 1);
  switch (op.kind) {
    case "remote-type":
    case "outside-type":
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
}
// The outside writer only inserts plain text where decode can draw it.
const safeOutside = (doc, path, op) => {
  const probe = A.change(A.clone(doc), (d) => nativeEdit(d, path, op));
  return drawable(probe, path);
};

const operation = fc.record({
  kind: fc.constantFrom(
    "type",
    "type",
    "type",
    "split-type",
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
    // Another block's change and a title change: no event for this block.
    "other-block",
    // The heads move with no change event at all.
    "silent-title",
    // Remote changes held back, as during composition, then released.
    "hold",
    "release",
    // The next remote event's listener writes to this block from inside the
    // binding's dispatch.
    "nested-write",
    // A write to this block from outside the binding.
    "outside-type",
  ),
  a: fc.nat(),
  span: fc.nat({ max: 8 }),
  n: fc.nat(),
});

function assertParity(binding, replica, id, label, editor) {
  const fresh = decode(A.spans(replica.doc, textPath(id)));
  const { current } = binding;
  assert.ok(current.doc.eq(fresh.doc), `${label}: binding tree\n${current.doc}\n${fresh.doc}`);
  assert.deepEqual(current.map.wgToAm, fresh.map.wgToAm, `${label}: editor-to-native map`);
  assert.deepEqual(current.map.amToWg, fresh.map.amToWg, `${label}: native-to-editor map`);
  if (editor) assert.ok(editor.state.doc.eq(fresh.doc), `${label}: editor tree`);
}

/** Run generated steps on a fast binding and a `verify` twin. Returns how
 * often each binding path ran. */
function runParity(description, operations) {
  const paths = { local: 0, remote: 0, read: 0 };
  freeing((keep) => {
    const { doc, id } = pageWith(toWordgardTree(description));
    const path = textPath(id);
    // Each lineage frees only its latest version.
    const replica = replicaFor(doc),
      twinReplica = replicaFor(A.clone(doc, { actor: ACTORS[0] }));
    const replicas = [replica, twinReplica];
    let peer = A.clone(doc, { actor: ACTORS[1] }),
      nested = null;
    const twinWrites = [];
    const twin = createWordgardBinding(twinReplica, id, { verify: true });
    const editor = editorFor(replica, id, {
      twin,
      trace: (kind) => paths[kind]++,
      onRemote: () => {
        if (!nested) return;
        const op = nested;
        nested = null;
        if (!safeOutside(replica.doc, path, op)) return;
        replica.change((d) => nativeEdit(d, path, op));
        // The twin writes the same change once it has merged the same peer.
        twinWrites.push(op);
      },
    });
    try {
      assertParity(editor.binding, replica, id, "initial", editor);
      operations.forEach((op, step) => {
        const label = `step ${step} ${op.kind}`;
        editor.outcomes.length = 0;
        switch (op.kind) {
          case "receive":
            if (drawable(A.merge(A.clone(replica.doc), peer), path))
              for (const r of replicas) r.receive(peer);
            break;
          case "catch-up":
            peer = A.merge(peer, replica.doc);
            break;
          case "remote-type":
          case "remote-delete":
          case "remote-mark": {
            const next = A.change(A.clone(peer), (d) => nativeEdit(d, path, op));
            if (drawable(next, path, false)) {
              A.free(peer);
              peer = next;
            }
            break;
          }
          case "other-block":
            for (const r of replicas)
              r.change((d) => {
                d.title = `Parity ${op.n % 10}`;
                d.blocks.other ??= { id: "other", richText: "" };
                A.splice(d, ["blocks", "other", "richText"], 0, 0, "o");
              });
            break;
          case "silent-title":
            for (const r of replicas) r.silently((d) => (d.title = `Silent ${op.n % 10}`));
            break;
          case "hold":
            for (const r of replicas) r.hold();
            break;
          case "release":
            for (const r of replicas) r.release();
            break;
          case "nested-write":
            nested = { ...op, kind: "outside-type" };
            break;
          case "outside-type":
            if (safeOutside(replica.doc, path, op))
              for (const r of replicas) r.change((d) => nativeEdit(d, path, op));
            break;
          default:
            local(editor, op);
        }
        for (const write of twinWrites.splice(0))
          twinReplica.change((d) => nativeEdit(d, path, write));
        // Some generated structural edits can't be stored or drawn back,
        // with this binding and the one before it; both bindings reject them,
        // and the editor rolls back to the accepted Page.
        for (const { fast, checked } of editor.outcomes)
          assert.equal(
            fast === "accepted",
            checked === "accepted",
            `${label}: ${fast} / ${checked}`,
          );
        assert.deepEqual(
          A.getHeads(replica.doc).sort(),
          A.getHeads(twinReplica.doc).sort(),
          `${label}: twin heads`,
        );
        if (replica.held) {
          // Held remote changes are invisible to the bindings until release.
          assert.ok(editor.binding.current.doc.eq(editor.state.doc), `${label}: held editor`);
          assert.ok(twin.current.doc.eq(editor.binding.current.doc), `${label}: held twin`);
        } else {
          assertParity(twin, twinReplica, id, `${label} (twin)`);
          assertParity(editor.binding, replica, id, label, editor);
        }
      });
    } finally {
      editor.binding.destroy();
      twin.destroy();
      keep(replica.doc);
      keep(twinReplica.doc);
      keep(peer);
    }
  });
  return paths;
}

test("the binding's projection equals a fresh decode after every local and remote change", () => {
  const totals = { local: 0, remote: 0, read: 0 };
  fc.assert(
    fc.property(
      pageTreeArbitrary({ maxDepth: fuzzDepth }),
      fc.array(operation, { minLength: 1, maxLength: 30 }),
      (description, operations) => {
        const paths = runParity(description, operations);
        for (const kind of Object.keys(totals)) totals[kind] += paths[kind];
      },
    ),
    parameters,
  );
  // The search must reach both carried paths, not only reads.
  assert.ok(totals.local > 0, `local carries: ${JSON.stringify(totals)}`);
  assert.ok(totals.remote > 0, `remote carries: ${JSON.stringify(totals)}`);
});

test("plain typing and remote text patches carry the projection without a read", () => {
  freeing((keep) => {
    const { doc, id } = pageWith(schema.doc([Paragraph.create([Leaf.text("start")])]));
    const replica = replicaFor(doc),
      twinReplica = replicaFor(A.clone(doc, { actor: ACTORS[0] })),
      twin = createWordgardBinding(twinReplica, id, { verify: true }),
      paths = [];
    const editor = editorFor(replica, id, { twin, trace: (kind) => paths.push(kind) }),
      events = [];
    editor.binding.observe((event) => events.push(event));
    Command.dispatch(editor, insertText, { from: 1, to: 1, insert: "hello" });
    assert.deepEqual(paths, ["read", "local"]);
    assert.equal(editor.binding.current.doc, editor.state.doc);
    const peer = A.change(A.clone(replica.doc, { actor: ACTORS[1] }), (d) =>
      A.splice(d, textPath(id), 2, 0, "XY"),
    );
    replica.receive(peer);
    assert.deepEqual(paths, ["read", "local", "remote"]);
    const event = events.at(-1);
    assert.equal(event.remote, true);
    // Remote patches built the change set and the tree it produces.
    assert.equal(event.changes.apply(event.before.doc), event.after.doc);
    assert.equal(editor.binding.current.doc, editor.state.doc);
    assertParity(editor.binding, replica, id, "after remote typing", editor);
    editor.binding.destroy();
    twin.destroy();
    keep(replica.doc);
    keep(twinReplica.doc);
    keep(peer);
  });
});

test("verify mode reads and compares the block after every local write", () => {
  freeing((keep) => {
    const { doc, id } = pageWith(schema.doc([Paragraph.create([Leaf.text("start")])]));
    const replica = replicaFor(doc),
      paths = [];
    const binding = createWordgardBinding(replica, id, {
      verify: true,
      trace: (kind) => paths.push(kind),
    });
    const state = GardState.create({
      doc: binding.current.doc,
      config: [GardState.schemaElement.of(schema.elements)],
    });
    const tr = state.update({ changes: { from: 1, insert: [Leaf.text("x", [Strong])] } });
    binding.applyEditorTransaction(tr);
    // Creation, mark positions after the splice, and the final comparison.
    assert.deepEqual(paths, ["read", "read", "read"]);
    // A checked write still publishes the editor's own tree.
    assert.equal(binding.current.doc, tr.newDoc);
    assertParity(binding, replica, id, "verified");
    binding.destroy();
    keep(replica.doc);
  });
});
