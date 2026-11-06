// Page-body admission: whether a batch of Automerge changes to a Page
// document writes only content every Pages reader and writer accepts.
//
// `admitPageChanges(live, preview)` judges what the batch *changes*. `live`
// is the admitted document; `preview` is `live` with the batch applied. The
// batch is judged between `live` and `preview`. The batch's base is the
// heads its changes depend on outside the batch: what its writer saw. When
// that isn't `live`'s heads (concurrent edits) and the batch is refused for
// its structure, size or title, which another writer's edits can cause, it
// is judged again between views of `preview` at its base and at its own
// tips, and that answer stands. So an honest frame is admitted whichever
// concurrent frame the host admitted first. Merging two admitted frames can
// still leave shapes the tree check refuses; readers repair those
// (readableSpans in model/richtext-spans.mjs). Reads at older heads cost
// about a whole-document read, so only those refusals pay for them.
//
// The patches between the two states (A.diff) name every path the batch
// writes, and each write is checked against the rule for that path:
//
//   root key        one of PAGE_ROOT_KEYS (model/page-shape.mjs). page_id
//                   never changes; page_id, title and blocks are never
//                   deleted; the schema stamp never loses an id and gains
//                   only well-formed ones (FEATURE_ID). Deleting any other
//                   key is cleanup and is admitted.
//   title           text or a string, at most TITLE_MAX_LENGTH, or no longer
//                   than it was.
//   block entry     a new entry passes validBlockEntry and its rich text the
//                   full validateRichSpans check; a written field passes its
//                   BLOCK_FIELDS rule; no other key, though deleting one is
//                   admitted.
//   conflicts       a key the batch puts is checked on every value it holds
//                   at the batch's tips (getAll), not only the winner the
//                   patches show; two block entries or objects under one key
//                   are refused.
//   mark            a mark patch carries name and value: a known mark with a
//                   registry value (validateMarkValue), or null (removal).
//                   Text inserted with a mark carries it in its splice patch;
//                   an unknown or invalid one is admitted only when the text
//                   beside the insertion point already held exactly that mark
//                   and value.
//   typed text      text inserted straight after a rule or dataframe marker,
//                   which no reader places, is refused unless the base held
//                   text at that spot already. One marker read per insertion.
//   block marker    each inserted or changed marker, read on its own at its
//                   final index (getBlock), passes validateMarkerValue.
//   block size      a block whose native length grows ends at most
//                   BLOCK_MAX_LENGTH (backend length, not spans).
//
// A batch that inserts, changes or deletes a block marker can change where
// the block's nodes sit, which no patch shows. That block, and only that
// block, is read whole: spanTreeErrors on its spans after the batch, and on
// the base when those fail. The batch is refused only for a tree error it
// adds (addsTreeError). A delete finds the markers it removed by probing the
// base at each deleted index, up to MARKER_PROBE_LIMIT characters; a longer
// delete reads its block. A whole block is also read for a new block, a
// replaced text object, a `richText` that isn't a text object, or a marker
// the patch path couldn't place. Typing, short text deletes, formatting and
// title edits never read a whole block.
//
// Content stored before this check stays: a write is judged by what it
// writes, so an edit to a block with legacy content is refused only when the
// edit itself is invalid.
//
// Known limits: a concurrent mark or marker attribute that loses to another
// in the same batch isn't seen (patches show the winner, and losing marks
// don't surface in reads). Marker attrs and block `metadata` have no
// per-block size bound of their own; the 16 MiB history bound covers them.
import * as A from "@automerge/automerge/slim";
import { validateMarkValue, markSpec } from "./marks.mjs";
import {
  BLOCK_KEYS,
  BLOCK_MAX_LENGTH,
  PAGE_ROOT_KEYS,
  REQUIRED_ROOT_KEYS,
  TITLE_MAX_LENGTH,
  validBlockEntry,
  validBlockField,
} from "./page-shape.mjs";
import {
  addsTreeError,
  spanTreeErrors,
  textlessLeaf,
  validateMarkerValue,
  validateRichSpans,
} from "./richtext-spans.mjs";
import { FEATURE_ID, documentFeatures } from "./schema-features.mjs";

