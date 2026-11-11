// Heading anchors: the readable fragment (`#getting-lean-automerge`) that
// names a heading on a Page. Anchors are computed from the document whenever
// it is read; nothing stores them, so every Page has them without a schema
// feature or a migration, and a renamed heading gets a new anchor.
//
// The browser (to scroll to a heading and copy its link) and read_page's
// outline (so agents can write `[text](#anchor)`) both read
// pageHeadingAnchors, so the two can't disagree about which heading an
// anchor names. A heading's text here is its visible text: characters, image
// alt text and line breaks as spaces, like the outline's `heading` field.
import { markerType } from "./node-registry.mjs";
import * as A from "@automerge/automerge/slim";
import { orderedBlockIds } from "./order.mjs";

/** The longest slug, in code points, before de-duplication suffixes. */
export const ANCHOR_SLUG_MAX = 100;

/** The anchor a heading with no letters or digits gets, before suffixes. */
export const EMPTY_HEADING_ANCHOR = "section";

/**
 * GitHub-style slug of a heading's visible text: lowercase, punctuation and
 * symbols dropped, each run of whitespace one hyphen. Letters and digits of
 * every script stay, so "Café ✨ 東京" is `café-東京`. The result may be
 * empty; createAnchorSlugger gives such a heading a name.
 */
export function headingSlug(text) {
  const words = String(text ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\s-]/gu, "")
    .trim()
    .replace(/\s+/gu, "-");
  const points = [...words];
  if (points.length <= ANCHOR_SLUG_MAX) return words;
  return points.slice(0, ANCHOR_SLUG_MAX).join("").replace(/-+$/u, "");
}

/**
 * A function that names headings in document order: the first heading with a
 * slug gets it bare, later ones get `-1`, `-2`, … the way GitHub numbers
 * repeated headings. A suffix never collides with another heading's bare
 * slug (a heading literally titled "Notes 1" after two "Notes" gets
 * `notes-1-1`).
 */
export function createAnchorSlugger() {
  const counts = new Map();
  return (text) => {
    const base = headingSlug(text) || EMPTY_HEADING_ANCHOR;
    let anchor = base;
    while (counts.has(anchor)) {
      const next = counts.get(base) + 1;
      counts.set(base, next);
      anchor = `${base}-${next}`;
    }
    counts.set(anchor, 0);
    return anchor;
  };
}

/** The headings in one block's rich spans, in order, as `{ level, text }`.
 * Every heading marker counts, including one nested in a quote or list
 * item, so ordinals match the headings the editor draws. */
export function headingsInSpans(spans) {
  const headings = [];
  let current = null;
  for (const span of spans ?? []) {
    if (span?.type === "text") {
      if (current) current.text += String(span.value ?? "");
      continue;
    }
    if (span?.type !== "block") continue;
    const value = span.value ?? {};
    if (value.isEmbed) {
      if (!current) continue;
      if (value.type === "hard-break") current.text += " ";
      else if (value.type === "image") current.text += String(value.attrs?.alt ?? "");
      continue;
    }
    current = null;
    if (markerType(value) === "heading") {
      current = { level: Number(value.attrs?.level) || 1, text: "" };
      headings.push(current);
    }
  }
  return headings;
}

const anchorsByDoc = new WeakMap();

/**
 * Every heading on the Page in document order, as `{ blockId, index, level,
 * text, anchor }`. `index` is the heading's ordinal among its block's
 * headings. A block in a stored form this build doesn't read adds none.
 * Cached per document version.
 */
export function pageHeadingAnchors(doc) {
  if (!doc?.blocks) return [];
  const cached = anchorsByDoc.get(doc);
  if (cached) return cached;
  const name = createAnchorSlugger();
  const anchors = [];
  for (const blockId of orderedBlockIds(doc)) {
    const block = doc.blocks[blockId];
    headingsInSpans(A.spans(block, ["richText"])).forEach(({ level, text }, index) =>
      anchors.push({ blockId, index, level, text, anchor: name(text) }),
    );
  }
  const frozen = Object.freeze(anchors.map((entry) => Object.freeze(entry)));
  try {
    anchorsByDoc.set(doc, frozen);
  } catch {
    // A document that can't be a WeakMap key is read uncached.
  }
  return frozen;
}

/** The anchors grouped by block: blockId → [anchor, …] in block order. */
export function headingAnchorsByBlock(doc) {
  const byBlock = new Map();
  for (const entry of pageHeadingAnchors(doc)) {
    if (!byBlock.has(entry.blockId)) byBlock.set(entry.blockId, []);
    byBlock.get(entry.blockId).push(entry.anchor);
  }
  return byBlock;
}
