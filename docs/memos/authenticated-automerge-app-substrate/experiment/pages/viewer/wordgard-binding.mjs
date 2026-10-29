// Adapted from rgbkrk/wordgard-automerge c9c6ea8 (BSD-3-Clause).
import * as A from "@automerge/automerge/slim";
import { Token } from "wordgard/doc";
import { Correction, GardState, Transaction } from "wordgard/state";
import { history } from "wordgard/history";
import {
  decode,
  encode,
  expand,
  toMarks,
  markName,
  CodeBlock,
  LineBreak,
  OrderedList,
} from "./wordgard-model.mjs";
import { projectChanges } from "./wordgard-projection.mjs";

// Enter inserts LineBreak leaves, while Wordgard's code clipboard parser can
// insert text containing newlines. Keep one editor representation before local
// transactions reach the native binding. Correction skips remote transactions;
// decode already normalizes those and the native source remains ordinary text.
export const wordgardCodeNewlines = Correction.onContent(CodeBlock, (position) => {
  const changes = [];
  let from = position.start;
  for (const child of position.node.content) {
    if (child.isText)
      for (let i = child.param.indexOf("\n"); i >= 0; i = child.param.indexOf("\n", i + 1))
        changes.push({ from: from + i, to: from + i + 1, insert: [LineBreak] });
    from += child.length;
  }
  return changes.length ? changes : null;
});

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

export function createWordgardBinding(replica, id) {
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
    const actors = event.remote
      ? [
          ...new Set(
            A.getChangesMetaSince(nativeAfter, A.getHeads(nativeBefore)).map(
              (change) => change.actor,
            ),
          ),
        ]
      : [];
    for (const listener of listeners)
      listener({
        before,
        after,
        nativeBefore,
        nativeAfter,
        changes,
        remote: !!event.remote,
        actors,
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
                  : { from, to, remove: markName(mod.remove) },
              );
            } catch {
              structural = true;
            }
          }
        },
      );
      return replica.change((d) => {
        if (structural) A.updateSpans(d, path, encode(tr.newDoc), expand);
        else {
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
              for (const name of ["strong", "em", "code", "link"]) {
                const range = {
                  start: pos,
                  end: pos + length,
                  expand: name === "link" || name === "code" ? "none" : "both",
                };
                if (desired[name] !== undefined) A.mark(d, path, range, name, desired[name]);
                else if (
                  A.marks(d, path).some(
                    (mark) => mark.name === name && mark.start < pos + length && mark.end > pos,
                  )
                )
                  A.unmark(d, path, range, name);
              }
              pos += length;
            }
          }
          for (const format of formats) {
            const start = next.wgToAm[format.from],
              end = next.wgToAm[format.to];
            if (end <= start) continue;
            if (format.remove) A.unmark(d, path, { start, end, expand: "both" }, format.remove);
            for (const [name, value] of Object.entries(format.add ?? {}))
              A.mark(
                d,
                path,
                { start, end, expand: name === "link" || name === "code" ? "none" : "both" },
                name,
                value,
              );
          }
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