export const INVALID_PAGE_CONTENT = "invalid_page_content";

/** The rule a refused batch broke. Logged as a code; never content. */
export const PAGE_CONTENT_RULES = Object.freeze([
  "root_key",
  "page_id",
  "title",
  "schema",
  "block_entry",
  "block_key",
  "mark",
  "marker",
  "block_size",
  "structure",
]);

const MESSAGES = {
  root_key: "This edit writes a Page field Pages doesn't have",
  page_id: "This edit changes the Page's identity",
  title: "This edit stores a title Pages can't read",
  schema: "This edit changes the Page's schema stamp in a way Pages doesn't accept",
  block_entry: "This edit stores a block Pages can't read",
  block_key: "This edit writes a block field Pages doesn't have",
  mark: "This edit stores formatting Pages doesn't know",
  marker: "This edit stores a block marker Pages can't read",
  block_size: "This edit makes a block longer than Pages allows",
  structure: "This edit leaves a block Pages can't read",
};

class PageContentRejection extends Error {
  constructor(rule) {
    super(MESSAGES[rule]);
    this.code = INVALID_PAGE_CONTENT;
    this.rule = rule;
  }
}
const reject = (rule) => {
  throw new PageContentRejection(rule);
};

/** The longest text delete probed marker by marker; a longer one reads its
 * block whole. */
export const MARKER_PROBE_LIMIT = 64;

/** The batch between `live` and `preview`, as `{ before, after }` readers. */
const mergedFrame = (live, preview) => ({
  before: reader(A.getBackend(live), { doc: live, heads: A.getHeads(live) }, true),
  after: reader(A.getBackend(preview), { doc: preview, heads: A.getHeads(preview) }, true),
});

/** The batch as its writer made it: readers of `preview` at the batch's
 * base (the heads its changes depend on outside the batch) and at its tips.
 * Null when that base is `live`'s heads, so the merged frame is the same. */
function writerFrame(live, preview) {
  const liveHeads = A.getHeads(live);
  const meta = A.getChangesMetaSince(preview, liveHeads);
  const hashes = new Set(meta.map((change) => change.hash));
  const deps = new Set(meta.flatMap((change) => change.deps));
  const base = [...deps].filter((hash) => !hashes.has(hash)).sort();
  const tips = [...hashes].filter((hash) => !deps.has(hash)).sort();
  const sorted = [...liveHeads].sort();
  if (!meta.length || (base.length === sorted.length && base.every((h, i) => h === sorted[i])))
    return null;
  const backend = A.getBackend(preview);
  return {
    before: reader(backend, { doc: A.view(preview, base), heads: base }, false),
    after: reader(backend, { doc: A.view(preview, tips), heads: tips }, false),
  };
}

/** A marker read that couldn't name the marker's value. */
const UNKNOWN_MARKER = Object.freeze({ unknown: true });

/** Backend reads at one state's heads. `current` says the backend's own
 * state is at those heads. getBlock reads only a backend's own state, so a
 * marker in an older state is found through a cursor: the character's
 * position now, and the value there if it is still the same character. */
