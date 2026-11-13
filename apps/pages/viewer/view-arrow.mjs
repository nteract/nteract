// A chart's decoder for a Parquet source: one Arrow table, columnar, in
// JavaScript memory. The chart renderer (vega-chart.mjs datasetRows) turns an
// Arrow table into the row objects Vega reads in one pass, so this is the only
// copy before that one. Nothing stays in Sift's WASM store, so the table has
// nothing to dispose.
import { parquetToArrowStream } from "@nteract/sift";
import { tableFromIPC } from "apache-arrow";

/** Decode Parquet `bytes` within `limits` (sift-dataset.mjs DATAFRAME_LIMITS)
 * into an Arrow table. */
export async function decodeArrow(bytes, { maxBytes, maxRows, maxColumns, maxDecodedBytes } = {}) {
  const ipc = await parquetToArrowStream(bytes, { maxBytes, maxRows, maxColumns, maxDecodedBytes });
  return tableFromIPC(ipc);
}
