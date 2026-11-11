// The renderer for a dataframe node with a chart attr (wordgard-dataframes.mjs,
// the local dataframe-chart feature). Its one source is the node's own
// dataset: every named data in the spec resolves to it. A named-source catalog
// replaces this resolver; vega-chart.mjs takes any resolver.
import { loadTableFile, setWasmUrl } from "@nteract/sift";
import { SIFT_WASM_URL } from "pages-sift-assets";
import { parseAssetPath } from "../shared/dataset-assets.mjs";
import { DATAFRAME_LIMITS, fetchDataset } from "./sift-dataset.mjs";
import { mount as mountChart } from "./vega-chart.mjs";

setWasmUrl(SIFT_WASM_URL);

/** Mount the chart for `chart` (a Vega-Lite JSON string) over the dataset at
 * `src` on `pageId`. Returns `{ destroy }`. */
export function mount(container, { src, pageId, chart, onReport }) {
  let spec;
  try {
    spec = JSON.parse(chart);
  } catch {
    spec = null;
  }
  const asset_id = parseAssetPath(src)?.assetId ?? null;
  // This resolver owns its one table: decoded once, kept for redraws, freed
  // when the chart unmounts.
  const controller = new AbortController();
  let table = null;
  const resolveSource = async (_name, { signal } = {}) => {
    table ??= fetchDataset(src, { pageId, signal: controller.signal }).then((bytes) =>
      loadTableFile(bytes, DATAFRAME_LIMITS),
    );
    table.catch(() => (table = null));
    signal?.throwIfAborted();
    return { table: await table, asset_id };
  };
  const mounted = mountChart(container, { spec, resolveSource, onReport });
  return {
    ...mounted,
    destroy() {
      mounted.destroy();
      controller.abort();
      table?.then(
        (loaded) => loaded.dispose?.(),
        () => {},
      );
      table = null;
    },
  };
}
