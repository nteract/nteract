import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sourceFingerprint } from "./source-fingerprint.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
sourceFingerprint(root); // Includes freshness checks for the local frame package.
const result = await build({
  entryPoints: [fileURLToPath(import.meta.resolve("@nteract/output-frame/runtime"))],
  bundle: true,
  format: "esm",
  write: false,
  minify: true,
  target: "es2022",
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, String.raw`<\/script`);
const css = await readFile(
  fileURLToPath(import.meta.resolve("@nteract/output-frame/styles.css")),
  "utf8",
);
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main></main><script type="module">${js}</script></body></html>`;
await mkdir(root + ".output-dist", { recursive: true });
await writeFile(
  root + ".output-dist/frame-html.mjs",
  `export const FRAME_HTML = ${JSON.stringify(html)};\n`,
);
