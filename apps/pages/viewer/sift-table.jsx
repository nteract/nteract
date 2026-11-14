// The renderer for Parquet dataframe nodes (wordgard-dataframes.mjs). Only a
// Page that shows one loads this module, so the table code, its stylesheet
// and its WASM stay out of the editor chunk. Sift decodes the Parquet in the
// browser; the Worker only stores and serves the bytes.
import { createRoot } from "react-dom/client";
import { SiftTable, loadTableFile, setWasmUrl } from "@nteract/sift";
import { SIFT_CSS, SIFT_WASM_URL } from "pages-sift-assets";
import { assetPath } from "./dataframe-binding.mjs";
import { DATAFRAME_LIMITS, ensureSiftStyles, fetchDataset } from "./sift-dataset.mjs";
import { followSource, markDrawnVersion } from "./source-follow.mjs";

setWasmUrl(SIFT_WASM_URL);

/** What a followed table says when the Page holds no such source. */
export const SOURCE_MISSING = "This table's source isn't on this Page.";

/**
 * Mount a Sift table for a dataframe into `container`. `pageId` is the Page
 * being shown; an asset on another Page is refused. Filters, sorting and
 * column changes stay local to this reader. Returns `{ destroy }`, which
 * cancels a pending download and unmounts the table.
 *
 * `binding` (dataframe-binding.mjs) says what the table draws: `{ asset_id }`
 * draws that asset (the node's own pin fetches its `src` unchanged), and `{ source_id }` with the Page's `sources` store
 * follows the source: each new version replaces the table, and the
 * container's `data-source-id`, `data-asset-id` and `data-source-revision`
 * say which version it drew. Without a usable binding it draws `src`.
 */
export function mount(container, { src, pageId, binding, sources }) {
  ensureSiftStyles(container.ownerDocument, SIFT_CSS);
  const root = createRoot(container);
  if (binding?.source_id && !sources) {
    root.render(
      <p className="wordgard-dataframe-missing">{`Source "${binding.source_id}" is unavailable.`}</p>,
    );
    return { destroy: () => root.unmount() };
  }
  if (binding?.source_id && sources) {
    container.dataset.sourceId = binding.source_id;
    const follow = followSource({
      binding,
      sources,
      loadTableFile,
      onDrawn: (version) => markDrawnVersion(container, version),
      render: (key, load) => {
        if (!load) {
          markDrawnVersion(container, null);
          root.render(
            <p className="wordgard-dataframe-missing">{`Source "${binding.source_id}"${binding.revision ? ` at revision ${binding.revision}` : ""} is unavailable.`}</p>,
          );
          return;
        }
        // Sift frees the table a load returns when this keyed table unmounts.
        root.render(<SiftTable key={key} source={{ kind: "loader", load }} />);
      },
    });
    return {
      destroy() {
        follow.destroy();
        root.unmount();
      },
    };
  }
  const controller = new AbortController();
  const asset = assetPath(src, pageId, binding);
  const source = {
    kind: "loader",
    load: async () =>
      loadTableFile(
        await fetchDataset(asset, { pageId, signal: controller.signal }),
        DATAFRAME_LIMITS,
      ),
  };
  root.render(<SiftTable source={source} />);
  return {
    destroy() {
      controller.abort();
      root.unmount();
    },
  };
}
