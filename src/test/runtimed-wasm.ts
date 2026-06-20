import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setMarkdownProjectionProjector } from "@/lib/markdown-projection";
import initRuntimedWasm, {
  project_markdown_json,
} from "../../apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm.js";

let markdownProjectionWasmReady: Promise<void> | undefined;

export function initializeMarkdownProjectionWasm(): Promise<void> {
  markdownProjectionWasmReady ??= Promise.resolve()
    .then(async () => {
      const wasmBytes = readFileSync(runtimedWasmBinaryPath());
      await initRuntimedWasm({
        module_or_path: wasmBytes.buffer.slice(
          wasmBytes.byteOffset,
          wasmBytes.byteOffset + wasmBytes.byteLength,
        ),
      });
      setMarkdownProjectionProjector(project_markdown_json);
    })
    .catch((error: unknown) => {
      markdownProjectionWasmReady = undefined;
      throw error;
    });
  return markdownProjectionWasmReady;
}

function runtimedWasmBinaryPath(): string {
  return join(process.cwd(), "apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm");
}
