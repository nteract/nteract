import {
  DATASET_MAX_BYTES,
  PARQUET_MEDIA_TYPE,
  parseAssetPath,
} from "../shared/dataset-assets.mjs";

/**
 * Sift's decode limits for a Page dataset (sift-table.jsx). maxBytes is the
 * upload cap; the row, column and memory caps bound what a small, highly
 * compressed file can expand to in the reader's tab. Sift calls these a
 * loading guardrail, not a sandbox.
 */
export const DATAFRAME_LIMITS = Object.freeze({
  maxBytes: DATASET_MAX_BYTES,
  maxRows: 250_000,
  maxColumns: 256,
  // Sift's default, so a table that loads today keeps loading.
  maxDecodedBytes: 128 * 1024 * 1024,
});

/**
 * The bytes of a Page's Parquet dataset, read with the reader's own session.
 * Throws a message for people: a reader without access, a removed asset, an
 * asset on another Page or one that isn't a dataset each say so instead of
 * failing in the decoder.
 */
export async function fetchDataset(src, { pageId, signal, request = fetch } = {}) {
  const path = parseAssetPath(src);
  if (!path) throw Error("Table source needs a src that is a Page asset path.");
  // A dataframe only shows this Page's datasets. A src naming another Page
  // (written by an older or modified client) is refused before any request.
  if (path.pageId !== pageId) throw Error("This dataset belongs to another Page.");
  const response = await request(src, { credentials: "same-origin", signal });
  if (response.status === 401 || response.status === 403)
    throw Error("You don't have access to this dataset.");
  if (response.status === 404) throw Error("This dataset isn't stored on this Page.");
  if (!response.ok) throw Error(`Couldn't load the dataset (${response.status}).`);
  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== PARQUET_MEDIA_TYPE) throw Error("This asset isn't a Parquet dataset.");
  return new Uint8Array(await response.arrayBuffer());
}

/** Add Sift's stylesheet to `document` once. */
export function ensureSiftStyles(document, css) {
  if (document.querySelector("style[data-pages-sift]")) return;
  const style = document.createElement("style");
  style.setAttribute("data-pages-sift", "");
  style.textContent = css;
  document.head.append(style);
}
