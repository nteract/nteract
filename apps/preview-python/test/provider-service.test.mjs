import test from "node:test";
import assert from "node:assert/strict";
import { SessionPool } from "../src/session-pool.js";
import { createProviderService } from "../src/provider-service.js";

test("private service requires explicit allocation and separates owner/notebook/session authority", async () => {
  let next = 0;
  const pool = new SessionPool({
    maxSessions: 3,
    warmCount: 0,
    create: async () => {
      const id = ++next;
      return { info: { id }, execute: async () => ({ id }), dispose: async () => {} };
    },
  });
  const service = createProviderService(pool);
  const request = (path, input) =>
    service.fetch(
      new Request("https://private.invalid" + path, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  const identity = { ownerPrincipal: "alice", notebookId: "n", sessionId: "s" };
  assert.equal(
    (
      await request("/execute", {
        ...identity,
        execution: { cell_id: "test-cell", execution_id: "e" },
      })
    ).status,
    409,
  );
  const first = await (await request("/open", identity)).json();
  const again = await (await request("/open", identity)).json();
  assert.deepEqual(first, again);
  const other = await (await request("/open", { ...identity, ownerPrincipal: "bob" })).json();
  assert.notDeepEqual(first, other);
  assert.equal((await request("/open", { ...identity, ownerPrincipal: "" })).status, 400);
  await request("/close", identity);
  const fresh = await (await request("/open", { ...identity, sessionId: "s2" })).json();
  assert.notDeepEqual(first, fresh);
  await pool.close();
});

test("release fences survive provider reconstruction and reject close-before-open", async () => {
  const values = new Map();
  const storage = {
    get: async (key) => values.get(key),
    put: async (key, value) => {
      values.set(key, value);
    },
  };
  let created = 0;
  const pool = new SessionPool({
    warmCount: 0,
    create: async () => ({ info: { id: ++created }, dispose: async () => {} }),
  });
  let service = createProviderService(pool, storage);
  const identity = { ownerPrincipal: "alice", notebookId: "n", sessionId: "released" };
  const post = (path, body = identity) =>
    service.fetch(
      new Request(`https://private.invalid${path}`, { method: "POST", body: JSON.stringify(body) }),
    );
  assert.equal((await post("/close")).status, 200);
  service = createProviderService(pool, storage);
  assert.equal((await post("/open")).status, 409);
  assert.equal(created, 0);
  assert.equal((await post("/open", { ...identity, sessionId: "new-generation" })).status, 200);
  assert.equal(created, 1);
  await pool.close();
});
