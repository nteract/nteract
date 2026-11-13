// Sift's WASM in the Worker, as `#sift-wasm` resolves under the workerd
// condition. The build bundles the binary as a compiled module beside
// index.js (scripts/worker-modules.mjs). Node resolves sift-wasm.node.mjs.
import siftModule from "@nteract/sift/sift.wasm";
import { initSync, parquet_footer_length, parquet_footer_summary } from "@nteract/sift/wasm";

initSync({ module: siftModule });

export { parquet_footer_length, parquet_footer_summary };
