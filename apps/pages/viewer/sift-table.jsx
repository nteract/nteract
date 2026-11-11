// The renderer for Parquet dataframe nodes (wordgard-dataframes.mjs). Only a
// Page that shows one loads this module, so the table code, its stylesheet
// and its WASM stay out of the editor chunk. Sift decodes the Parquet in the
// browser; the Worker only stores and serves the bytes.
import { createRoot } from "react-dom/client";
import { SiftTable, loadTableFile, setWasmUrl } from "@nteract/sift";
import { SIFT_CSS, SIFT_WASM_URL } from "pages-sift-assets";
import { DATAFRAME_LIMITS, ensureSiftStyles, fetchDataset } from "./sift-dataset.mjs";
import { markSourceVersions } from "./page-source-store.mjs";

setWasmUrl(SIFT_WASM_URL);

/**
 * Mount a Sift table for the dataframe at `src` into `container`. `pageId` is
 * the Page being shown; a `src` on another Page is refused. Filters,
 * sorting and column changes stay local to this reader. Returns `{ destroy }`,
 * which cancels a pending download and unmounts the table.
 *
 * With `source` and the Page's `sources` (page-source-store.mjs), the table
 * follows that source instead: each new version replaces the table, and the
 * container's `data-source-versions` says which version it drew. Without
 * `sources` (a card), it draws `src`, the version the node was written with.
 */
export function mount(container, { src, pageId, source, sources }) {
  ensureSiftStyles(container.ownerDocument, SIFT_CSS);
  const controller = new AbortController();
  const root = createRoot(container);
  if (!source || !sources) {
    const pinned = {
      kind: "loader",
      load: async () =>
        loadTableFile(
          await fetchDataset(src, { pageId, signal: controller.signal }),
          DATAFRAME_LIMITS,
        ),
    };
    root.render(<SiftTable source={pinned} />);
    return {
      destroy() {
        controller.abort();
        root.unmount();
      },
    };
  }
  const resolver = sources.resolver(loadTableFile);
  // The table owns what it decodes: Sift frees it on unmount, and frees a
  // table that lands after a newer version replaced its load.
  const followed = {
    kind: "loader",
    load: async () => {
      const resolved = await resolver.resolveSource(
        { source_id: source },
        { signal: controller.signal },
      );
      markSourceVersions(container, { [source]: resolved });
      return resolved.table;
    },
  };
  const subscription = sources.versions([source]).subscribe((versions) => {
    const version = versions[source];
    // A new key per version remounts Sift, which loads that version.
    const key = version ? `${version.asset_id}:${version.source_revision}` : "missing";
    root.render(<SiftTable key={key} source={{ ...followed }} />);
  });
  return {
    destroy() {
      subscription.unsubscribe();
      controller.abort();
      root.unmount();
    },
  };
}