function reader(backend, state, current) {
  const objectAt = (keys) => {
    let id = "_root";
    for (const key of keys) {
      const entry = backend.getWithType(id, key, state.heads);
      if (!entry || !["map", "list", "text"].includes(entry[0])) return null;
      id = entry[1];
    }
    return id;
  };
  const entry = (keys) => {
    const parent = objectAt(keys.slice(0, -1));
    return parent ? (backend.getWithType(parent, keys.at(-1), state.heads) ?? null) : null;
  };
  const texts = new Map();
  const textAt = (obj, index) => {
    if (!texts.has(obj)) texts.set(obj, backend.text(obj, state.heads));
    return texts.get(obj)[index];
  };
  return {
    ...state,
    objectAt,
    kind: (keys) => entry(keys)?.[0] ?? null,
    length(keys) {
      const found = entry(keys);
      if (!found) return null;
      if (found[0] === "text") return backend.length(found[1], state.heads);
      if (found[0] === "str") return String(found[1]).length;
      return null;
    },
    text: (keys) => {
      const found = entry(keys);
      return found?.[0] === "text" ? found[1] : null;
    },
    /** The marker at `index` of text object `obj`: its value, null for a
     * character, or UNKNOWN_MARKER for a marker whose value can't be read
     * here (a concurrent change has since deleted it). */
    marker(obj, index) {
      if (current) return backend.getBlock(obj, index) ?? null;
      let cursor;
      try {
        cursor = backend.getCursor(obj, index, state.heads);
      } catch {
        return UNKNOWN_MARKER;
      }
      const now = backend.getCursorPosition(obj, cursor);
      if (backend.getCursor(obj, now) === cursor) return backend.getBlock(obj, now) ?? null;
      return textAt(obj, index) === "\uFFFC" ? UNKNOWN_MARKER : null;
    },
    marksAt: (obj, index) => backend.marksAt(obj, index, state.heads) ?? {},
    textLength: (obj) => backend.length(obj, state.heads),
    all: (keys) => {
      const parent = objectAt(keys.slice(0, -1));
      return parent ? backend.getAll(parent, keys.at(-1), state.heads) : [];
    },
    readText: (obj) => backend.text(obj, state.heads),
  };
}

function checkMark(name, value) {
  if (value === null || value === undefined) return true;
  try {
    markSpec(name);
    validateMarkValue(name, value);
    return true;
  } catch {
    return false;
  }
}

/** Per-block record of what a batch's rich-text patches did, in the
 * coordinates of each patch as it applies. */
function textTracker() {
  return {
    // Marker indexes the batch inserted or changed.
    touched: new Set(),
    // Edits so far, newest last, to map a position back to the base text.
    edits: [],
    // Inserted text: where it starts now, and its base position.
    inserts: [],
    // Unknown or invalid marks inserted text carries, at a base position.
    inherited: [],
    markerChanged: false,
    grew: false,
  };
}

/** Map a position in the text after `edits` back to the base text.
 * Positions inside text the batch inserted clamp to its start. */
function toBase(edits, position) {
  let p = position;
  for (let i = edits.length - 1; i >= 0; i--) {
    const { at, inserted, deleted } = edits[i];
    if (inserted) {
      if (p >= at + inserted) p -= inserted;
      else if (p > at) p = at;
    } else if (p >= at) p += deleted;
  }
  return p;
}

/** Shift tracked marker indexes past an edit; deleted ones go. */
function shift(touched, at, by) {
  const next = new Set();
  for (const index of touched) {
    if (index < at) next.add(index);
    else if (by < 0 && index < at - by) continue;
    else next.add(index + by);
  }
  return next;
}

/** Shift tracked insertion starts past an edit; a deleted one clamps to the
 * delete, where any of its text that survives now starts. */
function shiftInserts(inserts, at, by) {
  for (const insert of inserts)
    if (insert.start >= at)
      insert.start = by < 0 && insert.start < at - by ? at : insert.start + by;
}

/** One rich-text patch at `index` (or the text itself when undefined).
 * `probe(i)` says whether the base holds a marker at base index `i`, or
 * returns null when it can't tell. */
