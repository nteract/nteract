import test from "node:test";
import assert from "node:assert/strict";
import { SessionPool } from "../src/session-pool.js";
import { createProviderService } from "../src/provider-service.js";

test("session inspection and resume never allocate and retain a surviving interpreter", async () => {
  let created = 0;
  const pool = new SessionPool({
    warmCount: 0,
    create: async () => ({ info: { id: ++created }, dispose: async () => {} }),
  });
  const service = createProviderService(pool);
  const identity = { ownerPrincipal: "alice", notebookId: "n", sessionId: "s" };
  const post = (path, extra = {}) =>
    service.fetch(
      new Request(`https://private.invalid${path}`, {
        method: "POST",
        body: JSON.stringify({ ...identity, ...extra }),
      }),
    );
  assert.deepEqual(await (await post("/status")).json(), { alive: false });
  assert.equal((await post("/open", { resumeOnly: true })).status, 409);
  assert.equal(created, 0);
  const opened = await (await post("/open")).json();
  assert.deepEqual(await (await post("/status")).json(), { alive: true });
  assert.deepEqual(await (await post("/status", { ownerPrincipal: "bob" })).json(), {
    alive: false,
  });
  assert.deepEqual(await (await post("/open", { resumeOnly: true })).json(), opened);
  assert.equal(created, 1);
  // Loss between a successful probe and reattachment must not silently start
  // an empty interpreter under the old generation.
  await pool.release(JSON.stringify(Object.values(identity)));
  assert.deepEqual(await (await post("/status")).json(), { alive: false });
  assert.equal((await post("/open", { resumeOnly: true })).status, 409);
  assert.equal(created, 1);
  await pool.close();
});

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

test("streamed /execute forwards live events and ends with the result or an error", async () => {
  let fail = false;
  const pool = new SessionPool({
    maxSessions: 1,
    warmCount: 0,
    create: async () => ({
      info: {},
      execute: async (execution, options) => {
        options?.onLive?.({ type: "stream", name: "stdout", text: "tick\n" });
        if (fail) throw new Error("boom");
        return { execution_id: execution.execution_id, success: true, outputs: [] };
      },
      dispose: async () => {},
    }),
  });
  const service = createProviderService(pool);
  const identity = { ownerPrincipal: "alice", notebookId: "n", sessionId: "s" };
  const request = (path, input) =>
    service.fetch(
      new Request("https://private.invalid" + path, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  await request("/open", identity);
  const lines = async (response) =>
    (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const streamed = await request("/execute", {
    ...identity,
    execution: { cell_id: "c", execution_id: "e1" },
    stream: true,
  });
  assert.equal(streamed.headers.get("content-type"), "application/x-ndjson");
  const events = await lines(streamed);
  assert.deepEqual(events[0], { type: "stream", name: "stdout", text: "tick\n" });
  assert.equal(events.at(-1).type, "result");
  assert.equal(events.at(-1).result.execution_id, "e1");
  fail = true;
  const failed = await lines(
    await request("/execute", {
      ...identity,
      execution: { cell_id: "c", execution_id: "e2" },
      stream: true,
    }),
  );
  assert.equal(failed.at(-1).type, "error");
  assert.match(failed.at(-1).error, /boom/);
  await pool.close();
});
