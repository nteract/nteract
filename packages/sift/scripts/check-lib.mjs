// prepack: refuse to pack a lib/ that is missing pieces. The packed-consumer
// test (test-package.mjs) covers behavior; this only guards against publishing
// a stale or partial build directory.
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const lib = join(dirname(fileURLToPath(import.meta.url)), "..", "lib");
const required = [
  "index.js",
  "handoff.js",
  "handoff.css",
  "style.css",
  "types/packages/sift/src/index.d.ts",
  "types/packages/sift/src/handoff.d.ts",
  "wasm/sift_wasm.js",
  "wasm/sift_wasm_bg.wasm",
  "THIRD_PARTY_NOTICES.md",
  "LICENSE",
];
for (const file of required) {
  try {
    if (statSync(join(lib, file)).size === 0) throw new Error("empty");
  } catch {
    console.error(
      `lib/${file} is missing. Run: cargo xtask wasm sift && pnpm build:lib && pnpm notices`,
    );
    process.exit(1);
  }
}
const glue = readFileSync(join(lib, "wasm/sift_wasm.js"), "utf8");
if (!glue.includes("sift_wasm_bg.wasm")) {
  console.error("lib/wasm/sift_wasm.js does not look like wasm-pack's sift-wasm glue.");
  process.exit(1);
}
