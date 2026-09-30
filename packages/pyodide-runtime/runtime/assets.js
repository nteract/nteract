import { libraries } from "preview-python:packages";
// Adapted from the celld Python Workers experiment's compiled-Wasm bootstrap.
// These bindings are lexical to the bundle; never replace host globals.
import interpreter from "./pyodide.asm.wasm";
import sentinel from "./sentinel.wasm";
import sentinelBytes from "preview-python:sentinel";
import stdlib from "pyodide/python_stdlib.zip";
const wasmResponses = new WeakSet();
export function importScripts() {
  throw new Error("Dynamic script loading is disabled");
}
export class WorkerGlobalScope {}
export const self = Object.create(globalThis);
Object.defineProperty(self, "location", { value: { href: "https://python-runtime.invalid/" } });
export async function fetch(input) {
  if (String(input) === "https://python-runtime.invalid/python_stdlib.zip") {
    return new Response(stdlib);
  }
  if (String(input) === "https://python-runtime.invalid/pyodide.asm.wasm") {
    const response = new Response(null);
    wasmResponses.add(response);
    return response;
  }
  throw new Error("Python runtime asset is not bundled");
}
export const WebAssembly = Object.create(globalThis.WebAssembly);
WebAssembly.compile = async (input) => {
  const bytes = ArrayBuffer.isView(input)
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input);
  if (
    bytes.length === sentinelBytes.length &&
    bytes.every((byte, i) => byte === sentinelBytes[i])
  ) {
    return sentinel;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  for (const entry of libraries) {
    if (hash === entry.sha256) return entry.module;
  }
  throw new globalThis.WebAssembly.CompileError("Unbundled Python Wasm module");
};
WebAssembly.instantiate = async (input, imports) => {
  if (input instanceof globalThis.WebAssembly.Module) {
    return globalThis.WebAssembly.instantiate(input, imports);
  }
  const module = await WebAssembly.compile(input);
  return { module, instance: await globalThis.WebAssembly.instantiate(module, imports) };
};
WebAssembly.instantiateStreaming = async (pending, imports) => {
  const response = await pending;
  if (wasmResponses.has(response)) {
    return {
      module: interpreter,
      instance: await globalThis.WebAssembly.instantiate(interpreter, imports),
    };
  }
  return WebAssembly.instantiate(await response.arrayBuffer(), imports);
};
