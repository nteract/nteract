import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, Script } from "node:vm";
import { transform } from "esbuild";

test("bundled Pyodide detects its lexical worker environment without changing host globals", async () => {
  const source = await readFile(new URL("../dist/session.js", import.meta.url), "utf8");
  const { code } = await transform(source, { format: "cjs", logLevel: "silent" });
  const hostWasm = Object.create(WebAssembly);
  const context = createContext({
    module: { exports: {} },
    WebAssembly: hostWasm,
    TextDecoder,
    TextEncoder,
    URL,
    Response,
    crypto: globalThis.crypto,
    atob,
    btoa,
    require(specifier) {
      if (specifier === "cloudflare:workers") return { WorkerEntrypoint: class {} };
      if (/^\.\/(?:pyodide\.asm|sentinel|library-[^/]+)\.wasm$/.test(specifier))
        return new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      throw new Error(`Unexpected host dependency: ${specifier}`);
    },
  });
  new Script(`(function () { ${code} })()`).runInContext(context, { timeout: 5000 });
  assert.equal(typeof context.module.exports.default.fetch, "function");
  assert.equal(typeof context.module.exports.RuntimeControl, "function");
  assert.equal(context.self, undefined);
  assert.equal(context.WorkerGlobalScope, undefined);
  assert.equal(context.importScripts, undefined);
  assert.equal(context.WebAssembly, hostWasm);
  assert.equal(hostWasm.compile, WebAssembly.compile);
});
