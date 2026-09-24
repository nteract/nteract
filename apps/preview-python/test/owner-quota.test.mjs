import test from "node:test";
import assert from "node:assert/strict";
import { startProviderFixture } from "./provider-fixture.mjs";

test(
  "real provider limits each owner while other owners retain capacity",
  { timeout: 120000 },
  async (t) => {
    const server = await startProviderFixture();
    t.after(server.close);
    async function post(path, ownerPrincipal, sessionId, execution, expected = 200) {
      const response = await fetch(server.url + path, {
        method: "POST",
        body: JSON.stringify({ ownerPrincipal, notebookId: sessionId, sessionId, execution }),
        signal: AbortSignal.timeout(40000),
      });
      const body = await response.text();
      assert.equal(response.status, expected, body);
      return JSON.parse(body);
    }
    await post("/open", "alice", "1");
    await post("/open", "alice", "2");
    const denied = await post("/open", "alice", "3", undefined, 409);
    assert.match(denied.error, /Your Python session limit/);
    await post("/open", "bob", "1");
    await post("/open", "bob", "2");
    const results = await Promise.all(
      ["alice", "bob"].flatMap((owner) =>
        ["1", "2"].map((id) =>
          post("/execute", owner, id, {
            cell_id: "test-cell",
            execution_id: "check",
            source: "40 + 2",
          }),
        ),
      ),
    );
    assert.ok(results.every((result) => result.outputs.at(-1).data["text/plain"] === "42"));
    await post("/close", "alice", "1");
    await post("/open", "alice", "3");
    for (const [owner, ids] of [
      ["alice", ["2", "3"]],
      ["bob", ["1", "2"]],
    ])
      for (const id of ids) await post("/close", owner, id);
  },
);
