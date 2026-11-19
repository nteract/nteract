import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// viewer/sift-table.jsx imports `pages-sift-assets` for two build-time values:
// Sift's compiled stylesheet as text, and the URL of its WASM. The table chunk
// loads only when a Page shows a Parquet dataframe, and adds the stylesheet then as
// a <style> element. app.css never carries Sift's rules, and the build's
// chunk-CSS check never sees them. Every Sift rule is keyed on .sift-root.
// viewer/module-csv.mjs imports `pages-sift-csv-assets` for the URL of
// @nteract/sift-csv's WASM alone, so the CSV chunk carries no stylesheet.
export const SIFT_ASSETS_MODULE = "pages-sift-assets";
export const SIFT_CSV_ASSETS_MODULE = "pages-sift-csv-assets";
export const SIFT_WASM_URL = "/sift.wasm";
export const SIFT_CSV_WASM_URL = "/sift-csv.wasm";

/** The published Sift WASM, copied by scripts/build.mjs as a hashed asset. */
export const siftWasmPath = (app) =>
  createRequire(path.join(app, "package.json")).resolve("@nteract/sift/sift.wasm");

/** The published Sift CSV WASM, copied the same way. */
export const siftCsvWasmPath = (app) =>
  createRequire(path.join(app, "package.json")).resolve("@nteract/sift-csv/wasm");

export function browserSiftPlugin(app, wasmUrl = SIFT_WASM_URL, csvWasmUrl = SIFT_CSV_WASM_URL) {
  const require = createRequire(path.join(app, "package.json"));
  return {
    name: "pages-sift-assets",
    setup(b) {
      // @nteract/sift-csv reads its WASM with node:fs/promises only under
      // Node, for a file: URL. The viewer always sets an https URL first, so
      // the browser build gets a stub that is never called.
      b.onResolve({ filter: /^node:fs\/promises$/ }, (args) =>
        /[\\/]@nteract[\\/]sift-csv[\\/]/.test(args.importer)
          ? { path: "node-fs-promises", namespace: "sift-assets" }
          : undefined,
      );
      b.onLoad({ filter: /^node-fs-promises$/, namespace: "sift-assets" }, () => ({
        contents:
          'export async function readFile() { throw Error("The CSV parser reads its WASM by URL in a browser."); }',
        loader: "js",
      }));
      b.onResolve({ filter: /^pages-sift-csv-assets$/ }, () => ({
        path: SIFT_CSV_ASSETS_MODULE,
        namespace: "sift-assets",
      }));
      b.onLoad({ filter: /^pages-sift-csv-assets$/, namespace: "sift-assets" }, () => ({
        contents: `export const SIFT_CSV_WASM_URL = ${JSON.stringify(csvWasmUrl)};`,
        loader: "js",
      }));
      b.onResolve({ filter: /^pages-sift-assets$/ }, () => ({
        path: SIFT_ASSETS_MODULE,
        namespace: "sift-assets",
      }));
      b.onLoad({ filter: /.*/, namespace: "sift-assets" }, () => ({
        contents: [
          `export const SIFT_CSS = ${JSON.stringify(
            readFileSync(require.resolve("@nteract/sift/style.css"), "utf8"),
          )};`,
          `export const SIFT_WASM_URL = ${JSON.stringify(wasmUrl)};`,
        ].join("\n"),
        loader: "js",
      }));
    },
  };
}
