// The Parquet decoder a module view (anywidget-view.mjs) loads when it binds
// a Parquet file, and only then. It decodes with Sift's WASM from the URL a
// chart uses, so a Page that shows both loads Sift once.
import { setWasmUrl } from "@nteract/sift";
import { SIFT_WASM_URL } from "pages-sift-assets";
import { parquetColumns } from "./parquet-columns.mjs";

setWasmUrl(SIFT_WASM_URL);

export { parquetColumns };
