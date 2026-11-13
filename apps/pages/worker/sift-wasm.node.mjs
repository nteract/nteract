// Sift's WASM under Node, for tests and scripts, as `#sift-wasm` resolves
// without the workerd condition. It compiles the same published binary the
// Worker bundles (sift-wasm.workerd.mjs).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initSync, parquet_footer_length, parquet_footer_summary } from "@nteract/sift/wasm";

const binary = readFileSync(fileURLToPath(import.meta.resolve("@nteract/sift/sift.wasm")));
initSync({ module: new WebAssembly.Module(binary) });

export { parquet_footer_length, parquet_footer_summary };
