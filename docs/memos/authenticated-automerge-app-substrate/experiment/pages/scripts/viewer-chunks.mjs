// The viewer bundle is app.js plus content-hashed chunks under public/chunks.
// app.js renders the shell; the Page editor and the WASM runtimes it waits for
// load from a chunk (viewer/editor-loader.mjs). These checks run on the build's
// metafile, with output paths relative to dist.
//
// Every file the viewer loads by a build-specific name carries a content hash,
// so it is served immutable and a return visit revalidates only index.html.
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { browserMermaidPlugin } from "./browser-mermaid.mjs";
import { BROWSER_WASM_URLS, browserWasmPlugin } from "./browser-wasm.mjs";
import { FAVICON_HREF } from "../shared/favicon.mjs";
import { PRODUCT_NAME } from "../shared/product.mjs";

export const VIEWER_ENTRY = "public/app.js";
// esbuild's [hash] is eight base32 characters. Staging and the page9 ingress
// route admit exactly this shape.
export const VIEWER_CHUNK = /^public\/chunks\/[A-Z2-7]{8}\.js$/;
const VIEWER_CHUNK_STYLE = /^public\/chunks\/[A-Z2-7]{8}\.css$/;
// browser-wasm.mjs loads both runtimes through modules in these namespaces.
const WASM_RUNTIME_INPUT = /^wasm-(?:ready|entry):/;

// The shell's own files ship as public/<name>-<hash>.<ext>. The hash is the
// first 40 bits of the file's sha256 in base32, the same eight-character shape
// as a chunk name, so staging can check each name against the bytes it
// certifies. Sources (viewer/index.html, the Worker's own pages, the WASM and
// Mermaid plugins) use these names; the build swaps in the hashed ones.
export const VIEWER_ASSETS = Object.freeze([
  "app.js",
  "app.css",
  "theme.js",
  "mermaid.js",
  "automerge.wasm",
  "subduction.wasm",
]);
// Staging and the page9 ingress route admit exactly these shapes.
const VIEWER_ASSET =
  /^public\/(app|theme|mermaid|automerge|subduction)-([A-Z2-7]{8})\.(js|css|wasm)$/;
