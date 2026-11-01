// Adapted from rgbkrk/wordgard-automerge c9c6ea8 (BSD-3-Clause).
import * as A from "@automerge/automerge/slim";
import { ChangeSet, Leaf, Token } from "wordgard/doc";
import { Correction, GardSelection, GardState, Transaction } from "wordgard/state";
import { insertLineBreak } from "wordgard/command";
import { history } from "wordgard/history";
import {
  decode,
  encode,
  expand,
  toMarks,
  markNames,
  CodeBlock,
  LineBreak,
  OrderedList,
} from "./wordgard-model.mjs";
import { projectChanges } from "./wordgard-projection.mjs";
import { MARK_NAMES, markExpand } from "../model/marks.mjs";
import { stampMarks, stampSpans } from "../model/schema-features.mjs";

// Enter inserts LineBreak leaves, while Wordgard's code clipboard parser can
// insert text containing newlines. Keep one editor representation before local
// transactions reach the native binding. Correction skips remote transactions;
// decode already normalizes those and the native source remains ordinary text.
// Code text also carries no marks: Markdown fences and the shared codec can't
// express formatting inside code.
// Mark changes only: replacing the text would create new Automerge characters
// and detach comments and cursors anchored there. A newline becomes a
// LineBreak leaf through its own one-character replacement, and mark removals
// skip those characters so the two kinds of change never overlap.
const unmark = (from, text, marks) =>
  marks.length
    ? text
        .split("\n")
        .flatMap((part, i, parts) => {
          const start = from + parts.slice(0, i).reduce((n, p) => n + p.length + 1, 0);
          return part ? [{ from: start, to: start + part.length }] : [];
        })
        .flatMap((range) => marks.map((mark) => ({ ...range, remove: mark })))
    : [];
const normalizeCode = (position) => {
  const changes = [];
  let from = position.start;
  for (const child of position.node.content) {
    if (child.isText) {
      for (let i = child.param.indexOf("\n"); i >= 0; i = child.param.indexOf("\n", i + 1))
        changes.push({ from: from + i, to: from + i + 1, insert: [LineBreak] });
      changes.push(...unmark(from, child.param, child.marks));
    }
    from += child.length;
  }
  return changes.length ? changes : null;
};
export const wordgardCodeNewlines = [
  Correction.onContent(CodeBlock, normalizeCode),
  // onContent sees inserted text; onMarks sees marks added to existing text.
  Correction.onMarks(Leaf.Text, (position) =>
    position.node.marks.length && position.parent?.node.type === CodeBlock.type
      ? unmark(position.before, position.node.param, position.node.marks)
      : null,
  ),
];

// Shift+Enter. A hard break is a native block marker, which can't carry
// marks, so insert an unmarked break and keep the active marks on the cursor
// for the text typed after it. Wordgard's command copies them onto the break.
export const insertPlainLineBreak = (target) => {
  const { state } = target;
  if (state.readOnly) return false;
  const brk = state.doc.schema.lineBreak;
  if (!brk || !state.doc.schema.canContain(state.sel.from.parent.node.type, brk.type))
    return insertLineBreak(target);
  const { from, to } = state.selection.replacementRange;
  const changes = ChangeSet.create(state.doc, { from, to, insert: [brk], fit: true });
  const pos = changes.findInserted((node) => node.type === brk.type);
  return {
    changes,
    selection: GardSelection.Text.create({
      anchor: pos == null ? from : pos + 1,
      marks: state.sel.activeMarks,
    }),
    scrollIntoView: true,
    userEvent: "insert.linebreak",
  };
};

// Pages stores ordered items without a start-number attribute. Normalize the
// editable list tag before encoding, including upstream input rules and paste.
export const wordgardListStarts = Correction.onContent(OrderedList, (position) =>
  position.node.tag.param === 1
    ? null
    : {
        from: position.before,
        to: position.before + 1,
        insert: [OrderedList.of(1).withMarks(position.node.tag.marks)],
      },
);

