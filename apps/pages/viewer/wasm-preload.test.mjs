// When the editor starts at boot and at what priority (editorBoot), and where
// the Automerge WASM preload goes: theme.js adds it where the editor starts at
// boot; the editor loader adds it when it starts anywhere else.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { BROWSER_WASM_URLS, wasmUrlDefine } from "../scripts/browser-wasm.mjs";
import { readPageRoute } from "../shared/routes.mjs";
import { AUTOMERGE_WASM_URL, editorBoot, preloadWasm } from "./wasm-preload.mjs";

const pageId = "1a160b47-6df1-4983-81eb-489ca5a26812";
const projectId = "prj_2b160b47-6df1-4983-81eb-489ca5a26812";
const HASHED = "/automerge-ABCDEFGH.wasm";

const preloads = (page) =>
  [...page.head.querySelectorAll('link[rel="preload"]')].map((link) => ({
    href: link.getAttribute("href"),
    as: link.getAttribute("as"),
    crossorigin: link.getAttribute("crossorigin"),
    priority: link.getAttribute("fetchpriority"),
  }));

test("unbundled code preloads the source name the build hashes", () => {
  assert.equal(AUTOMERGE_WASM_URL, BROWSER_WASM_URLS.automerge);
  assert.deepEqual(wasmUrlDefine({ automerge: HASHED }), {
    __PAGES_AUTOMERGE_WASM_URL__: JSON.stringify(HASHED),
  });
});

const DOCUMENTS = [
  `/p/${pageId}`,
  `/p/${pageId}/roadmap`,
  `/?page=${pageId}`,
  `/project/${projectId}`,
];
const HOMES = ["/", "/?show=shared&group=project"];
const WAITING = ["/pages", "/projects", "/connect", "/oauth/authorize"];

test("a document starts the editor at boot, Home at low priority, and nothing else", () => {
  for (const path of DOCUMENTS)
    assert.deepEqual(editorBoot(readPageRoute(path)), { start: true, priority: null }, path);
  for (const path of HOMES)
    assert.deepEqual(editorBoot(readPageRoute(path)), { start: true, priority: "low" }, path);
  for (const path of WAITING)
    assert.deepEqual(editorBoot(readPageRoute(path)), { start: false, priority: null }, path);
  assert.deepEqual(editorBoot(null), { start: false, priority: null });
});

test("the preload is the CORS fetch the editor chunk reuses, added once", () => {
  const { window } = new JSDOM("<!doctype html><head></head><body></body>");
  assert.equal(preloadWasm(window.document, { url: HASHED }), true);
  assert.equal(
    preloadWasm(window.document, { url: HASHED, priority: "low" }),
    false,
    "a second call adds nothing",
  );
  // fetch(url) is a CORS request with same-origin credentials; a preload
  // matches it only as crossorigin="anonymous" (or a bare crossorigin).
  assert.deepEqual(preloads(window.document), [
    { href: HASHED, as: "fetch", crossorigin: "anonymous", priority: null },
  ]);
  assert.equal(preloadWasm(undefined, { url: HASHED }), false, "no document, nothing to do");
  window.close();
});

test("a low-priority preload says so", () => {
  const { window } = new JSDOM("<!doctype html><head></head><body></body>");
  assert.equal(preloadWasm(window.document, { url: HASHED, priority: "low" }), true);
  assert.deepEqual(preloads(window.document), [
    { href: HASHED, as: "fetch", crossorigin: "anonymous", priority: "low" },
  ]);
  window.close();
});

// theme.js as the build bundles it, with the hashed URL defined.
const themeScript = (
  await build({
    entryPoints: [fileURLToPath(new URL("./theme-bootstrap.mjs", import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    define: wasmUrlDefine({ automerge: HASHED }),
  })
).outputFiles[0].text;

/** Run theme.js in <head> at `path`, as the shell does, and read the head. */
function headAfterTheme(path) {
  const dom = new JSDOM(
    '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
    { url: `https://pages.test${path}`, runScripts: "outside-only" },
  );
  // The early session and connect requests never answer here.
  dom.window.fetch = () => new Promise(() => {});
  dom.window.eval(themeScript);
  const found = preloads(dom.window.document);
  dom.window.close();
  return found;
}

test("theme.js preloads the WASM in <head> where the editor starts at boot", () => {
  for (const [paths, priority] of [
    [DOCUMENTS, null],
    [HOMES, "low"],
  ])
    for (const path of paths)
      assert.deepEqual(
        headAfterTheme(path),
        [{ href: HASHED, as: "fetch", crossorigin: "anonymous", priority }],
        path,
      );
});

test("theme.js leaves the WASM to the first open on the index routes and the Worker's pages", () => {
  for (const path of WAITING) assert.deepEqual(headAfterTheme(path), [], path);
});
