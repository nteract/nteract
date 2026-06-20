import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const runtimedWasmModuleUrl = new URL(
  "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js",
  import.meta.url,
);
export const runtimedWasmBinaryUrl = new URL(
  "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm",
  import.meta.url,
);

let initializedModule;

export async function assertRuntimedWasmBuildExists() {
  try {
    await access(fileURLToPath(runtimedWasmModuleUrl));
    await access(fileURLToPath(runtimedWasmBinaryUrl));
  } catch {
    throw new Error(
      "Missing apps/notebook/src/wasm/runtimed-wasm output. Run `cargo xtask wasm runtimed --skip-renderer-plugins` first.",
    );
  }
}

export async function initializeRuntimedWasmForNode() {
  initializedModule ??= (async () => {
    await assertRuntimedWasmBuildExists();
    const wasm = await import(runtimedWasmModuleUrl.href);
    await wasm.default({ module_or_path: await readFile(runtimedWasmBinaryUrl) });
    return wasm;
  })().catch((error) => {
    initializedModule = undefined;
    throw error;
  });
  return initializedModule;
}

export async function initializeRuntimedWasmSyncForNode() {
  initializedModule ??= (async () => {
    await assertRuntimedWasmBuildExists();
    const wasm = await import(runtimedWasmModuleUrl.href);
    wasm.initSync({ module: await readFile(runtimedWasmBinaryUrl) });
    return wasm;
  })().catch((error) => {
    initializedModule = undefined;
    throw error;
  });
  return initializedModule;
}
