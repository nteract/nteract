// The chart chunk for view embeds (wordgard-views.mjs VIEW_RENDERER). Only a
// Page that shows a view loads it, so the SVG renderer and the Parquet
// decoder stay out of the editor chunk. Sift's WASM decodes each Parquet
// source here into Arrow IPC bytes; the host only stores and serves the
// Parquet. Vega and Vega-Lite run in the chart Worker (chart-worker.mjs), a
// script of its own that `warm` or the first chart starts; `warm` also
// loads Sift's WASM.
import { setWasmUrl } from "@nteract/sift";
import { SIFT_WASM_URL } from "pages-sift-assets";
import { checkChartSpec } from "../shared/chart-spec.mjs";
import { mount as mountChart, warmCharts } from "./vega-chart.mjs";
import { decodeArrow, warmDecoder } from "./view-arrow.mjs";
import { mountViewEmbed } from "./view-embed.mjs";

setWasmUrl(SIFT_WASM_URL);

/** Mount a view embed: `{ view$, sources, sourcesKnown$ }` as
 * view-embed.mjs takes them. Returns `{ destroy }`. */
export function mount(container, { view$, sources, sourcesKnown$ = null }) {
  return mountViewEmbed(container, {
    view$,
    sources,
    sourcesKnown$,
    decode: decodeArrow,
    checkChartSpec,
    mount: mountChart,
  });
}

/** Start `doc`'s chart Worker and Sift's Parquet decoder before a chart
 * needs them. Returns the function that lets the Worker go; the decoder,
 * once loaded, stays for the page. */
export function warm(doc) {
  void warmDecoder();
  return warmCharts(doc);
}