function trackText(tracker, patch, index, nested, probe) {
  if (patch.action === "mark" && !nested) {
    for (const mark of patch.marks ?? []) if (!checkMark(mark.name, mark.value)) reject("mark");
    return;
  }
  if (index === undefined) {
    // `richText` isn't a text object here: only a whole read can judge it.
    tracker.markerChanged = true;
    return;
  }
  if (nested) {
    tracker.touched.add(index);
    tracker.markerChanged = true;
    return;
  }
  if (patch.action === "splice") {
    const length = String(patch.value ?? "").length;
    const base = toBase(tracker.edits, index);
    tracker.touched = shift(tracker.touched, index, length);
    shiftInserts(tracker.inserts, index, length);
    tracker.inserts.push({ start: index, base });
    tracker.edits.push({ at: index, inserted: length });
    tracker.grew = true;
    for (const [name, value] of Object.entries(patch.marks ?? {}))
      if (!checkMark(name, value)) tracker.inherited.push({ name, value, base });
  } else if (patch.action === "insert") {
    const length = patch.values?.length ?? 0;
    tracker.touched = shift(tracker.touched, index, length);
    shiftInserts(tracker.inserts, index, length);
    for (let i = 0; i < length; i++) tracker.touched.add(index + i);
    tracker.edits.push({ at: index, inserted: length });
    tracker.markerChanged = true;
    tracker.grew = true;
  } else if (patch.action === "del") {
    const length = patch.length ?? 1;
    tracker.touched = shift(tracker.touched, index, -length);
    shiftInserts(tracker.inserts, index, -length);
    if (!tracker.markerChanged) {
      // A deleted marker joins nodes; deleted text never moves one.
      const from = toBase(tracker.edits, index),
        to = toBase(tracker.edits, index + length);
      if (to - from > MARKER_PROBE_LIMIT) tracker.markerChanged = true;
      else
        for (let i = from; i < to; i++) {
          const found = probe(i);
          if (found !== false) {
            tracker.markerChanged = true;
            break;
          }
        }
    }
    tracker.edits.push({ at: index, deleted: length });
  } else {
    tracker.markerChanged = true;
  }
}

const treeErrors = (doc, path) => spanTreeErrors(A.spans(doc, path));

function checkBlockText(frame, id, tracker, stats) {
  const keys = ["blocks", id, "richText"];
  const { before, after } = frame;
  const baseText = before.kind(keys) === "text" ? before.text(keys) : null;
  const afterText = after.text(keys);
  if (tracker.inherited.length) {
    // Text inserted beside a run takes that run's marks. A mark the text
    // beside the insertion point already held is the base's, not this
    // batch's.
    for (const { name, value, base } of tracker.inherited) {
      const beside = [];
      if (baseText !== null) {
        const length = before.textLength(baseText);
        if (base > 0) beside.push(before.marksAt(baseText, base - 1));
        if (base < length) beside.push(before.marksAt(baseText, base));
      }
      if (!beside.some((marks) => Object.hasOwn(marks, name) && marks[name] === value))
        reject("mark");
    }
  }
  let unsure = false;
  if (afterText !== null && tracker.inserts.length) {
    const length = after.textLength(afterText);
    for (const { start, base } of tracker.inserts) {
      if (start === 0 || start >= length || after.marker(afterText, start)) continue;
      const leaf = after.marker(afterText, start - 1);
      if (!leaf) continue;
      if (leaf === UNKNOWN_MARKER) {
        unsure = true;
        continue;
      }
      if (!textlessLeaf(leaf)) continue;
      // Text a merge already left after the leaf takes more typing.
      if (baseText === null || base === 0 || base >= before.textLength(baseText))
        reject("structure");
      const here = before.marker(baseText, base),
        prior = before.marker(baseText, base - 1);
      if (here === UNKNOWN_MARKER || prior === UNKNOWN_MARKER) unsure = true;
      else if (here !== null || !prior || !textlessLeaf(prior)) reject("structure");
    }
  }
  let placed = true;
  for (const index of tracker.touched) {
    const value = afterText === null ? null : after.marker(afterText, index);
    if (!value || value === UNKNOWN_MARKER) {
      placed = false;
      continue;
    }
    try {
      validateMarkerValue(value);
    } catch {
      reject("marker");
    }
  }
  if (tracker.grew) {
    const grown = after.length(keys);
    const was = before.length(keys) ?? 0;
    if (grown !== null && grown > BLOCK_MAX_LENGTH && grown > was) reject("block_size");
  }
  if (tracker.markerChanged || !placed || unsure) {
    stats.fullReads++;
    const errors = treeErrors(after.doc, keys);
    if (errors === null) return;
    const baseErrors = baseText === null ? null : treeErrors(before.doc, keys);
    if (addsTreeError(baseErrors, errors)) reject("structure");
  }
}

