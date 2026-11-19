// The table decoder a module view (anywidget-view.mjs) loads when it first
// calls parquet() or csv(), and only then. It decodes Parquet with Sift's
// WASM from the URL a chart uses, so a Page that shows both loads Sift once;
// a CSV reaches it as Arrow IPC and needs no Sift WASM.
import { setWasmUrl } from "@nteract/sift";
import { SIFT_WASM_URL } from "pages-sift-assets";
import { parquetColumns } from "./parquet-columns.mjs";

setWasmUrl(SIFT_WASM_URL);

export { parquetColumns };
