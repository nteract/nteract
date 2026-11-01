import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import { celldCborPlugin } from "./celld-cbor.mjs";
import { browserMermaidPlugin, mermaidSource } from "./browser-mermaid.mjs";
import {
  IMMUTABLE,
  VIEWER_ASSETS,
  VIEWER_CHUNK,
  digestHash,
  hashedAssetPath,
  headersFile,
  shellAssetDefine,
  stylesCovered,
  viewerAsset,
  viewerBuildOptions,
  viewerSplit,
  withHashedAssets,
  withInlineFavicon,
  withModulePreloads,
} from "./viewer-chunks.mjs";
import { FAVICON_HREF } from "../shared/favicon.mjs";
import { createHash } from "node:crypto";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
async function bundle(plugins = []) {
  const result = await build({
    stdin: {
      contents:
        'import {Encoder, decode} from "cbor-x"; export function roundTrip(value) {return decode(new Encoder({tagUint8Array:false,useRecords:false}).encode(value));}',
      resolveDir: app,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "CborProbe",
    target: "es2022",
    plugins,
  });
  return result.outputFiles[0].text;
}
function evaluate(source) {
  // Static class methods are callable but not constructors, matching celld's
  // Buffer allocator. Keep this stub inside the VM; never change Node globals.
  class WorkerBuffer extends Uint8Array {
    static allocUnsafeSlow(size) {
      return new WorkerBuffer(size);
    }
  }
  const context = vm.createContext({ Buffer: WorkerBuffer, TextEncoder, TextDecoder });
  vm.runInContext(source, context);
  return { context, buffer: WorkerBuffer, allocator: WorkerBuffer.allocUnsafeSlow };
}

test("celld CBOR workaround round-trips text and binary past initial buffer size", async () => {
  const original = evaluate(await bundle());
  assert.throws(
    () => original.context.CborProbe.roundTrip({ hello: "world" }),
    /ByteArrayAllocate is not a constructor/,
  );
  const fixed = evaluate(await bundle([celldCborPlugin()]));
  const result = vm.runInContext(
    'CborProbe.roundTrip({text:"🌊 collaboration".repeat(1500),binary:new Uint8Array([0,1,254,255])})',
    fixed.context,
  );
  assert.equal(result.text, "🌊 collaboration".repeat(1500));
  assert.deepEqual([...result.binary], [0, 1, 254, 255]);
  assert.strictEqual(fixed.context.Buffer, fixed.buffer);
  assert.strictEqual(fixed.context.Buffer.allocUnsafeSlow, fixed.allocator);
  const packageRoot = path.dirname(require.resolve("cbor-x/package.json"));
  assert.match(
    readFileSync(path.join(packageRoot, "encode.js"), "utf8"),
    /const hasNodeBuffer = typeof Buffer !== 'undefined'/,
  );
});

test("celld CBOR workaround fails closed on an unexpected upstream allocation check", async () => {
  let loader;
  celldCborPlugin().setup({
    onLoad(_options, callback) {
      loader = callback;
    },
  });
  await assert.rejects(
    loader({ path: path.join(app, "package.json") }),
    /allocation check changed/,
  );
});

test("failed rebuild removes the previous receipt before replacing any artifacts", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "pages-build-failure-"));
  const write = (relative, contents) => {
    const file = path.join(fixture, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  };
  try {
    // Execute the actual build entry point against a failing bundler. This
    // models an old source-A receipt followed by a partial source-B build.
    write("scripts/build.mjs", readFileSync(new URL("./build.mjs", import.meta.url), "utf8"));
    write("scripts/celld-cbor.mjs", "export const celldCborPlugin = () => ({});");
    write(
      "scripts/browser-mermaid.mjs",
      readFileSync(new URL("./browser-mermaid.mjs", import.meta.url), "utf8"),
    );
    for (const name of ["browser-wasm.mjs", "viewer-chunks.mjs", "deployment/profiles.mjs"])
      write(`scripts/${name}`, readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));
    write(
      "shared/favicon.mjs",
      readFileSync(new URL("../shared/favicon.mjs", import.meta.url), "utf8"),
    );
    write(
      "scripts/source-fingerprint.mjs",
      "export const sourceFingerprint = () => ({sha256:'source-B'}); export const writeBuildReceipt = () => {throw new Error('failed build must not certify outputs');};",
    );
    write(
      "node_modules/esbuild/package.json",
      JSON.stringify({ name: "esbuild", type: "module", exports: "./index.js" }),
    );
    write(
      "node_modules/esbuild/index.js",
      "import {writeFileSync} from 'node:fs'; export async function build(options) { writeFileSync(options.outfile,'partial source-B bundle'); throw new Error('injected bundler failure'); }",
    );
    for (const [name, exported, binary] of [
      ["automerge", "automerge.wasm", "automerge.wasm"],
      ["subduction", "wasm", "subduction.wasm"],
    ]) {
      write(
        `node_modules/@automerge/${name}/package.json`,
        JSON.stringify({
          name: `@automerge/${name}`,
          exports: { [`./${exported}`]: `./${binary}` },
        }),
      );
      write(`node_modules/@automerge/${name}/${binary}`, "source-B wasm");
    }
    write("dist/build-receipt.json", JSON.stringify({ fingerprint: { sha256: "source-A" } }));
    write("dist/index.js", "source-A bundle");
    let failure;
    try {
      execFileSync(process.execPath, [path.join(fixture, "scripts/build.mjs")], { stdio: "pipe" });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.match(failure.stderr.toString(), /injected bundler failure/);
    // The first bundle (the theme script) wrote partial output and failed.
    assert.equal(
      readFileSync(path.join(fixture, "dist/public/theme.js"), "utf8"),
      "partial source-B bundle",
    );
    assert.equal(existsSync(path.join(fixture, "dist/build-receipt.json")), false);
    // Returning the checkout to source A cannot make this directory deployable:
    // prepare requires a receipt, and the failing build removed it.
    assert.throws(() => readFileSync(path.join(fixture, "dist/build-receipt.json")), {
      code: "ENOENT",
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("browser bundles keep Mermaid as a separate dynamic local module", async () => {
  const result = await build({
    stdin: {
      contents: `export const loadDiagram = () => import(${JSON.stringify(mermaidSource(app))});`,
      resolveDir: app,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022",
    metafile: true,
    plugins: [browserMermaidPlugin(app)],
  });
  assert.match(result.outputFiles[0].text, /import\("\/mermaid\.js"\)/);
  assert.deepEqual(Object.keys(result.metafile.inputs), ["<stdin>"]);
  assert.deepEqual(result.metafile.outputs["stdin.js"].imports, [
    { path: "/mermaid.js", kind: "dynamic-import", external: true },
  ]);
});

test("an eager Mermaid source import fails the browser build instead of growing startup code", async () => {
  await assert.rejects(
    build({
      stdin: {
        contents: `import {mountMermaid} from ${JSON.stringify(mermaidSource(app))}; console.log(mountMermaid);`,
        resolveDir: app,
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      logLevel: "silent",
      plugins: [browserMermaidPlugin(app)],
    }),
    /Mermaid renderer must remain a dynamic import/,
  );
});

test("the blocking theme asset applies preferences without loading the editor", async () => {
  const result = await build({
    entryPoints: [path.join(app, "viewer/theme-bootstrap.mjs")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: true,
    metafile: true,
  });
  const output = result.outputFiles[0].text;
  assert.ok(Buffer.byteLength(output) < 8192, "first paint must not wait for the editor bundle");
  assert.deepEqual(
    Object.keys(result.metafile.inputs)
      .map((file) => path.basename(file))
      .sort(),
    ["admission.mjs", "early-session.mjs", "routes.mjs", "theme-bootstrap.mjs", "theme.mjs"],
  );
  const classes = new Set();
  const root = {
    classList: { toggle: (name, enabled) => (enabled ? classes.add(name) : classes.delete(name)) },
    dataset: {},
    style: {},
  };
  const fetches = [];
  const listen = () => {};
  const window = {
    document: { documentElement: root, addEventListener: listen },
    addEventListener: listen,
    localStorage: { getItem: (key) => (key === "nteract.pages.theme" ? "dark" : null) },
    location: { href: "https://pages.example/" },
    fetch: (url, init) => {
      fetches.push([url, Object.keys(init)]);
      return new Promise(() => {});
    },
  };
  vm.runInNewContext(output, { window, URL, AbortController, performance });
  // The viewer's first session refresh takes this request (early-session.mjs).
  assert.deepEqual(fetches, [["/api/auth/session", ["signal"]]]);
  assert.ok(window.__pagesEarlySession);
  // On a Page route the head script also starts that Page's discovery.
  fetches.length = 0;
  const pageId = "5f0c4a5e-6c1e-4b0e-9a8f-0d0d4c5e6f70";
  vm.runInNewContext(output, {
    window: { ...window, location: { href: `https://pages.example/p/${pageId}` } },
    URL,
    AbortController,
    performance,
  });
  assert.deepEqual(fetches, [
    ["/api/auth/session", ["signal"]],
    [`/api/connect?page=${pageId}&preview=1`, ["headers", "signal"]],
  ]);
  assert.equal(root.dataset.theme, "dark");
  assert.equal(root.dataset.colorTheme, undefined);
  assert.equal(root.style.colorScheme, "dark");
  assert.deepEqual([...classes], ["dark"]);
  const html = readFileSync(path.join(app, "viewer/index.html"), "utf8");
  const script = '<script src="/theme.js"></script>';
  assert.ok(html.includes(script));
  assert.ok(html.indexOf(script) < html.indexOf('<link rel="stylesheet"'));
  assert.ok(html.indexOf(script) < html.indexOf("</head>"));
});

test("shared renderer resolves ESM imports through fixture paths without a root install", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pages-renderer-dependencies-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = path.join(root, "experiment/pages");
  const source = path.join(root, "src/shared-renderer.mjs");
  mkdirSync(fixture, { recursive: true });
  mkdirSync(path.dirname(source), { recursive: true });
  writeFileSync(
    source,
    'import purify from "dompurify"; import {mount} from "pele"; export const renderer = [purify,mount];',
  );
  const { paths } = JSON.parse(
    readFileSync(path.join(app, "tsconfig.json"), "utf8"),
  ).compilerOptions;
  writeFileSync(
    path.join(fixture, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { paths: { dompurify: paths.dompurify, pele: paths.pele } },
    }),
  );
  for (const [name, relative, contents] of [
    ["dompurify", "dist/purify.es.mjs", 'export default "browser purifier";'],
    ["pele", "dist/pele.js", 'export const mount = "browser renderer";'],
  ]) {
    const directory = path.join(root, "experiment/node_modules", name);
    mkdirSync(path.join(directory, "dist"), { recursive: true });
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, type: "module" }));
    writeFileSync(path.join(directory, relative), contents);
  }
  const result = await build({
    entryPoints: [source],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    metafile: true,
    tsconfig: path.join(fixture, "tsconfig.json"),
  });
  assert.match(result.outputFiles[0].text, /browser purifier/);
  assert.match(result.outputFiles[0].text, /browser renderer/);
  const files = Object.keys(result.metafile.inputs);
  assert.ok(
    files.some((file) => file.endsWith("experiment/node_modules/dompurify/dist/purify.es.mjs")),
  );
  assert.ok(files.some((file) => file.endsWith("experiment/node_modules/pele/dist/pele.js")));
});

test("app.js renders the shell without a static path to the WASM runtimes", async (t) => {
  // Metafile paths are relative to the real dist path; tmpdir() can be a symlink.
  const dist = realpathSync(mkdtempSync(path.join(tmpdir(), "pages-viewer-split-")));
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  const result = await build({
    ...viewerBuildOptions(app, dist),
    write: false,
    logLevel: "silent",
  });
  const { chunks, preloads, styles } = viewerSplit(result.metafile);
  const { outputs } = result.metafile;
  // Inputs relative to the app; plugin namespaces such as wasm-ready: stay as is.
  const local = (input) =>
    /^[\w-]+:/.test(input) ? input : path.relative(app, path.resolve(dist, input));
  const inputsOf = (files) => files.flatMap((file) => Object.keys(outputs[file].inputs).map(local));
  const shell = inputsOf(["public/app.js", ...preloads]);
  for (const editorOnly of [
    "wasm-ready:pages-wasm-ready",
    "viewer/session.mjs",
    "viewer/local-pages.mjs",
    "viewer/WordgardEditor.jsx",
  ])
    assert.equal(shell.includes(editorOnly), false, editorOnly);
  for (const shellInput of ["viewer/main.jsx", "viewer/local-catalog.mjs"])
    assert.ok(shell.includes(shellInput), shellInput);
  // The shell lists local Pages through the byte store's own file, not the
  // package index that also loads the Subduction glue.
  assert.equal(
    shell.some((input) => /automerge-repo-subduction[/]dist[/]index[.]js$/.test(input)),
    false,
  );
  const [editor] = chunks.filter(
    (file) => local(outputs[file].entryPoint ?? "") === "viewer/page-editor.mjs",
  );
  assert.ok(editor, "page-editor.mjs is its own chunk");
  assert.ok(inputsOf([editor]).includes("wasm-ready:pages-wasm-ready"));
  assert.deepEqual(
    outputs["public/app.js"].imports.filter((item) => item.kind === "dynamic-import"),
    [{ path: editor, kind: "dynamic-import" }],
  );
  assert.ok(chunks.every((file) => VIEWER_CHUNK.test(file)));
  // CSS from the editor chunk is already in app.css, in the shell's import order.
  const css = (file) => result.outputFiles.find((output) => output.path === path.join(dist, file));
  for (const file of styles) assert.ok(stylesCovered(css(file).text, css("public/app.css").text));
});

test("the viewer split check refuses a shell that waits for WASM or an unexpected output", () => {
  const output = (inputs, imports = []) => ({ inputs, imports, bytes: 1 });
  const split = (outputs) => viewerSplit({ inputs: {}, outputs });
  const lazy = { path: "public/chunks/EDITOR23.js", kind: "dynamic-import" };
  assert.deepEqual(
    split({
      "public/app.js": output({ "../viewer/main.jsx": {} }, [
        { path: "public/chunks/SHARED23.js", kind: "import-statement" },
        lazy,
      ]),
      "public/chunks/SHARED23.js": output({ "../viewer/store.mjs": {} }),
      "public/chunks/EDITOR23.js": output({ "wasm-ready:pages-wasm-ready": {} }, [
        { path: "public/chunks/SHARED23.js", kind: "import-statement" },
      ]),
      "public/chunks/EDITOR23.css": output({}),
      "public/app.css": output({}),
    }),
    {
      chunks: ["public/chunks/EDITOR23.js", "public/chunks/SHARED23.js"],
      preloads: ["public/chunks/SHARED23.js"],
      styles: ["public/chunks/EDITOR23.css"],
    },
  );
  assert.throws(
    () =>
      split({
        "public/app.js": output({}, [
          { path: "public/chunks/SHARED23.js", kind: "import-statement" },
        ]),
        "public/chunks/SHARED23.js": output({ "wasm-entry:@automerge/automerge": {} }),
      }),
    /must not import the WASM runtimes statically/,
  );
  assert.throws(
    () =>
      split({
        "public/app.js": output({}, [lazy]),
        "public/chunks/EDITOR23.js": output({}),
        "public/editor.js": output({}),
      }),
    /Unexpected viewer output public[/]editor[.]js/,
  );
  assert.throws(
    () => split({ "public/app.js": output({}), "public/app.css": output({}) }),
    /must split the editor/,
  );
});

test("index.html preloads exactly the chunks app.js imports", () => {
  const source = readFileSync(path.join(app, "viewer/index.html"), "utf8");
  const html = withModulePreloads(source, ["public/chunks/SHARED23.js"]);
  const stylesheet = '<link rel="stylesheet" href="/app.css" />';
  const preload = '<link rel="modulepreload" href="/chunks/SHARED23.js" />';
  assert.equal(html.split(preload).length, 2);
  assert.ok(html.indexOf(stylesheet) < html.indexOf(preload));
  assert.ok(html.indexOf(preload) < html.indexOf('<link rel="preload" href="/automerge.wasm"'));
  assert.equal(withModulePreloads(source, []), source);
  assert.throws(() => withModulePreloads(html, []), /must not list chunk preloads/);
  assert.throws(() => withModulePreloads(source, ["public/app.js"]), /Unexpected viewer preload/);
  assert.throws(() => withModulePreloads("<html></html>", []), /exactly once/);
  assert.equal(stylesCovered(".a{color:red}", ".b{x:y}.a{color:red}"), true);
  assert.equal(stylesCovered(".a{color:red}.c{x:z}", ".b{x:y}.a{color:red}"), false);
});

test("each shell asset ships under a name derived from its sha256", () => {
  // RFC 4648 base32 of the digest's first five bytes.
  assert.equal(digestHash("cb9b79c6ba" + "0".repeat(54)), "ZONXTRV2");
  assert.equal(digestHash("00".repeat(32)), "AAAAAAAA");
  assert.equal(digestHash("ff".repeat(32)), "77777777");
  assert.throws(() => digestHash("ab"), /sha256/);
  const bytes = Buffer.from("console.log('shell')");
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(hashedAssetPath("app.js", bytes), `public/app-${digestHash(digest)}.js`);
  assert.equal(
    hashedAssetPath("automerge.wasm", bytes),
    `public/automerge-${digestHash(digest)}.wasm`,
  );
  assert.notEqual(hashedAssetPath("app.js", bytes), hashedAssetPath("app.js", "changed"));
  assert.throws(() => hashedAssetPath("connect.js", bytes), /Unknown viewer asset/);
  for (const name of VIEWER_ASSETS)
    assert.deepEqual(viewerAsset(hashedAssetPath(name, bytes)), { name, hash: digestHash(digest) });
  for (const file of [
    "public/app.js",
    "public/app-abcdefgh.js",
    "public/app-ABCDEFGH.wasm",
    "public/theme-ABCDEFGH.css",
    "public/connect-ABCDEFGH.js",
    "public/chunks/app-ABCDEFGH.js",
    "public/app-ABCDEFGHI.js",
  ])
    assert.equal(viewerAsset(file), null, file);
});

test("index.html names every shell asset by its hashed file", () => {
  const source = readFileSync(path.join(app, "viewer/index.html"), "utf8");
  const assets = Object.fromEntries(
    VIEWER_ASSETS.map((name) => [name, hashedAssetPath(name, name)]),
  );
  const url = (name) => "/" + assets[name].slice("public/".length);
  const html = withHashedAssets(withModulePreloads(source, ["public/chunks/SHARED23.js"]), assets);
  for (const [name, attribute] of [
    ["theme.js", "src"],
    ["app.css", "href"],
    ["automerge.wasm", "href"],
    ["subduction.wasm", "href"],
    ["app.js", "src"],
  ]) {
    assert.equal(html.split(`${attribute}="${url(name)}"`).length, 2, name);
    assert.equal(html.includes(`"/${name}"`), false, name);
  }
  // Mermaid loads from the editor chunk, never from index.html.
  assert.equal(html.includes("mermaid"), false);
  assert.ok(html.includes('<link rel="modulepreload" href="/chunks/SHARED23.js" />'));
  assert.ok(html.indexOf(url("theme.js")) < html.indexOf(url("app.css")));
  assert.throws(
    () => withHashedAssets(source, { ...assets, "app.js": "public/app.js" }),
    /Expected a hashed app[.]js/,
  );
  assert.throws(
    () => withHashedAssets(source, { ...assets, "app.css": assets["theme.js"] }),
    /Expected a hashed app[.]css/,
  );
  assert.throws(() => withHashedAssets(html, assets), /reference [/]theme[.]js exactly once/);
});

test("index.html inlines the nteract app icon as its tab icon", () => {
  const icon = readFileSync(path.join(app, "../../../../../crates/notebook/icons/32x32.png"));
  assert.equal(FAVICON_HREF, "data:image/png;base64," + icon.toString("base64"));
  const source = readFileSync(path.join(app, "viewer/index.html"), "utf8");
  const html = withInlineFavicon(source);
  assert.equal(
    html.split(`<link rel="icon" type="image/png" sizes="32x32" href="${FAVICON_HREF}" />`).length,
    2,
  );
  assert.equal(html.includes("/favicon.png"), false);
  assert.throws(() => withInlineFavicon(html), /reference [/]favicon[.]png exactly once/);
  assert.throws(() => withInlineFavicon(source, "/favicon.ico"), /PNG data URL/);
});

test("_headers caches exactly the hashed files as immutable", () => {
  assert.equal(IMMUTABLE, "public, max-age=31536000, immutable");
  const assets = VIEWER_ASSETS.map((name) => hashedAssetPath(name, name));
  const headers = headersFile(
    ["X-Content-Type-Options: nosniff"],
    ["public/chunks/ABCDEFGH.js", ...assets],
  );
  const [all, ...rules] = headers.split(/\n(?=\/)/);
  assert.equal(all, "/*\n  X-Content-Type-Options: nosniff");
  assert.deepEqual(
    rules.map((rule) => rule.trim()),
    ["/chunks/ABCDEFGH.js", ...assets.map((file) => file.slice("public".length))]
      .sort()
      .map((url) => `${url}\n  Cache-Control: ${IMMUTABLE}`),
  );
  // No wildcard: the single-page fallback for a retired name must stay
  // revalidated, not cached for a year.
  assert.equal(headers.includes("*\n  Cache-Control"), false);
  for (const file of [
    "public/index.html",
    "public/connect.js",
    "public/app.js",
    "public/chunks/x.js",
  ])
    assert.throws(() => headersFile([], [file]), /Not a hashed viewer file/, file);
});

test("the Worker's own pages load the hashed theme and stylesheet", async () => {
  const files = VIEWER_ASSETS.map((name) => hashedAssetPath(name, name));
  const define = shellAssetDefine(["public/index.html", ...files]);
  const theme = files.find((file) => file.startsWith("public/theme-"));
  const styles = files.find((file) => file.startsWith("public/app-") && file.endsWith(".css"));
  assert.deepEqual(define, {
    __PAGES_THEME_SCRIPT__: JSON.stringify(theme.slice("public".length)),
    __PAGES_STYLESHEET__: JSON.stringify(styles.slice("public".length)),
  });
  assert.throws(() => shellAssetDefine(files.filter((file) => file !== theme)), /one hashed theme/);
  const result = await build({
    entryPoints: [path.join(app, "shared/shell-assets.mjs")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    define,
  });
  const bundled = await import(
    "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64")
  );
  assert.deepEqual(
    [bundled.THEME_SCRIPT, bundled.STYLESHEET],
    [theme.slice("public".length), styles.slice("public".length)],
  );
  // Unbundled code keeps the source names.
  const shell = await import("../shared/shell-assets.mjs");
  assert.deepEqual([shell.THEME_SCRIPT, shell.STYLESHEET], ["/theme.js", "/app.css"]);
});

test("the editor imports Mermaid from the URL the build passes", async () => {
  const result = await build({
    stdin: {
      contents: `export const loadDiagram = () => import(${JSON.stringify(mermaidSource(app))});`,
      resolveDir: app,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022",
    plugins: [browserMermaidPlugin(app, "/mermaid-ABCDEFGH.js")],
  });
  assert.match(result.outputFiles[0].text, /import\("\/mermaid-ABCDEFGH\.js"\)/);
});
