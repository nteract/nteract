import { copyFile, mkdir } from "node:fs/promises";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const siftWasmUrl = new URL("../../../crates/sift-wasm/pkg/sift_wasm_bg.wasm", import.meta.url);
const outputUrl = new URL("../dist/plugins/sift_wasm.wasm", import.meta.url);

await assertExists(siftWasmUrl);
await mkdir(new URL("../dist/plugins/", import.meta.url), { recursive: true });
await copyFile(siftWasmUrl, outputUrl);

console.log(`copied ${fileURLToPath(siftWasmUrl)} -> ${fileURLToPath(outputUrl)}`);

async function assertExists(url) {
  try {
    await access(fileURLToPath(url));
  } catch {
    throw new Error(
      "Missing crates/sift-wasm/pkg/sift_wasm_bg.wasm. Run `cargo xtask renderer-plugins` first.",
    );
  }
}
