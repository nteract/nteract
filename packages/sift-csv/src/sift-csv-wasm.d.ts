// wasm-pack's glue, resolved from crates/sift-csv-wasm/pkg in development and
// shipped as lib/wasm/sift_csv_wasm.js. The runtime shape is typed in index.ts.
declare module "sift-csv-wasm/sift_csv_wasm.js" {
  const init: (options?: unknown) => Promise<unknown>;
  export default init;
  export function csvToArrowIpc(bytes: Uint8Array, options: unknown): Uint8Array;
}