export const IMMUTABLE = "public, max-age=31536000, immutable";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** Eight base32 characters from the first five bytes of a sha256 digest. */
export function digestHash(digest) {
  const bytes = Buffer.from(digest, "hex");
  if (bytes.length !== 32) throw new Error("Expected a sha256 digest");
  let bits = 0n;
  for (const byte of bytes.subarray(0, 5)) bits = (bits << 8n) | BigInt(byte);
  let name = "";
  for (let shift = 35n; shift >= 0n; shift -= 5n) name += BASE32[Number((bits >> shift) & 31n)];
  return name;
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The dist path a shell asset ships under, e.g. public/app-ABCDEFGH.js. */
export function hashedAssetPath(name, bytes) {
  if (!VIEWER_ASSETS.includes(name)) throw new Error(`Unknown viewer asset ${name}`);
  const dot = name.lastIndexOf(".");
  return `public/${name.slice(0, dot)}-${digestHash(sha256(bytes))}${name.slice(dot)}`;
}

/** For a hashed shell asset path, its source name and hash; otherwise null. */
export function viewerAsset(file) {
  const match = VIEWER_ASSET.exec(file);
  const name = match && `${match[1]}.${match[3]}`;
  return name && VIEWER_ASSETS.includes(name) ? { name, hash: match[2] } : null;
}

/** The URL a dist path under public/ is served at. */
export const publicUrl = (file) => {
  if (!file.startsWith("public/")) throw new Error(`Not a public file: ${file}`);
  return "/" + file.slice("public/".length);
};

/** esbuild options for the viewer: app.js renders the shell, and the editor
 * with the WASM runtimes loads from public/chunks through a dynamic import.
 * `urls` maps the WASM and Mermaid source names to the URLs to load. */
export function viewerBuildOptions(app, dist, define = {}, urls = {}) {
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
    plugins: [
      browserMermaidPlugin(app, urls["mermaid.js"]),
      browserWasmPlugin(app, {
        automerge: urls["automerge.wasm"] ?? BROWSER_WASM_URLS.automerge,
        subduction: urls["subduction.wasm"] ?? BROWSER_WASM_URLS.subduction,
      }),
    ],
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

// The attributes in viewer/index.html that name a shell asset.
const HTML_REFERENCES = Object.freeze({
  "theme.js": 'src="/theme.js"',
  "app.css": 'href="/app.css"',
  "automerge.wasm": 'href="/automerge.wasm"',
  "subduction.wasm": 'href="/subduction.wasm"',
  "app.js": 'src="/app.js"',
});

/** index.html with each shell asset reference pointing at its hashed file.
 * `assets` maps source names to dist paths. Each reference must appear in the
 * source exactly once. */
export function withHashedAssets(html, assets) {
  for (const [name, attribute] of Object.entries(HTML_REFERENCES)) {
    const file = assets[name];
    if (viewerAsset(file ?? "")?.name !== name)
      throw new Error(`Expected a hashed ${name}, got ${file}`);
    const parts = html.split(attribute);
    if (parts.length !== 2) throw new Error(`index.html must reference /${name} exactly once`);
    html = parts.join(attribute.replace(`/${name}`, publicUrl(file)));
  }
  return html;
}

const FAVICON_REFERENCE = 'href="/favicon.png"';

/** index.html with its tab icon link pointing at the inlined app icon. The
 * source must reference /favicon.png exactly once. No public route serves
 * that name; this swap is what makes the link resolve. */
export function withInlineFavicon(html, href = FAVICON_HREF) {
  if (!href.startsWith("data:image/png;base64,")) throw new Error("Expected a PNG data URL");
  const parts = html.split(FAVICON_REFERENCE);
  if (parts.length !== 2) throw new Error("index.html must reference /favicon.png exactly once");
  return parts.join(`href="${href}"`);
}

/** index.html with PRODUCT_NAME as its tab title and header brand, so the
 * static shell names the product the way the app does. */
export function withProductName(html, name = PRODUCT_NAME) {
  const named = html
    .replace(/<title>[^<]*<\/title>/, `<title>${name}</title>`)
    .replace(/(class="brand">)[^<]*(<\/a>)/, `$1${name}$2`);
  if (!named.includes(`<title>${name}</title>`) || !named.includes(`class="brand">${name}</a>`))
    throw new Error("index.html must have one <title> and one brand link");
  return named;
}

/** The _headers file: `security` headers on every response, and immutable
 * caching on exactly the hashed files this build ships. Exact paths only: a
 * wildcard rule would also apply to the single-page fallback a retired name
 * receives, and cache the app's HTML under that name for a year. */
export function headersFile(security, hashed) {
  const rules = [...hashed].sort().map((file) => {
    if (!VIEWER_CHUNK.test(file) && !viewerAsset(file))
      throw new Error(`Not a hashed viewer file: ${file}`);
    return `${publicUrl(file)}\n  Cache-Control: ${IMMUTABLE}\n`;
  });
  return "/*\n" + security.map((header) => `  ${header}\n`).join("") + rules.join("");
}

/** esbuild defines naming the hashed theme script and stylesheet, for the
 * Worker's own HTML pages (shared/shell-assets.mjs). `files` lists the hashed
 * dist paths, e.g. the keys of the receipt's viewer_assets. */
export function shellAssetDefine(files) {
  const url = (name) => {
    const matches = [...files].filter((file) => viewerAsset(file)?.name === name);
    if (matches.length !== 1) throw new Error(`Expected one hashed ${name}`);
    return JSON.stringify(publicUrl(matches[0]));
  };
  return { __PAGES_THEME_SCRIPT__: url("theme.js"), __PAGES_STYLESHEET__: url("app.css") };
}

/** shellAssetDefine for the files in a built `public` directory, for local
 * harnesses that bundle their own fixture Worker beside a dist. A build from
 * before hashed shell assets gets no defines and keeps the source names. */
export function publicShellAssetDefine(publicDirectory) {
  const files = readdirSync(publicDirectory).map((name) => `public/${name}`);
  return files.some((file) => viewerAsset(file)) ? shellAssetDefine(files) : {};
}
