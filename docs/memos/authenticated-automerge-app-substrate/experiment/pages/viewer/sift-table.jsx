// The renderer for Parquet dataframe nodes (wordgard-dataframes.mjs). Only a
// Page that shows one loads this module, so the table code, its stylesheet
// and its WASM stay out of the editor chunk. Sift decodes the Parquet in the
// browser; the Worker only stores and serves the bytes.
import { createRoot } from "react-dom/client";
import { SiftTable, loadTableFile, setWasmUrl } from "@nteract/sift";
import { SIFT_CSS, SIFT_WASM_URL } from "pages-sift-assets";
import { DATAFRAME_LIMITS, ensureSiftStyles, fetchDataset } from "./sift-dataset.mjs";

setWasmUrl(SIFT_WASM_URL);

/**
 * Mount a Sift table for the dataframe at `src` into `container`. `pageId` is
 * the Page being shown; a `src` on another Page is refused. Filters,
 * sorting and column changes stay local to this reader. Returns `{ destroy }`,
 * which cancels a pending download and unmounts the table.
 */
export function mount(container, { src, pageId }) {
  ensureSiftStyles(container.ownerDocument, SIFT_CSS);
  const controller = new AbortController();
  const source = {
    kind: "loader",
    load: async () =>
      loadTableFile(
        await fetchDataset(src, { pageId, signal: controller.signal }),
        DATAFRAME_LIMITS,
      ),
  };
  const root = createRoot(container);
  root.render(<SiftTable source={source} />);
  return {
    destroy() {
      controller.abort();
      root.unmount();
    },
  };
}
