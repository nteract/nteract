// The Page host admits a browser change only when it writes content every
// Pages reader accepts (model/page-admission.mjs). Every change the browser
// editor writes must pass: random Pages, random editor commands through the
// real Wordgard binding, and admission on each change the binding commits.
// A refusal here means the editor and the host disagree on a valid Page.
// Replay a failure with --test-name-pattern plus PAGES_FUZZ_SEED and
// PAGES_FUZZ_PATH.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import * as A from "@automerge/automerge";
import { GardSelection, GardState, Transaction } from "wordgard/state";
import { Leaf } from "wordgard/doc";
import { history, redo, undo } from "wordgard/history";
import {
  Command,
  deleteUnit,
  enter,
  insertText,
  setTextblockType,
  toggleBlock,
  toggleList,
  toggleMark,
} from "wordgard/command";
import { addColumn, addRow, deleteRow } from "wordgard/table";
import {
  encode,
  schema,
  Blockquote,
  BulletList,
  Code,
  CodeBlock,
  CodeBlockLanguage,
  Emphasis,
  Heading,
  ListItem,
  OrderedList,
  PagesHighlight,
  PagesLink,
  Paragraph,
  Strikethrough,
  Strong,
  TaskChecked,
  TaskList,
} from "./wordgard-model.mjs";
import { projectChanges } from "./wordgard-projection.mjs";
import {
  createWordgardBinding,
  insertPlainLineBreak,
  wordgardCodeNewlines,
  wordgardHistory,
  wordgardListStarts,
} from "./wordgard-binding.mjs";
import { normalizeTaskItems } from "./wordgard-task-lists.mjs";
import { insertTable } from "./wordgard-tables.mjs";
import { createPageData } from "../model/page.mjs";
import { orderedBlockIds } from "../model/order.mjs";
import { admitPageChanges } from "../model/page-admission.mjs";
import { RICH_FORMAT, textPath } from "../model/richtext.mjs";
import { updateSpansConfig } from "../model/marks.mjs";
import { stampSpans } from "../model/schema-features.mjs";
import { PAGE_ID, pageTreeArbitrary, toWordgardTree } from "../test/random-page-tree.mjs";
import { fuzzDepth, fuzzParameters as parameters } from "../test/fuzz-parameters.mjs";
import { freeing } from "../test/free-docs.mjs";

const MARKS = [
  Strong,
  Emphasis,
  Code,
  Strikethrough,
  PagesHighlight.of("green"),
  PagesLink.of({ href: "https://example.org/p", title: null }),
  PagesLink.of({ href: "mailto:someone@example.org", title: "Mail" }),
];
const TEXT = ["x", "ab", " ", "é", "😀", "\n", "\uFFFC", "\uD83D", "**", "[x]"];
const TEXTBLOCKS = [
  Paragraph,
  Heading.of(1),
  Heading.of(3),
  CodeBlock,
  CodeBlock.withMarks([CodeBlockLanguage.of("mermaid")]),
];
const LISTS = [BulletList, OrderedList.of(1), TaskList];

/** A replica that admits every change it commits: `admissions` records each
 * change's answer and the operation that wrote it. */
function replicaFor(doc, admissions) {
  const observers = new Set();
  let label = "setup";
  return {
    get doc() {
      return doc;
    },
    label(next) {
      label = next;
    },
    change(fn) {
      const before = A.clone(doc);
      try {
        const previous = doc;
        doc = A.change(doc, fn);
        if (doc === previous) return;
        const result = admitPageChanges(before, doc);
        admissions.push({ label, result });
        for (const observer of observers)
          observer({
            remote: false,
            patches: A.diff(doc, A.getHeads(before), A.getHeads(doc)),
            patchInfo: { before, after: doc },
          });
      } finally {
        A.free(before);
      }
    },
    observeChange(fn) {
      observers.add(fn);
      return () => observers.delete(fn);
    },
  };
}

/** WordgardEditor's commit loop: a rejected transaction puts the editor back
 * on the accepted Page and resets its history. */
function editorFor(replica, id) {
  const binding = createWordgardBinding(replica, id),
    undoHistory = wordgardHistory();
  let writing = false;
  let state = GardState.create({
    doc: binding.current.doc,
    config: [
      GardState.schemaElement.of(schema.elements),
      wordgardCodeNewlines,
      wordgardListStarts,
      normalizeTaskItems,
      undoHistory.extension,
    ],
  });
  const remote = [Transaction.remote.of(true), Transaction.addToHistory.of(false)];
  const editor = {
    binding,
    editable: true,
    get state() {
      return state;
    },
    dispatch(spec) {
      const annotations = [spec.annotations ?? []].flat().concat(history.isolate.of(true));
      let trs;
      try {
        trs = Transaction.append(state.update({ ...spec, annotations }));
      } catch {
        // The editor's schema refused the command (a list around a code
        // block); nothing reached the Page.
        return;
      }
      state = trs.at(-1).state;
      writing = true;
      try {
        for (const tr of trs)
          if (!tr.annotation(Transaction.remote)) binding.applyEditorTransaction(tr);
      } catch {
        state = state.update({
          changes: projectChanges(state.doc, binding.current.doc),
          annotations: [...remote, history.isolate.of(true)],
        }).state;
        for (const effects of undoHistory.reset())
          state = state.update({ effects, annotations: remote }).state;
      } finally {
        writing = false;
      }
    },
  };
  binding.observe((event) => {
    if (writing) return;
    state = state.update({
      changes: projectChanges(state.doc, event.after.doc),
      annotations: [...remote, history.isolate.of(true)],
    }).state;
  });
  return editor;
}

