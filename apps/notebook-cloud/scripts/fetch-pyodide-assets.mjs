// Fetch the Pyodide distribution into apps/notebook-cloud/pyodide-assets/.
//
// The pyodide execution worker (src/pyodide-worker/) resolves `pyodide.mjs`
// relative to its asset base; bundling those files as sibling assets lets
// celld register the WASM as a static import. Run before
// `node scripts/celld-local.mjs export` / CI preview bundling:
//
//   node scripts/fetch-pyodide-assets.mjs
//
// Override the version with PYODIDE_VERSION (default pinned below) and the
// download root with PYODIDE_DIST_URL.

import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PYODIDE_VERSION = process.env.PYODIDE_VERSION ?? "0.28.3";
const DIST_ROOT =
  process.env.PYODIDE_DIST_URL ?? `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(appDir, "pyodide-assets");

const FILES = [
  "pyodide.mjs",
  "pyodide.asm.wasm",
  "pyodide.asm.js",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

for (const file of FILES) {
  const target = path.join(outDir, file);
  const response = await fetch(`${DIST_ROOT}${file}`);
  if (!response.ok) {
    console.error(`[fetch-pyodide-assets] ${file}: HTTP ${response.status}`);
    process.exitCode = 1;
    continue;
  }
  const body = new Uint8Array(await response.arrayBuffer());
  await rm(target, { force: true });
  const handle = createWriteStream(target);
  await new Promise((resolve, reject) => {
    handle.end(body, (error) => (error ? reject(error) : resolve()));
  });
  console.log(`[fetch-pyodide-assets] ${file} (${body.length} bytes)`);
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

const wasm = await readFile(path.join(outDir, "pyodide.asm.wasm"));
if (
  wasm.length < 4 ||
  wasm[0] !== 0x00 ||
  wasm[1] !== 0x61 ||
  wasm[2] !== 0x73 ||
  wasm[3] !== 0x6d
) {
  console.error("[fetch-pyodide-assets] pyodide.asm.wasm is not a WASM module (bad magic)");
  process.exitCode = 1;
} else {
  console.log(`[fetch-pyodide-assets] pyodide v${PYODIDE_VERSION} ready in ${outDir}`);
}
