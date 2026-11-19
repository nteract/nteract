// The output Worker's build. writeFrameHtml writes the frame shell HTML that
// output/worker.mjs imports; bundleOutputWorker bundles that Worker into one
// self-contained module. scripts/build.mjs runs both and writes the module to
// dist/output/worker.js. Run directly, this script writes only the frame HTML,
// for scripts/output-smoke.mjs, which runs the Worker unbundled.
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sourceFingerprint } from "./source-fingerprint.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Write .output-dist/frame-html.mjs: the @nteract/output-frame runtime and
 * stylesheet inlined in one HTML document. */
export async function writeFrameHtml(app = root) {
  const result = await build({
    entryPoints: [fileURLToPath(import.meta.resolve("@nteract/output-frame/runtime"))],
    bundle: true,
    // An IIFE leaves dynamic import() as written. The banner keeps the
    // module's strict-mode semantics, which a classic script lacks.
    format: "iife",
    banner: { js: '"use strict";' },
    write: false,
    minify: true,
    target: "es2022",
  });
  const js = result.outputFiles[0].text.replace(/<\/script/gi, String.raw`<\/script`);
  const css = await readFile(
    fileURLToPath(import.meta.resolve("@nteract/output-frame/styles.css")),
    "utf8",
  );
  // The runtime is a classic script: an import map appended at mount applies
  // only while no module has loaded in this document. Firefox and older
  // Safari ignore a map added after that, so a module shell would leave every
  // bare specifier a view imports unresolved. It runs after <main> exists.
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main></main><script>${js}</script></body></html>`;
  await mkdir(path.join(app, ".output-dist"), { recursive: true });
  await writeFile(
    path.join(app, ".output-dist/frame-html.mjs"),
    `export const FRAME_HTML = ${JSON.stringify(html)};\n`,
  );
}

/** The output Worker as one ES module with no imports, its bytes. `define`
 * carries __PAGES_BUILD__, which /health reports. Paths in the bundle's
 * comments are relative to `app`, so the bytes do not depend on the machine. */
export async function bundleOutputWorker(app = root, define = {}) {
  await writeFrameHtml(app);
  const result = await build({
    entryPoints: [path.join(app, "output/worker.mjs")],
    absWorkingDir: app,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    legalComments: "none",
    write: false,
    metafile: true,
    define,
  });
  const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports);
  if (imports.length)
    throw new Error(
      `The output Worker must not import anything: ${imports.map((i) => i.path).join(", ")}`,
    );
  return result.outputFiles[0].contents;
}

/** writeFrameHtml for an unbundled run, after checking that the installed
 * @nteract/output-frame matches this checkout. */
export async function prepareFrameHtml() {
  sourceFingerprint(root, { verifyInstalled: true });
  await writeFrameHtml();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await prepareFrameHtml();
