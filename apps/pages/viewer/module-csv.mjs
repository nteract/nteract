// The CSV converter normalized-bytes.mjs loads the first time a Page reads a
// CSV, and only then. It parses with @nteract/sift-csv's
// WASM, served as a hashed viewer asset.
import { setWasmUrl } from "@nteract/sift-csv";
import { SIFT_CSV_WASM_URL } from "pages-sift-csv-assets";
import { csvArrow } from "./csv-arrow.mjs";

setWasmUrl(SIFT_CSV_WASM_URL);

export { csvArrow };
