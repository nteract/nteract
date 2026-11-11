// Datasets are Page assets beside images: the same private, hash-addressed
// store and the same /api/pages/:pageId/assets route. A Page shows one
// through a `dataframe` node, a block with no text whose attrs name the asset
// and its media type. The viewer picks a renderer by media type; Parquet
// renders as a Sift table.
import { checkChartSpec } from "./chart-spec.mjs";
import { imageAssetUrl, validAssetId } from "./image-assets.mjs";

export const PARQUET_MEDIA_TYPE = "application/vnd.apache.parquet";
export const DATASET_MAX_BYTES = 5 * 1024 * 1024;
export const DATASET_ACCEPT = `.parquet,${PARQUET_MEDIA_TYPE}`;

/** The block type of a dataframe node, in spans and features.json. */
export const DATAFRAME_BLOCK = "dataframe";
/** Media types a dataframe node can show. Each needs a viewer renderer. */
export const DATAFRAME_MEDIA_TYPES = Object.freeze([PARQUET_MEDIA_TYPE]);
export const DATAFRAME_TITLE_MAX = 200;

/** A Page source ID (model/page-sources.mjs): lowercase, starting with a
 * letter, at most 64 characters. */
export const validSourceId = (id) =>
  typeof id === "string" &&
  /^[a-z][a-z0-9_-]{0,63}$/.test(id) &&
  !["constructor", "prototype", "__proto__"].includes(id);

const PAGE_ID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ASSET_PATH = new RegExp(`^/api/pages/(${PAGE_ID})/assets/([a-f0-9]{64})$`);

/** `{ pageId, assetId }` for a same-origin Page asset path, otherwise null. */
export function parseAssetPath(src) {
  const match = typeof src === "string" ? ASSET_PATH.exec(src) : null;
  return match && validAssetId(match[2]) ? { pageId: match[1], assetId: match[2] } : null;
}

/** True for a File the person means as a Parquet dataset. Browsers rarely
 * know the media type, so the extension decides when the type is generic. */
export function isParquetFile(file) {
  if (!file) return false;
  const type = String(file.type ?? "").toLowerCase();
  if (type === PARQUET_MEDIA_TYPE) return true;
  return (
    ["", "application/octet-stream", "application/x-parquet"].includes(type) &&
    /\.parquet$/i.test(String(file.name ?? ""))
  );
}

/**
 * The stored attrs of a dataframe node, checked: `src` is a same-origin Page
 * asset path, `media_type` one this build renders, `title` a trimmed string
 * or null. Throws on anything else, including unknown keys, so a node can't
 * carry state no reader understands.
 */
export function dataframeAttrs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid dataframe node");
  const extra = Object.keys(value).filter(
    (key) => !["src", "media_type", "title", "chart", "source"].includes(key),
  );
  if (extra.length) throw Error(`Unknown dataframe attributes: ${extra.join(", ")}`);
  if (!parseAssetPath(value.src)) throw Error("A dataframe's src must be a Page asset path");
  if (!DATAFRAME_MEDIA_TYPES.includes(value.media_type))
    throw Error(`A dataframe's media_type must be one of ${DATAFRAME_MEDIA_TYPES.join(", ")}`);
  if (value.title != null && typeof value.title !== "string")
    throw Error("A dataframe's title must be a string");
  // A title is one line: runs of whitespace (newlines included) collapse to
  // a space, and other control characters are refused.
  const title = value.title?.replace(/\s+/g, " ").trim() || null;
  // eslint-disable-next-line no-control-regex
  if (title && /[\u0000-\u001f\u007f]/.test(title))
    throw Error("A dataframe's title can't hold control characters");
  if (title && title.length > DATAFRAME_TITLE_MAX)
    throw Error(`A dataframe's title must be ${DATAFRAME_TITLE_MAX} characters or fewer`);
  const chart = value.chart == null ? null : chartAttr(value.chart);
  const source = value.source == null ? null : sourceAttr(value.source, chart);
  return {
    src: value.src,
    media_type: value.media_type,
    title,
    ...(chart && { chart }),
    ...(source && { source }),
  };
}

/**
 * A dataframe's `source` attr: the Page source ID the node follows. Local
 * evaluation only (the dataframe-source feature). `src` stays the asset the
 * source held when the node was written, so a reader without sources still
 * draws a real version. On a chart, every data name is a source ID and
 * `source` is one of them.
 */
export function sourceAttr(value, chart = null) {
  if (!validSourceId(value)) throw Error("A dataframe's source must be a Page source ID");
  if (chart && !checkChartSpec(JSON.parse(chart)).sources.includes(value))
    throw Error("A chart's source must be one of its data names");
  return value;
}

/**
 * A dataframe's `chart` attr, checked and normalized: a Vega-Lite spec as a
 * JSON string. Local evaluation only (the dataframe-chart feature); a chart
 * is meant to become its own document. Throws with the spec's problems.
 */
export function chartAttr(value) {
  if (typeof value !== "string") throw Error("A dataframe's chart must be a JSON string");
  let spec;
  try {
    spec = JSON.parse(value);
  } catch {
    throw Error("A dataframe's chart must be valid JSON");
  }
  const { problems } = checkChartSpec(spec);
  if (problems.length) throw Error(`A dataframe's chart can't be drawn: ${problems.join(" ")}`);
  return JSON.stringify(spec);
}

/**
 * Read a stored dataframe's attrs leniently, for decode and host validation.
 * A later build may add a media type or attrs under the same feature, so only
 * what this build relies on is checked: `src` is a same-origin Page asset
 * path, `media_type` a string and `title` a string or absent. Returns
 * `{ src, media_type, title, chart?, source? }` or null. Callers keep the raw attrs to write
 * them back unchanged; renderers report a media type they can't draw.
 */
export function readDataframe(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { src, media_type } = value;
  if (!parseAssetPath(src) || typeof media_type !== "string" || !media_type) return null;
  if (value.title != null && typeof value.title !== "string") return null;
  const title = value.title?.trim() || null;
  return {
    src,
    media_type,
    title,
    ...(typeof value.chart === "string" && { chart: value.chart }),
    ...(validSourceId(value.source) && { source: value.source }),
  };
}

/** Node attrs for an asset on `pageId`. */
export const dataframeFor = (
  pageId,
  { asset_id, media_type = PARQUET_MEDIA_TYPE, title = null, chart = null, source = null },
) => dataframeAttrs({ src: imageAssetUrl(pageId, asset_id), media_type, title, chart, source });

/** A file name without its extension, as a default title. */
export const titleFromFile = (file) =>
  String(file?.name ?? "")
    .replace(/\.[^.]+$/, "")
    .trim()
    .slice(0, DATAFRAME_TITLE_MAX) || null;
