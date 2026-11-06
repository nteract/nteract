// Page-body admission: whether a batch of Automerge changes to a Page
// document writes only content every Pages reader and writer accepts.
//
// `admitPageChanges(live, preview)` judges what the batch *changes*, not the
// whole document. `live` is the admitted document; `preview` is `live` with
// the batch applied. The patches between their heads (A.diff) name every
// path the batch writes, and each write is checked against the rule for that
// path:
//
//   root key        one of PAGE_ROOT_KEYS (model/page-shape.mjs). page_id
//                   never changes; page_id, title and blocks are never
//                   deleted; the schema stamp never loses an id and gains
//                   only well-formed ones (FEATURE_ID).
//   title           text or a string, at most TITLE_MAX_LENGTH, or no longer
//                   than it was.
//   block entry     a new entry passes validBlockEntry and its rich text the
//                   full validateRichSpans check; a written field passes its
//                   BLOCK_FIELDS rule; no other key.
//   mark            a mark patch carries name and value: a known mark with a
//                   registry value (validateMarkValue), or null (removal).
//                   Text typed under a mark carries the mark in its splice
//                   patch; a mark the block already held is not new.
//   block marker    each inserted or changed marker, read on its own at its
//                   final index (A.block), passes validateMarkerValue.
//   block size      a block whose native length grows ends at most
//                   BLOCK_MAX_LENGTH (backend length, not spans).
//
// A batch that inserts, changes or deletes a block marker can change where
// the block's nodes sit, which no patch shows. That block, and only that
// block, is read whole: validateRichSpans on its spans after the batch. If
// that fails, the block as admitted is checked too, and the batch is
// refused only when it made a readable block unreadable. A whole block is
// also read for a new block, a replaced text object, a `richText` that isn't
// a text object, or a marker the patch path couldn't place. Plain typing,
// deleting text, formatting and title edits never read a whole block.
//
// Content stored before this check stays: a write is judged by what it
// writes, so an edit to a block with legacy content is refused only when the
// edit itself is invalid.
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
import { validateMarkerValue, validateRichSpans } from "./richtext-spans.mjs";
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

const MARKER = "\uFFFC";

/** The backend object id and type at a path of map keys, or null. */
function objectAt(backend, keys) {
  let id = "_root";
  for (const key of keys) {
    const entry = backend.getWithType(id, key);
    if (!entry || !["map", "list", "text"].includes(entry[0])) return null;
    id = entry[1];
  }
  return id;
}

function textLength(doc, keys) {
  const backend = A.getBackend(doc);
  const parent = objectAt(backend, keys.slice(0, -1));
  const entry = parent && backend.getWithType(parent, keys.at(-1));
  if (!entry) return null;
  if (entry[0] === "text") return backend.length(entry[1]);
  if (entry[0] === "str") return String(entry[1]).length;
  return null;
}

const textKind = (doc, keys) => {
  const backend = A.getBackend(doc);
  const parent = objectAt(backend, keys.slice(0, -1));
  return parent ? (backend.getWithType(parent, keys.at(-1))?.[0] ?? null) : null;
};

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
    touched: new Set(),
    // Edits so far, newest last, to map a position back to the admitted text.
    edits: [],
    inherited: [],
    markerChanged: false,
    grew: false,
  };
}

/** Map a position in the text after `edits` back to the admitted text.
 * Positions inside text the batch inserted clamp to its start. */
function toLive(edits, position) {
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

function shift(touched, at, by) {
  const next = new Set();
  for (const index of touched) {
    if (index < at) next.add(index);
    else if (by < 0 && index < at - by) continue;
    else next.add(index + by);
  }
  return next;
}

/** One rich-text patch at `index` (or the text itself when undefined). */
function trackText(tracker, patch, index, nested, liveText) {
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
    tracker.touched = shift(tracker.touched, index, length);
    tracker.edits.push({ at: index, inserted: length });
    tracker.grew = true;
    for (const [name, value] of Object.entries(patch.marks ?? {}))
      if (!checkMark(name, value)) tracker.inherited.push([name, value]);
  } else if (patch.action === "insert") {
    const length = patch.values?.length ?? 0;
    tracker.touched = shift(tracker.touched, index, length);
    for (let i = 0; i < length; i++) tracker.touched.add(index + i);
    tracker.edits.push({ at: index, inserted: length });
    tracker.markerChanged = true;
    tracker.grew = true;
  } else if (patch.action === "del") {
    const length = patch.length ?? 1;
    tracker.touched = shift(tracker.touched, index, -length);
    if (!tracker.markerChanged) {
      // A deleted marker joins nodes; deleted text never moves one.
      const text = liveText();
      const from = toLive(tracker.edits, index),
        to = toLive(tracker.edits, index + length);
      if (text === null || text.slice(from, Math.max(from, to)).includes(MARKER))
        tracker.markerChanged = true;
    }
    tracker.edits.push({ at: index, deleted: length });
  } else {
    tracker.markerChanged = true;
  }
}

function readable(doc, path) {
  try {
    validateRichSpans(A.spans(doc, path), Infinity);
    return true;
  } catch {
    return false;
  }
}

function sameValue(a, b) {
  return a === b || (a != null && b != null && String(a) === String(b));
}

