// Parquet datasets are Page assets beside images: the same private,
// hash-addressed store and the same /api/pages/:pageId/assets route. A Page
// shows one through a fenced code block whose language is `sift`. The block's
// text is a JSON object naming the asset; the viewer renders it as a Sift
// table, and every other reader (Markdown export, older builds, agents) sees
// the fence as written.
import { validAssetId } from "./image-assets.mjs";

export const PARQUET_MEDIA_TYPE = "application/vnd.apache.parquet";
export const DATASET_MAX_BYTES = 5 * 1024 * 1024;
export const DATASET_ACCEPT = `.parquet,${PARQUET_MEDIA_TYPE}`;
export const SIFT_LANGUAGE = "sift";
export const SIFT_TITLE_MAX = 200;

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

/** The `sift` fence body for an asset: one line of JSON. */
export function siftSource({ src, title } = {}) {
  if (!parseAssetPath(src)) throw Error("A sift block needs a Page asset path");
  const value = { src };
  const name = typeof title === "string" ? title.trim().slice(0, SIFT_TITLE_MAX) : "";
  if (name) value.title = name;
  return JSON.stringify(value);
}

/**
 * Read a `sift` fence body. Returns `{ src, title }` or `{ error }` with a
 * message for people. Keys this build doesn't know are ignored, so a newer
 * build can add view state without breaking older readers.
 */
export function parseSiftSource(text) {
  const source = String(text ?? "").trim();
  if (!source) return { error: "Add a dataset to this table." };
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return { error: 'Table source must be JSON, like {"src": "/api/pages/…/assets/…"}.' };
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { error: "Table source must be a JSON object." };
  if (!parseAssetPath(value.src))
    return { error: "Table source needs a src that is a Page asset path." };
  const title =
    typeof value.title === "string" && value.title.trim()
      ? value.title.trim().slice(0, SIFT_TITLE_MAX)
      : null;
  return { src: value.src, title };
}
