import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// viewer/sift-table.jsx imports `pages-sift-assets` for two build-time values:
// Sift's compiled stylesheet as text, and the URL of its WASM. The table chunk
// loads only when a Page shows a `sift` block, and adds the stylesheet then as
// a <style> element. app.css never carries Sift's rules, and the build's
// chunk-CSS check never sees them. Every Sift rule is keyed on .sift-root.
export const SIFT_ASSETS_MODULE = "pages-sift-assets";
export const SIFT_WASM_URL = "/sift.wasm";

/** The published Sift WASM, copied by scripts/build.mjs as a hashed asset. */
export const siftWasmPath = (app) =>
  createRequire(path.join(app, "package.json")).resolve("@nteract/sift/sift.wasm");

export function browserSiftPlugin(app, wasmUrl = SIFT_WASM_URL) {
  const require = createRequire(path.join(app, "package.json"));
  return {
    name: "pages-sift-assets",
    setup(b) {
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