function checkBlockText(live, preview, id, tracker, stats) {
  const path = ["blocks", id, "richText"];
  if (tracker.inherited.length) {
    // Text typed inside a run keeps that run's marks. A mark the admitted
    // block already holds is legacy content, not this batch's.
    let held = [];
    try {
      held = A.marks(live, path);
    } catch {
      held = [];
    }
    for (const [name, value] of tracker.inherited)
      if (!held.some((mark) => mark.name === name && sameValue(mark.value, value))) reject("mark");
  }
  let placed = true;
  for (const index of tracker.touched) {
    let value;
    try {
      value = A.block(preview, path, index);
    } catch {
      value = null;
    }
    if (!value) {
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
    const after = textLength(preview, path);
    const before = textLength(live, path) ?? 0;
    if (after !== null && after > BLOCK_MAX_LENGTH && after > before) reject("block_size");
  }
  if (tracker.markerChanged || !placed) {
    stats.fullReads++;
    if (!readable(preview, path) && (textKind(live, path) !== "text" || readable(live, path)))
      reject("structure");
  }
}

function checkNewBlock(preview, id, stats) {
  const block = preview.blocks?.[id];
  if (!validBlockEntry(id, block)) reject("block_entry");
  const path = ["blocks", id, "richText"];
  if (textKind(preview, path) !== "text") reject("block_entry");
  if (textLength(preview, path) > BLOCK_MAX_LENGTH) reject("block_size");
  stats.fullReads++;
  try {
    validateRichSpans(A.spans(preview, path), Infinity);
  } catch {
    reject("structure");
  }
}

function checkTitle(live, preview) {
  const kind = textKind(preview, ["title"]);
  if (kind !== "text" && kind !== "str") reject("title");
  const after = textLength(preview, ["title"]);
  if (after > TITLE_MAX_LENGTH && after > (textLength(live, ["title"]) ?? 0)) reject("title");
}

function checkSchema(live, preview) {
  const before = new Set(documentFeatures(live));
  const after = documentFeatures(preview);
  if ([...before].some((id) => !after.includes(id))) reject("schema");
  // A newer build may stamp an id this build doesn't know; the schema gate
  // then holds the Page read-only for builds without it.
  for (const id of after) if (!before.has(id) && !FEATURE_ID.test(id)) reject("schema");
}

function check(live, preview) {
  const stats = { patches: 0, fullReads: 0 };
  const liveHeads = A.getHeads(live);
  const patches = A.diff(preview, liveHeads, A.getHeads(preview));
  stats.patches = patches.length;
  let title = false,
    schema = false,
    replacedBlocks = false;
  const newBlocks = new Set(),
    fields = new Map(),
    texts = new Map(),
    liveTexts = new Map();
  const liveText = (id) => () => {
    if (!liveTexts.has(id)) {
      const value = live.blocks?.[id]?.richText;
      liveTexts.set(id, typeof value === "string" ? value : null);
    }
    return liveTexts.get(id);
  };
  for (const patch of patches) {
    const path = patch.path;
    if (!Array.isArray(path) || !path.length) reject("root_key");
    const [root] = path;
    if (!PAGE_ROOT_KEYS.includes(root)) reject("root_key");
    if (path.length === 1 && patch.action === "del" && REQUIRED_ROOT_KEYS.includes(root))
      reject("root_key");
    if (root === "page_id") {
      if (typeof preview.page_id !== "string") reject("page_id");
      if (live.page_id !== undefined && live.page_id !== preview.page_id) reject("page_id");
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
      else if (patch.action === "del") {
        fields.delete(id);
        texts.delete(id);
      } else reject("block_entry");
      continue;
    }
    const key = path[2];
    if (!BLOCK_KEYS.includes(key)) reject("block_key");
    if (key === "richText") {
      if (path.length === 3 && patch.action !== "mark") {
        // The text object itself was replaced or removed.
        if (patch.action === "put") newBlocks.add(id);
        else reject("block_entry");
        continue;
      }
      if (!texts.has(id)) texts.set(id, textTracker());
      const index = typeof path[3] === "number" ? path[3] : undefined;
      trackText(texts.get(id), patch, index, path.length > 4, liveText(id));
      continue;
    }
    if (!fields.has(id)) fields.set(id, new Set());
    fields.get(id).add(key);
  }
  if (replacedBlocks) {
    const blocks = preview.blocks;
    if (!blocks || typeof blocks !== "object" || Array.isArray(blocks)) reject("block_entry");
    for (const id of Object.keys(blocks)) checkNewBlock(preview, id, stats);
  } else {
    for (const id of newBlocks)
      if (Object.hasOwn(preview.blocks ?? {}, id)) checkNewBlock(preview, id, stats);
    for (const [id, keys] of fields) {
      if (newBlocks.has(id) || !Object.hasOwn(preview.blocks ?? {}, id)) continue;
      const block = preview.blocks[id];
      for (const key of keys) if (!validBlockField(key, block[key], id)) reject("block_entry");
    }
    for (const [id, tracker] of texts) {
      if (newBlocks.has(id) || !Object.hasOwn(preview.blocks ?? {}, id)) continue;
      checkBlockText(live, preview, id, tracker, stats);
    }
  }
  if (title) checkTitle(live, preview);
  if (schema) checkSchema(live, preview);
  return stats;
}

/**
 * Judge the changes between `live` and `preview` (see the module comment).
 * Returns `{ ok: true, stats }` or `{ ok: false, reason: { code, rule,
 * message } }`. `stats.fullReads` counts blocks read whole. Neither document
 * is modified.
 */
export function admitPageChanges(live, preview) {
  try {
    return { ok: true, stats: check(live, preview) };
  } catch (error) {
    if (!(error instanceof PageContentRejection)) throw error;
    return {
      ok: false,
      reason: { code: error.code, rule: error.rule, message: error.message },
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
