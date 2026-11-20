// The limits of a Page's named sources, shared by the sources document
// (model/sources-doc.mjs) and the tool schemas (mcp.mjs).
import { JSON_MEDIA_TYPE, OUTPUT_ASSET_TYPES } from "./anywidget-view.mjs";

/** The source media types set_source takes as inline `text`: the text types
 * among a source's types, the ones an agent writes by hand. Parquet, images,
 * audio and binary files go through an upload. */
export const INLINE_SOURCE_MEDIA_TYPES = Object.freeze(
  OUTPUT_ASSET_TYPES.filter((type) => type.startsWith("text/") || type === JSON_MEDIA_TYPE),
);
/** The most UTF-8 bytes one set_source `text` holds: 256 KiB, the length the
 * edit_page schema already allows a text argument. A module entry is
 * typically 6 to 35 KB. Larger files take an upload. */
export const INLINE_SOURCE_MAX_BYTES = 256 * 1024;
/** The most bytes one edit_page batch's inline text takes as JSON, all its
 * set_source texts together, quotes and escapes included as JSON.stringify
 * writes them (model/sources-doc.mjs inlineTextJsonBytes). The Page host
 * reads at most 1 MiB of JSON for one tool call (worker/auth.mjs readJson),
 * so a batch of source operations within this cap fits the request the
 * gateway forwards. The cap counts inline text only: a request that also
 * carries other large operations can pass the limit, and source operations
 * batch only with each other. A client that escapes more, such as every
 * non-ASCII character, can still send a request over the gateway's own 1 MiB
 * limit first. */
export const INLINE_SOURCE_BATCH_MAX_BYTES = 512 * 1024;

/** The most sources a Page holds. */
export const MAX_SOURCES = 64;
/** Active and retired IDs together, bounding the source map's projection work. */
export const MAX_SOURCE_IDS = 1024;
/** The longest source name, in UTF-16 code units. */
export const MAX_SOURCE_NAME = 200;
/** A source id: what an agent names a source by. */
export const SOURCE_ID_PATTERN = "^[a-z][a-z0-9_-]{0,63}$";
/** A source revision: decimal, minted by the host from "1". */
export const SOURCE_REVISION_PATTERN = "^[1-9][0-9]{0,15}$";

const SOURCE_ID = new RegExp(SOURCE_ID_PATTERN);
const REVISION = new RegExp(SOURCE_REVISION_PATTERN);
export const validSourceId = (id) =>
  typeof id === "string" &&
  SOURCE_ID.test(id) &&
  !["constructor", "prototype", "__proto__"].includes(id);
export const validSourceName = (name) =>
  typeof name === "string" && !!name.trim() && name.trim().length <= MAX_SOURCE_NAME;
// eslint-disable-next-line no-control-regex
export const sourceNameHasControl = (name) => /[\u0000-\u001f\u007f]/.test(name);
/** The same reference for tables and views; no resolved asset is stored. */
export function bindingOf(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !validSourceId(value.source_id)
  )
    return undefined;
  if (Object.keys(value).some((key) => key !== "source_id" && key !== "revision")) return undefined;
  if (value.revision === undefined) return { source_id: value.source_id };
  return typeof value.revision === "string" &&
    REVISION.test(value.revision) &&
    Number.isSafeInteger(Number(value.revision))
    ? { source_id: value.source_id, revision: value.revision }
    : undefined;
}
