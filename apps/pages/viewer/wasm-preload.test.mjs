// Where the Automerge WASM preload goes: theme.js adds it on routes that open
// a document, and nowhere else; the editor loader adds it when it starts.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { BROWSER_WASM_URLS, wasmUrlDefine } from "../scripts/browser-wasm.mjs";
import { readPageRoute } from "../shared/routes.mjs";
import { AUTOMERGE_WASM_URL, opensDocument, preloadWasm } from "./wasm-preload.mjs";

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

test("Pages and Project content open a document; listings and other paths don't", () => {
  for (const path of [
    `/p/${pageId}`,
    `/p/${pageId}/roadmap`,
    `/?page=${pageId}`,
    `/project/${projectId}`,
  ])
    assert.equal(opensDocument(readPageRoute(path)), true, path);
  for (const path of ["/", "/?show=shared", "/pages", "/projects", "/connect", "/oauth/authorize"])
    assert.equal(opensDocument(readPageRoute(path)), false, path);
  assert.equal(opensDocument(null), false);
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

test("a listing's idle start preloads the WASM at low fetch priority", () => {
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

test("theme.js preloads the WASM in <head> on a route that opens a document", () => {
  for (const path of [`/p/${pageId}/roadmap`, `/?page=${pageId}`, `/project/${projectId}`])
    assert.deepEqual(
      headAfterTheme(path),
      [{ href: HASHED, as: "fetch", crossorigin: "anonymous", priority: null }],
      path,
    );
});

test("theme.js leaves the WASM to the editor start on listings and the Worker's pages", () => {
  for (const path of ["/", "/?show=shared&group=project", "/pages", "/projects", "/connect"])
    assert.deepEqual(headAfterTheme(path), [], path);
});
