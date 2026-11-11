// Adapted from rgbkrk/wordgard-automerge c9c6ea8 (BSD-3-Clause).
import * as A from "@automerge/automerge/slim";
import { stickyCaret, stickyCaretPosition } from "../model/sticky-caret.mjs";
import { ChangeSet, Leaf, Mark, Token } from "wordgard/doc";
import { Correction, GardSelection, GardState, Transaction } from "wordgard/state";
import { insertLineBreak } from "wordgard/command";
import { history } from "wordgard/history";
import {
  decode,
  encode,
  expand,
  fromMarks,
  toMarks,
  markNames,
  CodeBlock,
  LineBreak,
  OrderedList,
} from "./wordgard-model.mjs";
import { projectChanges } from "./wordgard-projection.mjs";
import {
  projectionAt,
  projectionStep,
  publishedProjection,
  synced,
} from "./wordgard-projection-state.mjs";
import { MARK_NAMES, markExpand } from "../model/marks.mjs";
import { updateSpansExactly } from "../model/richtext-format.mjs";
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
// than a projection diff. A caret sticks to the code point before it (see
// model/sticky-caret.mjs). Selection ends, and a caret with no character
// before it, stick to the character after them.
export function remoteEditorPosition(event, path, pos, { caret = false } = {}) {
  const { before, after, nativeBefore, nativeAfter } = event;
  const index = before.map.wgToAm[pos];
  const textOf = (doc) => path.reduce((value, key) => value?.[key], doc) ?? "";
  let offset;
  if (caret && index > 0) {
    const cursor = stickyCaret(nativeBefore, path, textOf(nativeBefore), index);
    offset = stickyCaretPosition(nativeAfter, path, textOf(nativeAfter), cursor);
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

const textOnly = (tokens) =>
  [...tokens].every((token) => token.tokenType === Token.Type.Node && token.isText);
// Characters decode draws as something other than text: a newline becomes a
// LineBreak leaf, and U+FFFC stands for a node.
const SPECIAL_TEXT = /[\n\uFFFC]/;
const inlineParent = (pos) => !!pos.parent.node.type.spec.inlineContent;
// Automerge won't split a surrogate pair, so a native splice there lands
// elsewhere than the editor's.
const splitsPair = (doc, pos) => {
  const before = doc.resolve(pos).nodeBefore;
  return !!before?.isText && /[\uD800-\uDBFF]$/.test(String(before.param));
};
/** Whether the textblock holding editor position `pos` opens with a native
 * marker of its own: false for unmarked text, which only a merge leaves. */
function ownMarker({ doc, map }, pos) {
  const level = doc.resolve(pos).parent;
  if (!level?.parent || !level.node.type.spec.inlineContent) return true;
  return map.wgToAm[level.before + 1] > map.wgToAm[level.before];
}
/** Whether every textblock the editor range `[from, to]` touches opens with
 * a native marker of its own (ownMarker). */
function rangeMarked(projection, from, to) {
  if (!ownMarker(projection, from) || !ownMarker(projection, to)) return false;
  let marked = true;
  projection.doc.iterate(from, to, (node, pos) => {
    if (node.inlineContent && !ownMarker(projection, pos + 1)) marked = false;
  });
  return marked;
}
/** `spans` with the native ranges `[from, to)` (ascending, disjoint) cut out. */
function withoutRanges(spans, ranges) {
  const out = [];
  let at = 0;
  for (const span of spans) {
    if (span.type === "text") {
      let kept = "";
      for (let i = 0; i < span.value.length; i++)
        if (!ranges.some(([from, to]) => at + i >= from && at + i < to)) kept += span.value[i];
      if (kept) out.push({ ...span, value: kept });
      at += span.value.length;
    } else {
      if (!ranges.some(([from, to]) => at >= from && at < to)) out.push(span);
      at++;
    }
  }
  return out;
}
const plainValue = (value) =>
  JSON.stringify(value, (_key, item) => {
    if (A.isImmutableString(item)) return String(item);
    if (item && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    return item;
  });
/** Whether two span lists store the same content: adjacent text runs with
 * the same marks are one run. */
function sameSpans(a, b) {
  const runs = (spans) => {
    const out = [];
    for (const span of spans) {
      if (span.type !== "text") out.push({ type: span.type, value: plainValue(span.value) });
      else if (span.value) {
        const marks = plainValue(span.marks ?? {});
        const last = out.at(-1);
        if (last?.type === "text" && last.marks === marks) last.value += span.value;
        else out.push({ type: "text", value: span.value, marks });
      }
    }
    return JSON.stringify(out);
  };
  return runs(a) === runs(b);
}
const nativeLength = (doc, id) => String(doc.blocks?.[id]?.richText ?? "").length;

/** Position maps after replacing editor range `[from, to)` with `length`
 * characters of text, where the replaced range and the new text are plain
 * text: one editor position per native index. */
export function spliceProjectionMap({ wgToAm, amToWg }, from, to, length) {
  const start = wgToAm[from],
    end = wgToAm[to],
    shift = length - (to - from),
    nextWgToAm = wgToAm.slice(0, from),
    nextAmToWg = amToWg.slice(0, start);
  for (let i = 0; i < length; i++) {
    nextWgToAm.push(start + i);
    nextAmToWg.push(from + i);
  }
  for (let i = to; i < wgToAm.length; i++) nextWgToAm.push(wgToAm[i] + shift);
  for (let i = end; i < amToWg.length; i++) nextAmToWg.push(amToWg[i] + shift);
  return { wgToAm: nextWgToAm, amToWg: nextAmToWg };
}

// The editor position where decode would draw text inserted at native
// `index`, or null when it would land outside a textblock (decode would
// draw it as unmarked text). Text inserted before a block marker, or at the
// end, joins the content before it: the first editor position sharing that
// native index.
function insertionPoint(doc, map, index) {
  let pos = map.amToWg[index];
  if (pos === undefined || map.wgToAm[pos] !== index) return null;
  const at = doc.resolve(pos);
  if (!(inlineParent(at) && at.nodeAfter)) while (pos > 0 && map.wgToAm[pos - 1] === index) pos--;
  return inlineParent(doc.resolve(pos)) ? pos : null;
}

/** Apply Automerge text patches to a decoded block without reading it again.
 * Handles plain-text insertions and deletions inside textblocks; returns null
 * for anything else (marks, block markers, newlines, unknown actions), and
 * the caller reads the block instead. */
export function applyTextPatches(projection, patches, path) {
  let { doc, map } = projection,
    changes = null;
  for (const patch of patches) {
    const at = patch.path;
    if (!Array.isArray(at)) return null;
    const shared = Math.min(at.length, path.length);
    if (!path.slice(0, shared).every((part, index) => part === at[index])) continue;
    const index = at[path.length];
    if (at.length !== path.length + 1 || typeof index !== "number") return null;
    let step;
    try {
      if (patch.action === "del") {
        const length = patch.length ?? 1,
          from = map.amToWg[index],
          to = from + length;
        if (from === undefined || map.wgToAm[from] !== index || map.wgToAm[to] !== index + length)
          return null;
        if (!textOnly(doc.slice(from, to))) return null;
        step = ChangeSet.create(doc, { from, to });
        // An emptied paragraph of unmarked text has no marker to
        // keep it, and decode draws no paragraph for it.
        if (!step.apply(doc).resolve(from).parent.node.content.length) return null;
        map = spliceProjectionMap(map, from, to, 0);
      } else if (patch.action === "splice") {
        const text = patch.value;
        if (typeof text !== "string" || !text || SPECIAL_TEXT.test(text)) return null;
        const from = insertionPoint(doc, map, index);
        if (from === null) return null;
        // Code text carries no marks in the editor (see decode).
        const marks =
          doc.resolve(from).parent.node.type === CodeBlock.type
            ? Mark.none
            : fromMarks(
                Object.fromEntries(
                  Object.entries(patch.marks ?? {}).filter(([, value]) => value != null),
                ),
              );
        step = ChangeSet.create(doc, { from, insert: [Leaf.text(text, marks)] });
        map = spliceProjectionMap(map, from, from, text.length);
      } else return null;
    } catch {
      return null;
    }
    doc = step.apply(doc);
    changes = changes ? changes.compose(step) : step;
  }
  if (!changes) return null;
  // Applying the composed set to the starting tree gives the same object the
  // editor gets when it dispatches these changes (ChangeSet caches apply).
  return { projection: { doc: changes.apply(projection.doc), map, lossy: false }, changes };
}

// `encodeSpans` lets a test replace the encoder to force a failed write check.
// The editor always uses the current `encode`.
//
// The binding carries the decoded block forward through the projection
// lifecycle in wordgard-projection-state.mjs. A whole-block read (A.spans +
// decode) happens when the projection can't be carried: on creation, when the
// heads moved without this binding seeing the change, for structural or
// formatting writes (once, as their check), and for remote patches
// applyTextPatches can't map. Plain local typing and remote plain-text patches
// update the tree and position maps in place; a local write then checks the
// native length and the inserted text.
//
// `verify` makes every local write read the block: mark and format positions
// come from that read instead of offset arithmetic, and the result must equal
// the editor's tree. `trace` receives "local" and "remote" when a projection
// is carried without a read, and "read" for each whole-block read.
export function createWordgardBinding(
  replica,
  id,
  { encodeSpans = encode, verify = false, trace = () => {} } = {},
) {
  const path = ["blocks", id, "richText"],
    listeners = new Set();
  const read = (doc) => {
    trace("read");
    return decode(A.spans(doc, path));
  };
  const touches = (at) =>
    Array.isArray(at) &&
    path.slice(0, Math.min(path.length, at.length)).every((part, index) => part === at[index]);
  let state = synced(A.getHeads(replica.doc), read(replica.doc));
  const step = (event) => (state = projectionStep(state, event));
  // A plain write's projection matches the Page when the native text has the
  // projected length and holds each inserted string where it was written.
  // (Reading the text after the change costs nothing: the document keeps it
  // materialized.)
  const holdsWrite = (doc, projection, inserted) => {
    if (!inserted) return true;
    const text = String(doc.blocks?.[id]?.richText ?? "");
    return (
      text.length === projection.map.wgToAm.at(-1) &&
      inserted.every(({ at, text: value }) => text.startsWith(value, at))
    );
  };
  const stop = replica.observeChange((event) => {
    const nativeBefore = event.patchInfo?.before ?? event.before;
    const nativeAfter = event.patchInfo?.after ?? event.after;
    const patches = Array.isArray(event.patches) ? event.patches : null;
    const beforeHeads = nativeBefore ? A.getHeads(nativeBefore) : null,
      afterHeads = A.getHeads(nativeAfter);
    // A Pages session publishes the whole document stream. Only this canonical
    // text path (or an ancestor replacement) can change this editor projection;
    // the projection still describes the text after any other change.
    if (patches && !patches.some((patch) => touches(patch.path))) {
      step(
        beforeHeads
          ? { type: "advance", before: beforeHeads, after: afterHeads }
          : { type: "invalidate" },
      );
      return;
    }
    if (!nativeAfter.blocks?.[id]) {
      step({ type: "invalidate" });
      return;
    }
    const before = publishedProjection(state);
    let changes = null;
    if (!event.remote && state.type === "writing") {
      const checked = holdsWrite(nativeAfter, state.pending, state.check);
      if (checked && state.check) trace("local");
      step({ type: "commit", before: beforeHeads, after: afterHeads, checked });
    } else {
      const base = projectionAt(state, beforeHeads);
      const next = base && patches && !base.lossy ? applyTextPatches(base, patches, path) : null;
      if (next && next.projection.map.wgToAm.at(-1) === nativeLength(nativeAfter, id)) {
        trace("remote");
        changes = next.changes;
        step({
          type: "advance",
          before: beforeHeads,
          after: afterHeads,
          projection: next.projection,
        });
      } else step({ type: "invalidate" });
    }
    if (!projectionAt(state, afterHeads))
      step({ type: "read", heads: afterHeads, projection: read(nativeAfter) });
    const after = publishedProjection(state);
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
    // `changes` maps `before.doc` to `after.doc`. Remote text patches supply
    // it; otherwise the projection diff runs only when a listener reads it.
    const payload = {
      before,
      after,
      nativeBefore,
      nativeAfter,
      get changes() {
        return (changes ??= projectChanges(before.doc, after.doc));
      },
      remote: !!event.remote,
      actors,
      hashes,
      changeOps,
    };
    for (const listener of listeners) listener(payload);
  });
  return {
    get current() {
      return publishedProjection(state);
    },
    observe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    applyEditorTransaction(tr) {
      if (!tr.docChanged || tr.annotation(Transaction.remote)) return;
      const heads = A.getHeads(replica.doc);
      let original = projectionAt(state, heads);
      if (!original) {
        original = read(replica.doc);
        // Publish the read, so a rejected transaction restores the editor to
        // the Page as it is.
        step({ type: "read", heads, projection: original });
      }
      // The editor couldn't draw this block as stored because it holds
      // content from a newer build; any write would reshape what it left out.
      if (original.lossy && original.newer)
        throw Error("This block holds content from a newer version of Pages. Reload to edit it.");
      if (original.doc !== tr.startState.doc && !original.doc.eq(tr.startState.doc))
        throw Error("Wordgard editor is behind its Pages document");
      const replacements = [],
        formats = [];
      // A block whose only problem is nesting a merge left (decode's
      // `adjusted`) is written through encode, which stores the tree the
      // editor drew.
      let structural = !!original.adjusted;
      tr.changes.iterChanges(
        (from, to, fromB, toB, inserted) => {
          const removed = tr.startState.doc.slice(from, to);
          if (!textOnly([...inserted, ...removed])) structural = true;
          if (to - from !== original.map.wgToAm[to] - original.map.wgToAm[from]) structural = true;
          // An edit inside unmarked text (no marker opens its textblock; see
          // decode) is written through encode, which gives it its marker.
          if (!ownMarker(original, from)) structural = true;
          replacements.push({ from, to, fromB, toB, inserted });
        },
        (fromA, toA, from, to, modifications) => {
          // Formatting inside unmarked text, or a selection that reaches
          // into it, is written through encode too, which marks it.
          if (modifications?.length && !rangeMarked(original, fromA, toA)) structural = true;
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
      // Plain typing: the native text decodes to exactly the editor's tree, so
      // the new projection is `tr.newDoc` with shifted position maps. Inserted
      // text must decode as the same text with the same marks: well-formed
      // UTF-16 (Automerge stores a lone surrogate as U+FFFD), no newline or
      // U+FFFC, marks that survive the native codec, and none inside code.
      const plain =
        !verify &&
        !structural &&
        !formats.length &&
        replacements.every(
          (range) =>
            !splitsPair(tr.startState.doc, range.from) &&
            !splitsPair(tr.startState.doc, range.to) &&
            // An emptied textblock stays as long as its own marker does;
            // emptied unmarked text has none, and decode draws nothing for it.
            (tr.newDoc.resolve(range.fromB).parent.node.content.length > 0 ||
              ownMarker(original, range.from)) &&
            range.inserted.every((token) => {
              const text = String(token.param);
              if (!text.isWellFormed() || SPECIAL_TEXT.test(text)) return false;
              if (!token.marks.length) return true;
              try {
                return (
                  tr.newDoc.resolve(range.fromB).parent.node.type !== CodeBlock.type &&
                  Mark.sameSet(fromMarks(toMarks(token.marks)), token.marks)
                );
              } catch {
                return false;
              }
            }),
        );
      // Replacements are text for text, so native offsets move one for one
      // with editor positions: this maps a position in `tr.newDoc` to the
      // native index after the splices.
      const shiftedAt = (posB) => {
        let shift = 0;
        for (const range of replacements) {
          if (posB < range.fromB) break;
          if (posB <= range.toB)
            return original.map.wgToAm[range.from] + shift + posB - range.fromB;
          shift += range.toB - range.fromB - (range.to - range.from);
        }
        return original.map.wgToAm[posB - shift] + shift;
      };
      try {
        return replica.change((d) => {
          // Schema features this transaction's content needs join the Page's
          // stamp in the same change.
          if (structural) {
            const spans = encodeSpans(tr.newDoc);
            // A deletion that removes whole nodes (Backspace in an empty
            // paragraph, a selection across nodes) deletes exactly the
            // native characters it covers when that leaves the encoded
            // spans. Rewriting through updateSpans instead could delete a
            // neighbour's marker with the same value and keep the removed
            // node's: the neighbour's node id and anything anchored to the
            // removed node would then move.
            const deleted =
              !formats.length &&
              replacements.length > 0 &&
              replacements.every((range) => range.toB === range.fromB)
                ? replacements.map((range) => [
                    original.map.wgToAm[range.from],
                    original.map.wgToAm[range.to],
                  ])
                : null;
            if (deleted && sameSpans(withoutRanges(A.spans(d, path), deleted), spans))
              for (const [from, to] of [...deleted].reverse()) A.splice(d, path, from, to - from);
            else updateSpansExactly(d, path, spans, expand);
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
            const spliced = verify ? read(d).map : null;
            const nativeAt = spliced ? (posB) => spliced.wgToAm[posB] : shiftedAt;
            for (const range of replacements) {
              let pos = nativeAt(range.fromB);
              for (const token of range.inserted) {
                const length = String(token.param).length,
                  desired = toMarks(token.marks);
                const present = A.marks(d, path)
                  .filter((mark) => mark.start < pos + length && mark.end > pos)
                  .map((mark) => mark.name);
                const names = new Set([...MARK_NAMES, ...Object.keys(desired), ...present]);
                for (const name of names) {
                  const range = { start: pos, end: pos + length, expand: markExpand(name) };
                  if (desired[name] !== undefined) {
                    A.mark(d, path, range, name, desired[name]);
                    written.add(name);
                  } else if (present.includes(name)) A.unmark(d, path, range, name);
                }
                pos += length;
              }
            }
            for (const format of formats) {
              const start = nativeAt(format.from),
                end = nativeAt(format.to);
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
          let pending, inserted;
          if (plain) {
            const map = replacements.reduceRight(
              (result, range) =>
                spliceProjectionMap(result, range.from, range.to, range.toB - range.fromB),
              original.map,
            );
            pending = { doc: tr.newDoc, map, lossy: false };
            inserted = replacements.map((range) => ({
              at: shiftedAt(range.fromB),
              text: range.inserted.map((token) => String(token.param)).join(""),
            }));
          } else {
            const checked = read(d);
            if (!checked.doc.eq(tr.newDoc)) {
              step({ type: "invalidate" });
              throw Error("Wordgard operation did not reproduce its native Pages projection");
            }
            // The editor's own tree, so the next event's identity check holds.
            pending = { ...checked, doc: tr.newDoc };
          }
          step({ type: "begin", heads, pending, check: inserted });
        });
      } finally {
        step({ type: "end" });
      }
    },
    destroy() {
      stop();
      listeners.clear();
    },
  };
}
