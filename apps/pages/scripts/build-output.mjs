// The output frame's build. writeFrameHtml writes the bootstrap document that
// output/worker.mjs imports and the frame runtime text the viewer imports;
// bundleOutputWorker bundles that Worker into one self-contained module.
// scripts/build.mjs runs both and writes the module to dist/output/worker.js.
// Run directly, this script writes only .output-dist, for
// scripts/output-smoke.mjs, which runs the Worker unbundled.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { BOOTSTRAP_HTML, BOOTSTRAP_SCRIPT } from "@nteract/output-frame/bootstrap";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sourceFingerprint } from "./source-fingerprint.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

/** The frame runtime as the text of one classic script: @nteract/output-frame's
 * runtime and its stylesheet. The viewer sends it to the frame at boot. */
export async function frameRuntimeText() {
  const result = await build({
    stdin: {
      contents: [
        'import styles from "@nteract/output-frame/styles.css";',
        'import { installRuntime } from "@nteract/output-frame/runtime";',
        "installRuntime(styles);",
      ].join("\n"),
      resolveDir: root,
      sourcefile: "frame-runtime.mjs",
    },
    bundle: true,
    loader: { ".css": "text" },
    // An IIFE leaves dynamic import() as written. The banner keeps the
    // module's strict-mode semantics, which a classic script lacks. It must
    // stay a classic script: an import map appended at mount applies only
    // while no module has loaded in the frame, and Firefox and older Safari
    // ignore a map added after that.
    format: "iife",
    banner: { js: '"use strict";' },
    write: false,
    minify: true,
    target: "es2022",
  });
  return result.outputFiles[0].text;
}

/** Write .output-dist: frame-html.mjs, the bootstrap document the output
 * Worker serves (FRAME_HTML) and the sha256 of its script
 * (FRAME_BOOTSTRAP_SHA256), and frame-runtime.mjs, the runtime text the viewer
 * imports (FRAME_RUNTIME). */
export async function writeFrameHtml(app = root) {
  await mkdir(path.join(app, ".output-dist"), { recursive: true });
  await writeFile(
    path.join(app, ".output-dist/frame-html.mjs"),
    `export const FRAME_HTML = ${JSON.stringify(BOOTSTRAP_HTML)};\n` +
      `export const FRAME_BOOTSTRAP_SHA256 = ${JSON.stringify(bootstrapSha256())};\n`,
  );
  await writeFile(
    path.join(app, ".output-dist/frame-runtime.mjs"),
    `export const FRAME_RUNTIME = ${JSON.stringify(await frameRuntimeText())};\n`,
  );
}

/** The sha256 of the bootstrap document's script, which the build receipt
 * records and an installer compares with what the output host serves. */
export const bootstrapSha256 = () => createHash("sha256").update(BOOTSTRAP_SCRIPT).digest("hex");

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
