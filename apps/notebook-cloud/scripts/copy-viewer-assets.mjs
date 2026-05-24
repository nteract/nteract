import { copyFile, mkdir } from "node:fs/promises";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const siftWasmUrl = new URL("../../../crates/sift-wasm/pkg/sift_wasm_bg.wasm", import.meta.url);
const outputUrl = new URL("../dist/plugins/sift_wasm.wasm", import.meta.url);
const runtimedWasmModuleUrl = new URL(
  "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js",
  import.meta.url,
);
const runtimedModuleOutputUrl = new URL("../dist/assets/runtimed_wasm.js", import.meta.url);
const runtimedModulePluginOutputUrl = new URL("../dist/plugins/runtimed_wasm.js", import.meta.url);
const runtimedWasmUrl = new URL(
  "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm",
  import.meta.url,
);
const runtimedOutputUrl = new URL("../dist/assets/runtimed_wasm_bg.wasm", import.meta.url);
const runtimedPluginOutputUrl = new URL("../dist/plugins/runtimed_wasm_bg.wasm", import.meta.url);

await assertExists(siftWasmUrl);
await assertExists(runtimedWasmModuleUrl);
await assertExists(runtimedWasmUrl);
await mkdir(new URL("../dist/plugins/", import.meta.url), { recursive: true });
await mkdir(new URL("../dist/assets/", import.meta.url), { recursive: true });
await copyFile(siftWasmUrl, outputUrl);
await copyFile(runtimedWasmModuleUrl, runtimedModuleOutputUrl);
await copyFile(runtimedWasmUrl, runtimedOutputUrl);
await copyFile(runtimedWasmModuleUrl, runtimedModulePluginOutputUrl);
await copyFile(runtimedWasmUrl, runtimedPluginOutputUrl);

console.log(`copied ${fileURLToPath(siftWasmUrl)} -> ${fileURLToPath(outputUrl)}`);
console.log(
  `copied ${fileURLToPath(runtimedWasmModuleUrl)} -> ${fileURLToPath(runtimedModuleOutputUrl)}`,
);
console.log(`copied ${fileURLToPath(runtimedWasmUrl)} -> ${fileURLToPath(runtimedOutputUrl)}`);
console.log(
  `copied ${fileURLToPath(runtimedWasmModuleUrl)} -> ${fileURLToPath(runtimedModulePluginOutputUrl)}`,
);
console.log(
  `copied ${fileURLToPath(runtimedWasmUrl)} -> ${fileURLToPath(runtimedPluginOutputUrl)}`,
);

async function assertExists(url) {
  try {
    await access(fileURLToPath(url));
  } catch {
    throw new Error(
      `Missing ${fileURLToPath(url)}. Run \`pnpm --dir apps/notebook-cloud run build\` to rebuild viewer inputs.`,
    );
  }
}
