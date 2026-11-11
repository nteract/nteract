// The renderer for a dataframe node with a chart attr (wordgard-dataframes.mjs).
// It binds Sift's decoder to source-chart.mjs, which draws the chart.
import { loadTableFile, setWasmUrl } from "@nteract/sift";
import { SIFT_WASM_URL } from "pages-sift-assets";
import { mountSourceChart } from "./source-chart.mjs";

setWasmUrl(SIFT_WASM_URL);

/** Mount the chart for a dataframe node's attrs. Returns `{ update, destroy }`. */
export const mount = (container, options) =>
  mountSourceChart(container, { ...options, loadTableFile });