const textPositions = (doc) => {
  const out = [];
  for (let pos = 0; pos <= doc.length; pos++) {
    const at = doc.resolve(pos);
    const pair = !!at.nodeBefore?.isText && /[\uD800-\uDBFF]$/.test(String(at.nodeBefore.param));
    if (at.parent.node.type.spec.inlineContent && !pair) out.push(pos);
  }
  return out;
};
const pick = (list, n) => list[n % list.length];

function run(editor, op) {
  const positions = textPositions(editor.state.doc);
  if (!positions.length) return;
  const anchor = pick(positions, op.a),
    head = pick(positions, op.a + op.span);
  const [from, to] = [Math.min(anchor, head), Math.max(anchor, head)];
  const select = (a, b = a) =>
    editor.dispatch({ selection: GardSelection.Text.create({ anchor: a, head: b }) });
  const command = (fn, ...args) => {
    const spec = fn({ state: editor.state }, ...args);
    if (spec) editor.dispatch(spec);
  };
  switch (op.kind) {
    case "type":
      select(anchor);
      Command.dispatch(editor, insertText, { from: anchor, to: anchor, insert: pick(TEXT, op.n) });
      break;
    case "replace":
      select(from, to);
      Command.dispatch(editor, insertText, { from, to, insert: pick(TEXT, op.n) });
      break;
    case "delete":
      select(from, to);
      Command.dispatch(editor, deleteUnit, op.n % 2 ? "forward" : "backward");
      break;
    case "mark":
      select(from, to);
      Command.dispatch(editor, toggleMark, pick(MARKS, op.n));
      break;
    case "marked-type":
      editor.dispatch({
        changes: { from: anchor, insert: [Leaf.text(pick(TEXT, op.n), [pick(MARKS, op.span)])] },
      });
      break;
    case "enter":
      select(anchor);
      Command.dispatch(editor, enter);
      break;
    case "line-break":
      select(anchor);
      command(insertPlainLineBreak);
      break;
    case "textblock":
      select(from, to);
      command(setTextblockType, pick(TEXTBLOCKS, op.n));
      break;
    case "list":
      select(from, to);
      command(toggleList, pick(LISTS, op.n));
      break;
    case "quote":
      select(from, to);
      command(toggleBlock, Blockquote);
      break;
    case "task": {
      // The checkbox: flip a task item's checked state.
      for (let pos = 0; pos < editor.state.doc.length; pos++) {
        const node = editor.state.doc.nodeAt(pos);
        if (node?.type !== ListItem.type) continue;
        if (editor.state.doc.resolve(pos).parent?.node.type !== TaskList.type) continue;
        editor.dispatch({
          changes: { from: pos, add: TaskChecked.of(node.mark(TaskChecked) !== true) },
        });
        break;
      }
      break;
    }
    case "table":
      select(anchor);
      insertTable(editor, 1 + (op.n % 3), 1 + (op.span % 3));
      break;
    case "table-edit":
      select(anchor);
      command(pick([(t) => addRow(t, "after"), (t) => addColumn(t, "after"), deleteRow], op.n));
      break;
    case "undo":
      command(undo);
      break;
    case "redo":
      command(redo);
      break;
  }
}

const operation = fc.record({
  kind: fc.constantFrom(
    "type",
    "type",
    "type",
    "replace",
    "delete",
    "delete",
    "mark",
    "mark",
    "marked-type",
    "enter",
    "line-break",
    "textblock",
    "list",
    "quote",
    "task",
    "table",
    "table-edit",
    "undo",
    "redo",
  ),
  a: fc.nat(),
  span: fc.nat({ max: 8 }),
  n: fc.nat(),
});

function pageWith(tree, admissions) {
  const doc = A.from(createPageData({ pageId: PAGE_ID, title: "Admission" }));
  const id = orderedBlockIds(doc)[0];
  const replica = replicaFor(doc, admissions);
  // The block as the editor's encoder writes it, as an editor's whole-block
  // rewrite does.
  replica.change((draft) => {
    draft.blocks[id].format = RICH_FORMAT;
    const spans = encode(tree);
    A.updateSpans(draft, textPath(id), spans, updateSpansConfig);
    stampSpans(draft, spans);
  });
  return { replica, id };
}

test("every change the browser editor writes is admitted by the Page host", () => {
  const totals = { changes: 0, fullReads: 0 };
  fc.assert(
    fc.property(
      pageTreeArbitrary({ maxDepth: fuzzDepth }),
      fc.array(operation, { minLength: 1, maxLength: 25 }),
      (description, operations) =>
        freeing((keep) => {
          const admissions = [];
          const { replica, id } = pageWith(toWordgardTree(description), admissions);
          const editor = editorFor(replica, id);
          try {
            operations.forEach((op, step) => {
              replica.label(`step ${step} ${op.kind}`);
              run(editor, op);
            });
          } finally {
            editor.binding.destroy();
            keep(replica.doc);
          }
          for (const { label, result } of admissions) {
            assert.equal(result.ok, true, `${label}: ${JSON.stringify(result.reason)}`);
            totals.changes++;
            totals.fullReads += result.stats.fullReads;
          }
        }),
    ),
    parameters,
  );
  assert.ok(totals.changes > 0, JSON.stringify(totals));
});
