import test from "node:test";
import assert from "node:assert/strict";
import { startProviderFixture } from "./provider-fixture.mjs";

test(
  "guest JavaScript global tampering cannot prevent session termination",
  { timeout: 120000 },
  async (t) => {
    const server = await startProviderFixture();
    t.after(server.close);
    async function post(path, sessionId, execution) {
      const response = await fetch(server.url + path, {
        method: "POST",
        body: JSON.stringify({
          ownerPrincipal: "tamper",
          notebookId: sessionId,
          sessionId,
          execution,
        }),
        signal: AbortSignal.timeout(40000),
      });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      return JSON.parse(body);
    }
    const attacks = [
      "import js\njs.globalThis.URL = None\n42",
      "import js\nfrom pyodide.ffi import create_proxy, to_js\ndef poisoned_path():\n    raise RuntimeError('Python runtime invalidated after execution termination; recreate the worker')\njs.Object.defineProperty(js.URL.prototype, 'pathname', to_js({'get': create_proxy(poisoned_path)}))\n42",
    ];
    // More replacements than deployment capacity prove disposal releases slots.
    for (let i = 0; i < 5; i++) {
      const id = `tampered-${i}`;
      await post("/open", id);
      const result = await post("/execute", id, {
        execution_id: "poison",
        source: attacks[i % attacks.length],
      });
      assert.equal(result.success, true);
      assert.equal(result.outputs.at(-1).data["text/plain"], "42");
      await post("/close", id);
    }
    await post("/open", "replacement");
    const fresh = await post("/execute", "replacement", {
      execution_id: "fresh",
      source: "40 + 2",
    });
    assert.equal(fresh.outputs.at(-1).data["text/plain"], "42");
    await post("/close", "replacement");
  },
);
