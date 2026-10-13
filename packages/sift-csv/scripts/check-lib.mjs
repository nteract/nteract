// prepack: refuse to pack a lib/ that is missing or whose WASM glue and
// binary were not built together.
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const lib = join(dirname(fileURLToPath(import.meta.url)), "..", "lib");
const required = [
  "index.js",
  "types/index.d.ts",
  "wasm/sift_csv_wasm.js",
  "wasm/sift_csv_wasm_bg.wasm",
  "THIRD_PARTY_NOTICES.md",
  "LICENSE",
];
for (const file of required) {
  try {
    if (statSync(join(lib, file)).size === 0) throw new Error("empty");
  } catch {
    console.error(
      `lib/${file} is missing. Run: cargo xtask wasm sift-csv && pnpm build:lib && pnpm notices`,
    );
    process.exit(1);
  }
}
const glue = readFileSync(join(lib, "wasm/sift_csv_wasm.js"), "utf8");
if (!glue.includes("sift_csv_wasm_bg.wasm") || !glue.includes("csvToArrowIpc")) {
  console.error("lib/wasm/sift_csv_wasm.js does not look like the sift-csv-wasm glue.");
  process.exit(1);
}
