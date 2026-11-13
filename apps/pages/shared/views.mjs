// A Page's views: charts stored each in its own `pages.view` document
// (model/view-doc.mjs), placed in the Page body by a `view` node. These are
// the limits and names the host, the model, the tool schemas (mcp.mjs) and
// the viewer share.

/** The most views a Page holds. */
export const MAX_VIEWS = 10;
/** A view id: what an agent and the Page body name a view by. */
export const VIEW_ID_PATTERN = "^[a-z][a-z0-9_-]{0,63}$";
/** The longest view title, in UTF-16 code units. */
export const MAX_VIEW_TITLE = 200;
/** The media types a view's spec may be. */
export const VIEW_MEDIA_TYPES = Object.freeze(["application/vnd.vegalite.v6+json"]);
/** A view revision: decimal, minted by the host from "1". */
export const VIEW_REVISION_PATTERN = "^[1-9][0-9]{0,15}$";
/** A data name: a key of a view's `data` map and the name its spec reads. */
export const VIEW_DATA_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_-]{0,63}$";
/** The most data names one view binds. */
export const MAX_VIEW_DATA = 32;
/** The block type of a view node, in spans and features.json. */
export const VIEW_BLOCK = "view";
/** A DOM figure holding a view node carries this attribute, and its view id
 * in VIEW_ID_ATTR. */
export const VIEW_ATTR = "data-pages-view";
export const VIEW_ID_ATTR = "data-view-id";

const VIEW_ID = new RegExp(VIEW_ID_PATTERN);
const RESERVED = new Set(["constructor", "prototype", "__proto__"]);

/** The reserved names a view id could otherwise take, for a refusal; the
 * rest fail the pattern. */
export const RESERVED_VIEW_IDS = [...RESERVED].filter((id) => VIEW_ID.test(id)).join(" or ");

/** Whether `id` is a well-formed view id. */
export const validViewId = (id) => typeof id === "string" && VIEW_ID.test(id) && !RESERVED.has(id);

const DATA_NAME = new RegExp(VIEW_DATA_NAME_PATTERN);
/** The reserved names a data name could otherwise take, for a refusal. */
export const RESERVED_DATA_NAMES = [...RESERVED]
  .filter((name) => DATA_NAME.test(name))
  .join(" or ");

/** Whether `name` is a data name a view may bind: a safe object key. */
export const validDataName = (name) =>
  typeof name === "string" && DATA_NAME.test(name) && !RESERVED.has(name);

/** A view node's Markdown line: `[View: <view_id>]`, bracketed text and no
 * link, as an unknown node's notice reads. A view has no address of its own. */
export const viewLine = (viewId) => `[View: ${viewId}]`;

/**
 * A stored view node's attrs, read leniently for decode and host
 * validation: `{ view_id }` when `view_id` is a well-formed view id, else
 * null. A later build may add attrs under the same feature; callers keep
 * the raw attrs to write them back unchanged.
 */
export function readViewNode(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return validViewId(value.view_id) ? { view_id: value.view_id } : null;
}
