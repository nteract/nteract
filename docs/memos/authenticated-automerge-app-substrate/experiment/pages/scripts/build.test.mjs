import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import { celldCborPlugin } from "./celld-cbor.mjs";
import { browserMermaidPlugin, mermaidSource } from "./browser-mermaid.mjs";

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
    write(
      "scripts/browser-wasm.mjs",
      readFileSync(new URL("./browser-wasm.mjs", import.meta.url), "utf8"),
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
    assert.equal(
      readFileSync(path.join(fixture, "dist/index.js"), "utf8"),
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
    ["theme-bootstrap.mjs", "theme.mjs"],
  );
  const classes = new Set();
  const root = {
    classList: { toggle: (name, enabled) => (enabled ? classes.add(name) : classes.delete(name)) },
    dataset: {},
    style: {},
  };
  vm.runInNewContext(output, {
    window: {
      document: { documentElement: root },
      localStorage: { getItem: (key) => (key === "nteract.pages.theme" ? "dark" : null) },
    },
  });
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