// Where an editor position lands after a binding change event. Positions are
// carried through native Automerge cursors, so they follow characters rather
// than a projection diff. A caret sticks to the character before it: when a
// peer types at the same spot, their text lands after the caret and each
// person keeps typing an unbroken run. Selection ends, and a caret with no
// character before it, stick to the character after them. If the character a
// caret sticks to is deleted, the caret stays where it was.
export function remoteEditorPosition(event, path, pos, { caret = false } = {}) {
  const { before, after, nativeBefore, nativeAfter } = event;
  const index = before.map.wgToAm[pos];
  let offset;
  if (caret && index > 0) {
    const cursor = A.getCursor(nativeBefore, path, index - 1, "after");
    const at = A.getCursorPosition(nativeAfter, path, cursor);
    let alive = false;
    try {
      alive = A.getCursor(nativeAfter, path, at, "after") === cursor;
    } catch {
      /* `at` is past the end: the character is gone. */
    }
    offset = alive ? at + 1 : at;
  } else {
    const cursor = A.getCursor(nativeBefore, path, index, "after");
    offset = A.getCursorPosition(nativeAfter, path, cursor);
  }
  return after.map.amToWg[offset] ?? after.doc.length - 1;
}

// Undo history for one editor, in a compartment so a rejected local
// transaction can drop it. A rejected change stays in the history even though
// the Page never accepted it, and undoing it would apply its inverse to the
// restored document.
export function wordgardHistory() {
  const slot = new GardState.Compartment();
  return {
    extension: slot.of(history()),
    // Separate transactions: reinstalling history in the same transaction
    // keeps the existing field value.
    reset: () => [slot.reconfigure([]), slot.reconfigure(history())],
  };
}

// Commit local editor transactions through the binding. A rejected
// transaction rolls back inside replica.change, so the Page keeps its last
// accepted state. Put the editor back on that projection, reset its undo
// history, and rethrow so the caller can show the error.
export function commitEditorTransactions(
  editor,
  binding,
  transactions,
  { annotations = [], undoHistory = null } = {},
) {
  try {
    for (const tr of transactions)
      if (!tr.annotation(Transaction.remote)) binding.applyEditorTransaction(tr);
  } catch (error) {
    editor.dispatch({
      changes: projectChanges(editor.state.doc, binding.current.doc),
      annotations: [...annotations, history.isolate.of(true)],
    });
    for (const effects of undoHistory?.reset() ?? []) editor.dispatch({ effects, annotations });
    throw error;
  }
}

