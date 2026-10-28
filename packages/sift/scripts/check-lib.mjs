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
  "worker.js",
  "style.css",
  "types/packages/sift/src/index.d.ts",
  "types/packages/sift/src/handoff.d.ts",
  "types/packages/sift/src/worker/entry.d.ts",
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
// The worker bundle must reach the glue by the same relative path as index.js,
// directly or through a shared chunk it imports.
function reachesGlue(file, seen = new Set()) {
  if (seen.has(file)) return false;
  seen.add(file);
  const code = readFileSync(join(lib, file), "utf8");
  if (code.includes("./wasm/sift_wasm.js")) return true;
  const imports = [...code.matchAll(/from\s*"(\.\/[^"]+\.js)"|import\("(\.\/[^"]+\.js)"\)/g)];
  return imports.some(([, a, b]) => reachesGlue(a ?? b, seen));
}
if (!reachesGlue("worker.js")) {
  console.error(
    "lib/worker.js does not import ./wasm/sift_wasm.js; the worker could not load WASM.",
  );
  process.exit(1);
}
const glue = readFileSync(join(lib, "wasm/sift_wasm.js"), "utf8");
if (!glue.includes("sift_wasm_bg.wasm")) {
  console.error("lib/wasm/sift_wasm.js does not look like wasm-pack's sift-wasm glue.");
  process.exit(1);
}
