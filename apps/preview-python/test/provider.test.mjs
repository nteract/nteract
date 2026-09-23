import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { startCelld } from "./local-celld.mjs";

test(
  "real celld private provider owns sessions in its Durable Object",
  { timeout: 90000 },
  async (t) => {
    const bundle = await build({
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      external: ["cloudflare:workers"],
      stdin: {
        resolveDir: fileURLToPath(new URL("../dist/", import.meta.url)),
        contents: `import publicWorker from './provider.js'; export { PreviewPythonSessions, PackageAssets } from './provider.js';
      export default { fetch(request, env) {
        if(new URL(request.url).pathname === '/public') return publicWorker.fetch(request);
        return env.SESSIONS.get(env.SESSIONS.idFromName('test-deployment')).fetch(request);
      }};`,
      },
    });
    const server = await startCelld(
      { "index.js": bundle.outputFiles[0].text },
      {
        worker_loaders: [{ binding: "LOADER" }],
        durable_objects: { bindings: [{ name: "SESSIONS", class_name: "PreviewPythonSessions" }] },
        services: [
          { binding: "PACKAGES", service: "python-runtime-probe", entrypoint: "PackageAssets" },
        ],
      },
    );
    t.after(server.close);
    assert.equal((await fetch(server.url + "/public")).status, 404);
    assert.equal((await (await fetch(server.url + "/health")).json()).provider, "celld-pyodide");
    const identity = { ownerPrincipal: "owner", notebookId: "notebook", sessionId: "1" };
    async function post(path, body) {
      const response = await fetch(server.url + path, {
        method: "POST",
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(40000),
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      return JSON.parse(text);
    }
    const first = await post("/open", identity);
    const result = await post("/execute", {
      ...identity,
      execution: { execution_id: "e1", source: "saved = 41\nsaved + 1" },
    });
    assert.equal(result.outputs.at(-1).data["text/plain"], "42");
    const persisted = await post("/execute", {
      ...identity,
      execution: { execution_id: "e2", source: "saved" },
    });
    assert.equal(persisted.outputs.at(-1).data["text/plain"], "41");
    await post("/close", identity);
    const replacement = await post("/open", { ...identity, sessionId: "2" });
    assert.notEqual(first.info.instanceId, replacement.info.instanceId);
    const fresh = await post("/execute", {
      ...identity,
      sessionId: "2",
      execution: { execution_id: "e3", source: "'saved' in globals()" },
    });
    assert.equal(fresh.outputs.at(-1).data["text/plain"], "False");
    await post("/close", { ...identity, sessionId: "2" });
  },
);