// `encodeSpans` exists for mixed-version tests that stand in for an older
// build's encoder. The editor always uses the current `encode`.
export function createWordgardBinding(replica, id, { encodeSpans = encode } = {}) {
  const path = ["blocks", id, "richText"],
    listeners = new Set();
  let current = decode(A.spans(replica.doc, path));
  const stop = replica.observeChange((event) => {
    // A Pages session publishes the whole document stream. Only this canonical
    // text path (or an ancestor replacement) can change this editor projection.
    if (
      Array.isArray(event.patches) &&
      !event.patches.some(
        (patch) =>
          Array.isArray(patch.path) &&
          path
            .slice(0, Math.min(path.length, patch.path.length))
            .every((part, index) => part === patch.path[index]),
      )
    )
      return;
    const nativeBefore = event.patchInfo?.before ?? event.before;
    const nativeAfter = event.patchInfo?.after ?? event.after;
    if (!nativeAfter.blocks?.[id]) return;
    const before = current,
      after = decode(A.spans(nativeAfter, path));
    current = after;
    const changes = projectChanges(before.doc, after.doc);
    const remoteChanges = event.remote
      ? A.getChangesMetaSince(nativeAfter, A.getHeads(nativeBefore))
      : [];
    const actors = [...new Set(remoteChanges.map((change) => change.actor))];
    // Change hashes name an edit even when one actor writes for several
    // people (the host writes every API agent's edit with its own actor).
    const hashes = remoteChanges.map((change) => change.hash);
    // Op ranges let a reader find which change wrote a given character.
    const changeOps = remoteChanges.map(({ hash, actor, startOp, maxOp }) => ({
      hash,
      actor,
      startOp,
      maxOp,
    }));
    for (const listener of listeners)
      listener({
        before,
        after,
        nativeBefore,
        nativeAfter,
        changes,
        remote: !!event.remote,
        actors,
        hashes,
        changeOps,
      });
  });
  return {
    get current() {
      return current;
    },
    observe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    applyEditorTransaction(tr) {
      if (!tr.docChanged || tr.annotation(Transaction.remote)) return;
      const original = decode(A.spans(replica.doc, path));
      if (!original.doc.eq(tr.startState.doc))
        throw Error("Wordgard editor is behind its Pages document");
      const replacements = [],
        formats = [];
      let structural = false;
      tr.changes.iterChanges(
        (from, to, fromB, toB, inserted) => {
          const removed = tr.startState.doc.slice(from, to);
          if (
            [...inserted, ...removed].some(
              (token) => token.tokenType !== Token.Type.Node || !token.isText,
            )
          )
            structural = true;
          if (to - from !== original.map.wgToAm[to] - original.map.wgToAm[from]) structural = true;
          replacements.push({ from, to, fromB, toB, inserted });
        },
        (_a, _b, from, to, modifications) => {
          for (const mod of modifications ?? []) {
            try {
              formats.push(
                "add" in mod
                  ? { from, to, add: toMarks([mod.add]) }
                  : { from, to, remove: markNames(mod.remove) },
              );
            } catch {
              structural = true;
            }
          }
        },
      );
      return replica.change((d) => {
        // Schema features this transaction's content needs join the Page's
        // stamp in the same change.
        if (structural) {
          const spans = encodeSpans(tr.newDoc);
          A.updateSpans(d, path, spans, expand);
          stampSpans(d, spans);
        } else {
          const written = new Set();
          for (const range of [...replacements].reverse()) {
            const from = original.map.wgToAm[range.from],
              to = original.map.wgToAm[range.to];
            A.splice(
              d,
              path,
              from,
              to - from,
              range.inserted.map((token) => String(token.param)).join(""),
            );
          }
          // Positions come from the actual native text, not a canonical re-encode.
          const next = decode(A.spans(d, path)).map;
          for (const range of replacements) {
            let pos = next.wgToAm[range.fromB];
            for (const token of range.inserted) {
              const length = String(token.param).length,
                desired = toMarks(token.marks);
              const present = A.marks(d, path).filter(
                (mark) => mark.start < pos + length && mark.end > pos,
              );
              const names = new Set([
                ...MARK_NAMES,
                ...Object.keys(desired),
                ...present.map((mark) => mark.name),
              ]);
              for (const name of names) {
                const range = { start: pos, end: pos + length, expand: markExpand(name) };
                if (desired[name] !== undefined) {
                  A.mark(d, path, range, name, desired[name]);
                  written.add(name);
                } else if (present.some((mark) => mark.name === name))
                  A.unmark(d, path, range, name);
              }
              pos += length;
            }
          }
          for (const format of formats) {
            const start = next.wgToAm[format.from],
              end = next.wgToAm[format.to];
            if (end <= start) continue;
            for (const name of format.remove ?? [])
              A.unmark(d, path, { start, end, expand: "both" }, name);
            for (const [name, value] of Object.entries(format.add ?? {})) {
              A.mark(d, path, { start, end, expand: markExpand(name) }, name, value);
              written.add(name);
            }
          }
          stampMarks(d, written);
        }
        if (!decode(A.spans(d, path)).doc.eq(tr.newDoc))
          throw Error("Wordgard operation did not reproduce its native Pages projection");
      });
    },
    destroy() {
      stop();
      listeners.clear();
    },
  };
}
