// What a Page's Parquet dataset holds, read from its footer: row count, and
// each column's type, null count and bounds. Sift's WASM decodes the footer
// (`parquet_footer_summary`); no data page is read.
//
// An asset id names the SHA-256 of immutable bytes, so its summary never
// changes. The asset is normative; the summary is derived from it and kept
// beside it in the Page's bucket, under the asset prefix that permanent
// deletion clears (image-assets.mjs `deleteUploadedAssets`). Deleting the
// object costs one recomputation. A change to what is stored changes
// SUMMARY_FORMAT, which names the object, so older objects are never read.

import { imageAssetKey } from "./image-assets.mjs";

export const SUMMARY_FORMAT = 1;
/** The first read of a dataset's end. Most footers fit in it. */
export const TAIL_BYTES = 64 * 1024;
/** A longer footer is not summarized. */
export const MAX_FOOTER_BYTES = 1024 * 1024;
/** Columns an agent summary lists; the rest are counted. */
export const MAX_SUMMARY_COLUMNS = 200;
/** A text bound longer than this is left out rather than cut. */
export const MAX_TEXT_BOUND = 200;
/** Summaries a Page host keeps in memory. A Page holds up to 64 sources. */
const MEMORY_ENTRIES = 64;
const FOOTER_TRAILER = 8;

export const datasetSummaryKey = (pageId, assetId) =>
  `${imageAssetKey(pageId, assetId)}/footer-summary.v${SUMMARY_FORMAT}.json`;

/** The stored dataset's end, enough to hold its footer: one ranged read, and
 * a second when the footer is longer than the first. Null when the dataset
 * isn't stored. Throws `FooterUnreadable` for a footer too long to read. */
export async function readParquetTail(bucket, key, footerLength) {
  const head = await bucket.head(key);
  if (!head) return null;
  const size = head.size;
  const first = Math.min(size, TAIL_BYTES);
  let tail = await rangeBytes(bucket, key, size - first, first);
  const needed = footerLength(tail.subarray(-FOOTER_TRAILER)) + FOOTER_TRAILER;
  if (needed > MAX_FOOTER_BYTES + FOOTER_TRAILER)
    throw new FooterUnreadable(`The footer is ${needed} bytes, over ${MAX_FOOTER_BYTES}`);
  if (needed > tail.length) {
    if (needed > size) throw new FooterUnreadable("The footer is longer than the file");
    tail = await rangeBytes(bucket, key, size - needed, needed);
  }
  return { tail, size };
}

async function rangeBytes(bucket, key, offset, length) {
  const object = await bucket.get(key, { range: { offset, length } });
  if (!object) throw Error("Dataset changed while its footer was read");
  return new Uint8Array(await object.arrayBuffer());
}

/** A footer Sift refused, or one too long to read. Its bytes never change,
 * so the refusal is stored like a summary. */
export class FooterUnreadable extends Error {}

/**
 * The agent's view of Sift's summary: `{ rows, row_groups, created_by,
 * columns }`, each column `{ name, type, nullable, null_count, min, max,
 * bounds_exact }`. `type` is the Arrow type the file reads as. `min` and
 * `max` bound the whole file or are null: Sift reports per-file bounds only
 * when every row group's statistics are usable. Dates are `YYYY-MM-DD` and
 * timestamps ISO 8601 in UTC; Sift reports both in epoch milliseconds.
 * `bounds_exact` is false when a writer truncated a text bound. Past
 * MAX_SUMMARY_COLUMNS columns the list stops and `columns_truncated` is true.
 */
export function agentSummary(sift) {
  const columns = sift.columns.slice(0, MAX_SUMMARY_COLUMNS).map((column) => {
    const bounded = column.bounded_row_groups === sift.num_row_groups;
    const bound = (value) => (bounded ? boundValue(value, column.data_type) : null);
    return {
      name: column.name,
      type: column.data_type,
      nullable: column.nullable,
      null_count: column.null_count,
      min: bound(column.min),
      max: bound(column.max),
      bounds_exact: bounded && column.bounds_exact,
    };
  });
  return {
    rows: sift.num_rows,
    row_groups: sift.num_row_groups,
    created_by: sift.created_by,
    columns,
    ...(sift.columns.length > MAX_SUMMARY_COLUMNS && { columns_truncated: true }),
  };
}

function boundValue(value, type) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length <= MAX_TEXT_BOUND ? value : null;
  if (typeof value !== "number") return value;
  // ±Infinity has no JSON number.
  if (!Number.isFinite(value)) return Number.isNaN(value) ? null : String(value);
  if (/^Date(32|64)$/.test(type)) return new Date(value).toISOString().slice(0, 10);
  if (type.startsWith("Timestamp(")) return new Date(value).toISOString();
  return value;
}

/**
 * One Page host's dataset summaries: memory, then the stored summary, then
 * Sift over the dataset's footer, storing what it finds. `sift` loads the
 * `#sift-wasm` module; tests pass their own. `summary(assetId)` resolves to
 * the agent summary, or null when the dataset is missing or its footer is
 * unreadable. Bucket and Sift failures reject.
 */
export class DatasetSummaries {
  #bucket;
  #pageId;
  #sift;
  #memory = new Map();

  constructor({ bucket, pageId, sift = () => import("#sift-wasm") }) {
    this.#bucket = bucket;
    this.#pageId = pageId;
    this.#sift = sift;
  }

  async summary(assetId) {
    const stored = await this.#stored(assetId);
    return stored?.summary ? agentSummary(stored.summary) : null;
  }

  async #stored(assetId) {
    if (this.#memory.has(assetId)) return this.#memory.get(assetId);
    const key = datasetSummaryKey(this.#pageId, assetId);
    const cached = await this.#bucket.get(key);
    const stored = cached ? JSON.parse(await cached.text()) : await this.#compute(assetId, key);
    if (stored === null) return null;
    this.#memory.set(assetId, stored);
    if (this.#memory.size > MEMORY_ENTRIES) this.#memory.delete(this.#memory.keys().next().value);
    return stored;
  }

  /** `{ summary }` or `{ unreadable }`, stored; null for a missing dataset. */
  async #compute(assetId, key) {
    const sift = await this.#sift();
    let stored;
    try {
      const read = await readParquetTail(
        this.#bucket,
        imageAssetKey(this.#pageId, assetId),
        sift.parquet_footer_length,
      );
      if (!read) return null;
      stored = { summary: sift.parquet_footer_summary(read.tail, read.size) };
    } catch (error) {
      // Sift refuses a footer by throwing its message as a string.
      if (!(error instanceof FooterUnreadable) && typeof error !== "string") throw error;
      stored = { unreadable: String(error instanceof Error ? error.message : error) };
    }
    await this.#bucket.put(key, JSON.stringify(stored), {
      httpMetadata: { contentType: "application/json" },
    });
    return stored;
  }
}
