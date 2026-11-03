// The Sift table behind a `sift` block. wordgard-widgets.mjs imports this
// module only when a Page shows one, so the table code, its stylesheet and
// its WASM stay out of the editor chunk. Sift decodes the Parquet in the
// browser; the Worker only stores and serves the bytes.
import { createRoot } from "react-dom/client";
import { SiftTable, loadTableFile, setWasmUrl } from "@nteract/sift";
import { SIFT_CSS, SIFT_WASM_URL } from "pages-sift-assets";
import { ensureSiftStyles, fetchDataset } from "./sift-dataset.mjs";

setWasmUrl(SIFT_WASM_URL);

/**
 * Mount a read-only Sift table for the dataset at `src` into `container`.
 * Filters, sorting and column changes stay local to this reader. Returns
 * `{ destroy }`, which cancels a pending download and unmounts the table.
 */
export function mountSiftTable(container, { src, onError } = {}) {
  // `onError` is optional; Sift also shows load failures inside the table.
  ensureSiftStyles(container.ownerDocument, SIFT_CSS);
  const controller = new AbortController();
  const source = {
    kind: "loader",
    load: async () => loadTableFile(await fetchDataset(src, { signal: controller.signal })),
  };
  const root = createRoot(container);
  root.render(<SiftTable source={source} onLoadError={onError} />);
  return {
    destroy() {
      controller.abort();
      root.unmount();
    },
  };
}
