// The viewer bundle is app.js plus content-hashed chunks under public/chunks.
// app.js renders the shell; the Page editor and the WASM runtimes it waits for
// load from a chunk (viewer/editor-loader.mjs). These checks run on the build's
// metafile, with output paths relative to dist.
import { createRequire } from "node:module";
import path from "node:path";
import { browserMermaidPlugin } from "./browser-mermaid.mjs";
import { browserWasmPlugin } from "./browser-wasm.mjs";

export const VIEWER_ENTRY = "public/app.js";
// esbuild's [hash] is eight base32 characters. Staging and the page9 ingress
// route admit exactly this shape.
export const VIEWER_CHUNK = /^public\/chunks\/[A-Z2-7]{8}\.js$/;
const VIEWER_CHUNK_STYLE = /^public\/chunks\/[A-Z2-7]{8}\.css$/;
// browser-wasm.mjs loads both runtimes through modules in these namespaces.
const WASM_RUNTIME_INPUT = /^wasm-(?:ready|entry):/;

/** esbuild options for the viewer: app.js renders the shell, and the editor
 * with the WASM runtimes loads from public/chunks through a dynamic import. */
export function viewerBuildOptions(app, dist, define = {}) {
  const require = createRequire(path.join(app, "package.json"));
  return {
    entryPoints: { app: path.join(app, "viewer/main.jsx") },
    // Shared UI source lives outside this npm workspace. Resolve one React
    // instance for both the Page shell and shared components.
    alias: Object.fromEntries(
      ["react", "react-dom", "lucide-react"].map((name) => [
        name,
        path.dirname(require.resolve(`${name}/package.json`)),
      ]),
    ),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    tsconfig: path.join(app, "tsconfig.json"),
    splitting: true,
    outdir: path.join(dist, "public"),
    chunkNames: "chunks/[hash]",
    // Metafile paths are relative to dist, e.g. public/chunks/ABCDEFGH.js.
    absWorkingDir: dist,
    metafile: true,
    define: { "process.env.NODE_ENV": '"production"', ...define },
    plugins: [browserMermaidPlugin(app), browserWasmPlugin(app)],
  };
}

/** The outputs the browser loads before app.js runs: app.js and every chunk
 * it reaches through static imports. */
export function staticOutputs(metafile, entry = VIEWER_ENTRY) {
  const reached = new Set();
  const visit = (output) => {
    if (reached.has(output)) return;
    const meta = metafile.outputs[output];
    if (!meta) throw new Error(`The viewer build has no output ${output}`);
    reached.add(output);
    for (const item of meta.imports)
      if (item.kind === "import-statement" && !item.external) visit(item.path);
  };
  visit(entry);
  return [...reached];
}

/**
 * Check a viewer build and name its files.
 *
 * - app.js must not reach a WASM runtime through static imports, so the shell
 *   renders before the runtimes download and compile.
 * - Every other script is a hashed chunk under public/chunks.
 *
 * Returns `chunks` (every JS chunk, to stage and serve), `preloads` (the
 * chunks app.js imports statically, for index.html) and `styles` (chunk CSS
 * files; app.css already carries their rules).
 */
export function viewerSplit(metafile) {
  const outputs = Object.keys(metafile.outputs).filter((file) => !file.endsWith(".map"));
  const shell = staticOutputs(metafile);
  const runtime = shell.flatMap((output) =>
    Object.keys(metafile.outputs[output].inputs).filter((input) => WASM_RUNTIME_INPUT.test(input)),
  );
  if (runtime.length)
    throw new Error(
      `app.js must not import the WASM runtimes statically; load them through page-editor.mjs (${runtime.join(", ")})`,
    );
  const chunks = [],
    styles = [];
  for (const output of outputs) {
    if (output === VIEWER_ENTRY || output === "public/app.css") continue;
    if (VIEWER_CHUNK.test(output)) chunks.push(output);
    else if (VIEWER_CHUNK_STYLE.test(output)) styles.push(output);
    else throw new Error(`Unexpected viewer output ${output}`);
  }
  if (!chunks.length) throw new Error("The viewer build must split the editor into a chunk");
  return {
    chunks: chunks.sort(),
    preloads: shell.filter((output) => output !== VIEWER_ENTRY).sort(),
    styles: styles.sort(),
  };
}

/** True when every rule of a chunk's CSS appears in app.css. */
export const stylesCovered = (chunkCss, appCss) =>
  chunkCss
    .split("}")
    .filter((part) => part.trim())
    .every((part) => appCss.includes(part + "}"));

const STYLESHEET = '    <link rel="stylesheet" href="/app.css" />\n';

/** index.html with a modulepreload for each chunk app.js imports statically,
 * so they download beside app.js instead of after it. The editor chunk is not
 * preloaded: app.js requests it at boot, and fetching it beside app.js
 * delayed the shell on fast links while gaining little on slow ones. */
export function withModulePreloads(html, preloads) {
  if (html.split(STYLESHEET).length !== 2)
    throw new Error("index.html must link /app.css exactly once");
  if (html.includes('rel="modulepreload"'))
    throw new Error("index.html source must not list chunk preloads");
  const link = (file) => {
    if (!VIEWER_CHUNK.test(file)) throw new Error(`Unexpected viewer preload ${file}`);
    return `    <link rel="modulepreload" href="/${file.slice("public/".length)}" />\n`;
  };
  const links = preloads.map(link).join("");
  return html.replace(STYLESHEET, STYLESHEET + links);
}
