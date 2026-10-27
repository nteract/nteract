import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setMarkdownProjectionProjector } from "@/lib/markdown-projection";
import initRuntimedWasm, {
  project_markdown_json,
} from "../../apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm.js";

let runtimedWasmReady: Promise<void> | undefined;

export function initializeRuntimedWasm(): Promise<void> {
  runtimedWasmReady ??= Promise.resolve()
    .then(async () => {
      const wasmBytes = readFileSync(runtimedWasmBinaryPath());
      await initRuntimedWasm({
        module_or_path: wasmBytes.buffer.slice(
          wasmBytes.byteOffset,
          wasmBytes.byteOffset + wasmBytes.byteLength,
        ),
      });
    })
    .catch((error: unknown) => {
      runtimedWasmReady = undefined;
      throw error;
    });
  return runtimedWasmReady;
}

export async function initializeMarkdownProjectionWasm(): Promise<void> {
  await initializeRuntimedWasm();
  setMarkdownProjectionProjector(project_markdown_json);
}

function runtimedWasmBinaryPath(): string {
  return join(process.cwd(), "apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm");
}
