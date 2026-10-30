import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setImmediate } from "node:timers/promises";
import { BROWSER_WASM_URLS, browserWasmPlugin } from "./browser-wasm.mjs";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

test("both WASM fetches start together and consumers wait for both real runtimes", async (t) => {
  for (const first of ["/automerge.wasm", "/subduction.wasm"]) {
    await t.test(`${first} responds first`, { timeout: 10_000 }, async (t) => {
      const directory = await mkdtemp(path.join(tmpdir(), "pages-wasm-startup-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const output = await build({
        stdin: {
          contents: `
            import * as A from "@automerge/automerge";
            import { MemorySigner } from "@automerge/subduction";
            const doc = A.from({ title: "Ready" });
            export const title = doc.title;
            A.free(doc);
            const signer = MemorySigner.fromBytes(new Uint8Array(32).fill(7));
            const peer = signer.peerId();
            export const peerId = peer.toString();
            peer.free();
            signer.free();
          `,
          resolveDir: app,
        },
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        target: "es2022",
        plugins: [browserWasmPlugin(app)],
      });
      const entry = path.join(directory, "entry.mjs");
      await writeFile(entry, output.outputFiles[0].contents);
      const wasm = new Map([
        ["/automerge.wasm", await readFile(require.resolve("@automerge/automerge/automerge.wasm"))],
        ["/subduction.wasm", await readFile(require.resolve("@automerge/subduction/wasm"))],
      ]);
      const requests = new Map();
      let started;
      const bothStarted = new Promise((resolve) => {
        started = resolve;
      });
      const originalFetch = globalThis.fetch;
      t.after(() => {
        globalThis.fetch = originalFetch;
      });
      globalThis.fetch = (url) => {
        assert.ok(wasm.has(url), `Unexpected fetch: ${url}`);
        assert.equal(requests.has(url), false, "Each runtime should initialize only once");
        const response = new Promise((resolve) => requests.set(url, resolve));
        if (requests.size === 2) started();
        return response;
      };
      let loaded = false;
      const loading = import(pathToFileURL(entry).href).then((module) => {
        loaded = true;
        return module;
      });
      // Neither request receives bytes until both have started. Sequential
      // top-level initialization would stall here with only one request.
      await Promise.race([bothStarted, loading]);
      assert.equal(requests.size, 2);
      const respond = (url) =>
        requests.get(url)(
          new Response(wasm.get(url), {
            headers: { "Content-Type": "application/wasm" },
          }),
        );
      respond(first);
      await setImmediate();
      assert.equal(loaded, false);
      respond(first === "/automerge.wasm" ? "/subduction.wasm" : "/automerge.wasm");
      const module = await loading;
      assert.equal(module.title, "Ready");
      assert.ok(module.peerId.length > 0);
    });
  }
});

test("the startup shell keeps agent guidance out of the JavaScript loading surface", async () => {
  const html = await readFile(path.join(app, "viewer/index.html"), "utf8");
  const nonScript = html.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1];
  assert.ok(nonScript);
  assert.match(nonScript, /href="\/connect"/);
  assert.match(nonScript, /href="\/llms.txt"/);
  assert.match(nonScript, /OAuth/);
  const visible = html.replace(/<noscript>[\s\S]*?<\/noscript>/g, "");
  assert.match(visible, /class="app-header"/);
  assert.match(visible, /role="status">Connecting…/);
  assert.match(visible, /rel="describedby" type="text\/plain" href="\/llms.txt"/);
  assert.doesNotMatch(visible, /Connecting an agent|API-key clients|Opening the editor/);
});

test("the startup shell preloads each runtime as the request the bundle reuses", async () => {
  const html = await readFile(path.join(app, "viewer/index.html"), "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  const preloads = [...head.matchAll(/<link rel="preload"([^>]*)>/g)].map(([, attributes]) => {
    const crossorigin = attributes.match(/\scrossorigin(?:="([^"]*)")?/);
    return {
      href: attributes.match(/href="([^"]*)"/)?.[1],
      as: attributes.match(/as="([^"]*)"/)?.[1],
      // fetch(url) is a CORS request with same-origin credentials. A preload
      // matches it only as crossorigin="anonymous" (or a bare crossorigin).
      // Without the attribute the preload is a no-cors request, and the
      // bundle's fetch downloads the file a second time.
      crossorigin: crossorigin ? crossorigin[1] || "anonymous" : null,
    };
  });
  assert.deepEqual(
    preloads,
    Object.values(BROWSER_WASM_URLS).map((href) => ({
      href,
      as: "fetch",
      crossorigin: "anonymous",
    })),
  );
});
