import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["main.mjs"],
  bundle: true,
  conditions: ["webpack"],
  format: "esm",
  target: "es2022",
  outfile: "dist/main.js",
  sourcemap: true,
  loader: { ".wasm": "binary" },
});
await copyFile("index.html", "dist/index.html");
await copyFile("style.css", "dist/style.css");
