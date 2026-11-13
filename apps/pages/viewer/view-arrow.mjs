// A view embed's decoder for a Parquet source: Sift's WASM turns the Parquet
// bytes into one Arrow IPC stream, in this page. The chart sends a copy of
// those bytes to its Worker, which reads them through chart-arrow.mjs
// `chartTable`, so each value converts to what a chart reads there. The bytes
// may back several views on a Page; a chart never transfers or changes them.
// Nothing stays in Sift's WASM store, so the bytes have nothing to dispose.
import { parquetToArrowStream } from "@nteract/sift";

/** Decode Parquet `bytes` within `limits` (sift-dataset.mjs DATAFRAME_LIMITS)
 * into Arrow IPC bytes, the dataset a chart reads. */
export async function decodeArrow(bytes, { maxBytes, maxRows, maxColumns, maxDecodedBytes } = {}) {
  return parquetToArrowStream(bytes, { maxBytes, maxRows, maxColumns, maxDecodedBytes });
}

// A Parquet file with one TINYINT column and no rows, written by DuckDB.
const EMPTY_PARQUET =
  "UEFSMRUCGSw1ABgNZHVja2RiX3NjaGVtYRUCABUCJQIYAXglHgAWABkMKChEdWNrREIgdmVyc2lvbiB2MS40LjMgKGJ1aWxkIGQxZGM4OGY5NTApAFEAAABQQVIx";
let warming = null;

/** Load and instantiate Sift's WASM before the first source arrives, by
 * decoding an empty Parquet file through the same call a chart makes. Once
 * per page; a failure is ignored, and the first real decode loads it again
 * and reports its own. */
export function warmDecoder(decode = parquetToArrowStream) {
  warming ??= Promise.resolve()
    .then(() => decode(Uint8Array.from(atob(EMPTY_PARQUET), (c) => c.charCodeAt(0))))
    .catch(() => {
      warming = null;
    });
  return warming;
}
