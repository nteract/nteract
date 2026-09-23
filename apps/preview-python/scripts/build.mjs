import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = dirname(fileURLToPath(import.meta.resolve("pyodide")));
const lock = JSON.parse(await readFile(resolve(root, "runtime-lock.json"), "utf8"));
for (const [name, expected] of Object.entries(lock.assets)) {
  if (name === "sentinel.wasm") continue;
  const bytes = await readFile(resolve(runtime, name));
  if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
    throw new Error(`Pinned runtime asset differs: ${name}`);
  }
}
const loader = await readFile(resolve(runtime, "pyodide.mjs"), "utf8");
const embedded = [...loader.matchAll(/"(AGFzbQ[A-Za-z0-9+/=]+)"/g)];
if (embedded.length !== 1) throw new Error("Expected one pinned Wasm sentinel");
const sentinel = Buffer.from(embedded[0][1], "base64");
if (createHash("sha256").update(sentinel).digest("hex") !== lock.assets["sentinel.wasm"].sha256) {
  throw new Error("Pinned sentinel differs");
}
await mkdir(resolve(root, "dist"), { recursive: true });
await copyFile(resolve(runtime, "pyodide.asm.wasm"), resolve(root, "dist/pyodide.asm.wasm"));
await writeFile(resolve(root, "dist/sentinel.wasm"), sentinel);
await build({
  absWorkingDir: root,
  entryPoints: ["runtime/worker.js"],
  outfile: "dist/session.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["node:*", "./pyodide.asm.wasm", "./sentinel.wasm"],
  loader: { ".zip": "binary", ".py": "text" },
  define: { process: "undefined", location: '"https://python-runtime.invalid/"' },
  inject: ["runtime/assets.js"],
  plugins: [
    {
      name: "pinned-sentinel",
      setup(builder) {
        builder.onResolve({ filter: /^preview-python:sentinel$/ }, () => ({
          path: "sentinel",
          namespace: "sentinel",
        }));
        builder.onLoad({ filter: /.*/, namespace: "sentinel" }, () => ({
          contents: sentinel,
          loader: "binary",
        }));
      },
    },
  ],
});
