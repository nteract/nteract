import { readFile } from "node:fs/promises";
import { initializeRuntimedWasm } from "../src/runtimed-wasm.ts";

const runtimedWasmBinaryUrl = new URL(
  "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm",
  import.meta.url,
);

let initialized: Promise<void> | undefined;

export function initializeTestRuntimedWasm(): Promise<void> {
  initialized ??= readTestRuntimedWasmBytes()
    .then((wasmBytes) => initializeRuntimedWasm(wasmBytes))
    .catch((error: unknown) => {
      initialized = undefined;
      throw error;
    });
  return initialized;
}

export function readTestRuntimedWasmBytes(): Promise<Uint8Array> {
  return readFile(runtimedWasmBinaryUrl);
}