function checkNewBlock(frame, id, stats) {
  const { after } = frame;
  const block = after.doc.blocks?.[id];
  if (!validBlockEntry(id, block)) reject("block_entry");
  const keys = ["blocks", id, "richText"];
  if (after.kind(keys) !== "text") reject("block_entry");
  if (after.length(keys) > BLOCK_MAX_LENGTH) reject("block_size");
  stats.fullReads++;
  try {
    validateRichSpans(A.spans(after.doc, keys), Infinity);
  } catch {
    reject("structure");
  }
}

function checkTitle({ before, after }) {
  const kind = after.kind(["title"]);
  if (kind !== "text" && kind !== "str") reject("title");
  const grown = after.length(["title"]);
  if (grown > TITLE_MAX_LENGTH && grown > (before.length(["title"]) ?? 0)) reject("title");
}

function checkSchema({ before, after }) {
  const was = new Set(documentFeatures(before.doc));
  const now = documentFeatures(after.doc);
  if ([...was].some((id) => !now.includes(id))) reject("schema");
  // A newer build may stamp an id this build doesn't know; the schema gate
  // then holds the Page read-only for builds without it.
  for (const id of now) if (!was.has(id) && !FEATURE_ID.test(id)) reject("schema");
}

/** A conflicting value as the block field rules read it. Rich text and the
 * Markdown source are only type-checked; other text is read (it is short). */
function fieldValue(after, key, [type, value]) {
  if (type === "text") return key === "richText" || key === "markdown" ? "" : after.readText(value);
  if (type === "map") return {};
  if (type === "list") return [];
  if (type === "str") return new A.ImmutableString(value);
  return value;
}

/** Every value a put key holds at the batch's tips. */
function checkConflicts(frame, path) {
  const { before, after } = frame;
  const values = after.all(path);
  if (values.length < 2) return;
  const [root] = path;
  if (path.length === 1) {
    if (root === "title") {
      for (const [type, value] of values)
        if (type === "str" ? String(value).length > TITLE_MAX_LENGTH : type !== "text")
          reject("title");
    } else if (root === "page_id") {
      for (const [type, value] of values)
        if (type !== "str" || (before.doc.page_id !== undefined && value !== before.doc.page_id))
          reject("page_id");
    } else reject("root_key");
  } else if (path.length === 2) reject("block_entry");
  else if (path.length === 3) {
    const [, id, key] = path;
    if (key === "richText" || key === "metadata") reject("block_entry");
    for (const value of values)
      if (!validBlockField(key, fieldValue(after, key, value), id)) reject("block_entry");
  }
}

/** Rules a concurrent batch may break only by meeting another writer's
 * edits: re-judged at the writer's own base. */
const MERGE_RULES = new Set(["structure", "block_size", "title"]);

function check(live, preview, stats) {
  try {
    judge(mergedFrame(live, preview), preview, stats);
  } catch (error) {
    if (!(error instanceof PageContentRejection) || !MERGE_RULES.has(error.rule)) throw error;
    const writer = writerFrame(live, preview);
    if (!writer) throw error;
    // Reads at older heads cost about as much as reading the document
    // whole, so only these refusals come here.
    stats.writerView = true;
    judge(writer, preview, stats);
  }
  return stats;
}

