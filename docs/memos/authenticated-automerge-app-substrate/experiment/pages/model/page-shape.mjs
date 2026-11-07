// The Page document's stored shape, outside its rich text: the root keys, a
// block entry's fields, and the size bounds every writer keeps. Registration
// (worker/registration.mjs) checks a draft's bootstrap against these rules,
// and admission (model/page-admission.mjs) checks what each later change
// writes. Rich text itself is checked by validateRichSpans and
// validateMarkerValue (model/richtext-spans.mjs).
import * as A from "@automerge/automerge/slim";
import { generateKeyBetween } from "fractional-indexing";
import { RICH_FORMAT } from "./richtext-format.mjs";

/** Root keys a Page document holds. `schema` is the feature stamp
 * (model/schema-features.mjs); the others are required. */
export const PAGE_ROOT_KEYS = Object.freeze(["page_id", "title", "blocks", "schema"]);
export const REQUIRED_ROOT_KEYS = Object.freeze(["page_id", "title", "blocks"]);

/** The longest title a writer stores, in UTF-16 units. The browser's title
 * input stops at 500 (viewer/title-selection.mjs); host writers cut at this. */
export const TITLE_MAX_LENGTH = 1024;

/** The longest rich-text block a live edit may grow, in UTF-16 units of its
 * native text, each block marker counting one. A block over it keeps every
 * edit that doesn't lengthen it. Registration's tighter bound (262,144 bytes
 * of span JSON, validateRichSpans) implies this one. */
export const BLOCK_MAX_LENGTH = 262144;

export const validPageId = (id) =>
  typeof id === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
/** Block ids are writer-minted UUIDs, like Page ids. */
export const validBlockId = validPageId;

const isMap = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  !A.isRawString(value) &&
  !(value instanceof Date) &&
  !(value instanceof Uint8Array);

function validPosition(value) {
  if (!A.isRawString(value) || String(value).length > 512) return false;
  try {
    generateKeyBetween(String(value), null);
    return true;
  } catch {
    return false;
  }
}

/** Each block entry field and the values a writer stores in it. `id` is the
 * block's key in `blocks`. `markdown` is the empty source every rich block
 * keeps; `richText` holds the content. */
export const BLOCK_FIELDS = Object.freeze({
  id: (value, id) => value === id,
  position: validPosition,
  kind: (value) => value === "markdown",
  format: (value) => value === RICH_FORMAT,
  markdown: (value) => typeof value === "string",
  richText: (value) => typeof value === "string",
  metadata: isMap,
});
export const BLOCK_KEYS = Object.freeze(Object.keys(BLOCK_FIELDS));

/** Whether `value` is valid for block field `key` of block `id`. Unknown keys
 * are invalid. */
export const validBlockField = (key, value, id) =>
  Object.hasOwn(BLOCK_FIELDS, key) && BLOCK_FIELDS[key](value, id);

/** A whole block entry: a map with every field valid and no other key. */
export const validBlockEntry = (id, block) =>
  validBlockId(id) &&
  isMap(block) &&
  Object.keys(block).every((key) => Object.hasOwn(BLOCK_FIELDS, key)) &&
  BLOCK_KEYS.every((key) => validBlockField(key, block[key], id));
