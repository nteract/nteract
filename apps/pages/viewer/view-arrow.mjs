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
