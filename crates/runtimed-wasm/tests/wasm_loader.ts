// deno-lint-ignore-file no-explicit-any

const wasmJsPath = new URL(
  "../../../apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm.js",
  import.meta.url,
);
const wasmBinPath = new URL(
  "../../../apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm",
  import.meta.url,
);

let wasmModuleReady: Promise<any> | undefined;

export function loadRuntimedWasm(): Promise<any> {
  wasmModuleReady ??= (async () => {
    const mod = await import(wasmJsPath.href);
    const wasmBytes = await Deno.readFile(wasmBinPath);
    await mod.default({ module_or_path: wasmBytes });
    return mod;
  })().catch((error: unknown) => {
    wasmModuleReady = undefined;
    throw error;
  });
  return wasmModuleReady;
}
