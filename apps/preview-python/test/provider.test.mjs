import test from "node:test";
import assert from "node:assert/strict";
import { startProviderFixture } from "./provider-fixture.mjs";

test(
  "real celld private provider owns sessions in its Durable Object",
  { timeout: 90000 },
  async (t) => {
    const server = await startProviderFixture();
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
    const directory = await post("/execute", {
      ...identity,
      execution: { execution_id: "cwd", source: "import os\nos.getcwd()" },
    });
    assert.equal(directory.outputs.at(-1).data["text/plain"], "'/home/pyodide'");
    await post("/close", identity);
    const replacement = await post("/open", { ...identity, sessionId: "2" });
    assert.notEqual(first.info.instanceId, replacement.info.instanceId);
    const fresh = await post("/execute", {
      ...identity,
      sessionId: "2",
      execution: { execution_id: "e3", source: "'saved' in globals()" },
    });
    assert.equal(fresh.outputs.at(-1).data["text/plain"], "False");
    const executing = fetch(server.url + "/execute", {
      method: "POST",
      body: JSON.stringify({
        ...identity,
        sessionId: "2",
        execution: {
          execution_id: "interrupted",
          source: "import asyncio\nawait asyncio.sleep(60)",
        },
      }),
      signal: AbortSignal.timeout(40000),
    });
    // Let the request enter Python before destroying the interpreter.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await post("/close", { ...identity, sessionId: "2" });
    assert.equal((await executing).status, 409);
    const afterInterrupt = await post("/open", { ...identity, sessionId: "3" });
    assert.notEqual(afterInterrupt.info.instanceId, replacement.info.instanceId);
    const continued = await post("/execute", {
      ...identity,
      sessionId: "3",
      execution: { execution_id: "after-interrupt", source: "40 + 2" },
    });
    assert.equal(continued.outputs.at(-1).data["text/plain"], "42");
    await post("/close", { ...identity, sessionId: "3" });
  },
);