function judge(frame, preview, stats) {
  const { before, after } = frame;
  const patches = A.diff(preview, before.heads, after.heads);
  stats.patches = patches.length;
  let title = false,
    schema = false,
    replacedBlocks = false;
  const newBlocks = new Set(),
    fields = new Map(),
    texts = new Map(),
    puts = [];
  const probe = (id) => {
    const baseText = before.text(["blocks", id, "richText"]);
    return (index) => (baseText === null ? null : before.marker(baseText, index) !== null);
  };
  for (const patch of patches) {
    const path = patch.path;
    if (!Array.isArray(path) || !path.length) reject("root_key");
    const [root] = path;
    const deletes = patch.action === "del";
    if (!PAGE_ROOT_KEYS.includes(root)) {
      // Removing a key Pages doesn't have is cleanup.
      if (path.length === 1 && deletes) continue;
      reject("root_key");
    }
    if (path.length === 1 && deletes && REQUIRED_ROOT_KEYS.includes(root)) reject("root_key");
    if (path.length <= 3 && patch.action === "put") puts.push(path);
    if (root === "page_id") {
      if (typeof after.doc.page_id !== "string") reject("page_id");
      if (before.doc.page_id !== undefined && before.doc.page_id !== after.doc.page_id)
        reject("page_id");
      continue;
    }
    if (root === "title") {
      title = true;
      continue;
    }
    if (root === "schema") {
      schema = true;
      continue;
    }
    // blocks
    if (path.length === 1) {
      replacedBlocks = true;
      continue;
    }
    const id = path[1];
    if (replacedBlocks || newBlocks.has(id)) continue;
    if (path.length === 2) {
      if (patch.action === "put") newBlocks.add(id);
      else if (deletes) {
        fields.delete(id);
        texts.delete(id);
      } else reject("block_entry");
      continue;
    }
    const key = path[2];
    if (!BLOCK_KEYS.includes(key)) {
      if (path.length === 3 && deletes) continue;
      reject("block_key");
    }
    if (key === "richText") {
      if (path.length === 3 && patch.action !== "mark") {
        // The text object itself was replaced or removed.
        if (patch.action === "put") newBlocks.add(id);
        else reject("block_entry");
        continue;
      }
      if (!texts.has(id)) texts.set(id, textTracker());
      const index = typeof path[3] === "number" ? path[3] : undefined;
      trackText(texts.get(id), patch, index, path.length > 4, probe(id));
      continue;
    }
    if (!fields.has(id)) fields.set(id, new Set());
    fields.get(id).add(key);
  }
  const blocks = after.doc.blocks;
  if (replacedBlocks) {
    if (!blocks || typeof blocks !== "object" || Array.isArray(blocks)) reject("block_entry");
    for (const id of Object.keys(blocks)) checkNewBlock(frame, id, stats);
  } else {
    for (const id of newBlocks)
      if (Object.hasOwn(blocks ?? {}, id)) checkNewBlock(frame, id, stats);
    for (const [id, keys] of fields) {
      if (newBlocks.has(id) || !Object.hasOwn(blocks ?? {}, id)) continue;
      const block = blocks[id];
      for (const key of keys) if (!validBlockField(key, block[key], id)) reject("block_entry");
    }
    for (const [id, tracker] of texts) {
      if (newBlocks.has(id) || !Object.hasOwn(blocks ?? {}, id)) continue;
      checkBlockText(frame, id, tracker, stats);
    }
  }
  for (const path of puts) checkConflicts(frame, path);
  if (title) checkTitle(frame);
  if (schema) checkSchema(frame);
}

/**
 * Judge the changes between `live` and `preview` (see the module comment).
 * Returns `{ ok: true, stats }` or `{ ok: false, reason: { code, rule,
 * message }, stats }`. `stats.fullReads` counts blocks read whole. Neither document
 * is modified.
 */
export function admitPageChanges(live, preview) {
  const stats = { patches: 0, fullReads: 0 };
  try {
    return { ok: true, stats: check(live, preview, stats) };
  } catch (error) {
    if (!(error instanceof PageContentRejection)) throw error;
    return {
      ok: false,
      reason: { code: error.code, rule: error.rule, message: error.message },
      stats,
    };
  }
}

/** admitPageChanges for a host writer, before its edit is journaled: a 400
 * with code `invalid_page_content` when the edit is refused. */
export function requirePageContent(before, after) {
  const result = admitPageChanges(before, after);
  if (result.ok) return result;
  throw Object.assign(Error(result.reason.message), {
    status: 400,
    code: INVALID_PAGE_CONTENT,
    rule: result.reason.rule,
  });
}
