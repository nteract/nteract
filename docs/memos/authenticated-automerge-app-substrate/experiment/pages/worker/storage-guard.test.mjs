import assert from "node:assert/strict";
import { test } from "node:test";
import { STORAGE_WRITES, guardContext, guardStorage, guardStub } from "./storage-guard.mjs";

/** Durable Object storage in memory, with every write method the guard
 * knows and a transaction that commits only if its closure succeeds. */
class Storage {
  values = new Map();
  async get(key) {
    return this.values.get(key);
  }
  async list() {
    return new Map(this.values);
  }
  async put(key, value) {
    this.values.set(key, value);
  }
  async delete(key) {
    return this.values.delete(key);
  }
  async deleteAll() {
    this.values.clear();
  }
  async sync() {}
  async setAlarm() {}
  async deleteAlarm() {}
  transactionSync(closure) {
    return closure();
  }
  async transaction(closure) {
    const draft = new Storage();
    draft.values = new Map(this.values);
    const result = await closure(draft);
    this.values = draft.values;
    return result;
  }
}

const gate = () => {
  const state = { error: undefined };
  return { state, refusal: () => state.error };
};

test("every write is refused once the gate closes, and reads pass", async () => {
  const raw = new Storage();
  const { state, refusal } = gate();
  const storage = guardStorage(raw, refusal);
  await storage.put("a", 1);
  assert.equal(await storage.get("a"), 1);
  state.error = Error("reset");
  for (const method of STORAGE_WRITES) {
    if (method === "transactionSync") {
      assert.throws(() => storage.transactionSync(() => {}), /reset/, method);
      continue;
    }
    await assert.rejects(storage[method]("a", 2), /reset/, method);
  }
  assert.equal(await storage.get("a"), 1, "nothing changed");
  assert.deepEqual([...(await storage.list())], [["a", 1]]);
});

test("a transaction open when the gate closes refuses its writes and rolls back", async () => {
  const raw = new Storage();
  const { state, refusal } = gate();
  const storage = guardStorage(raw, refusal);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const running = storage.transaction(async (txn) => {
    await txn.put("first", 1);
    await held;
    await txn.put("second", 2);
  });
  state.error = Error("reset");
  release();
  await assert.rejects(running, /reset/);
  assert.deepEqual([...raw.values], [], "rolled back");
});

test("a guarded context guards the storage it holds now, and passes everything else", async () => {
  const waited = [];
  const ctx = { storage: new Storage(), id: { name: "page" }, waitUntil: (p) => waited.push(p) };
  const { state, refusal } = gate();
  const guarded = guardContext(ctx, refusal);
  assert.equal(guarded.id.name, "page");
  guarded.waitUntil(1);
  assert.deepEqual(waited, [1]);
  state.error = Error("reset");
  await assert.rejects(guarded.storage.put("a", 1), /reset/);
  ctx.storage = new Storage();
  await assert.rejects(guarded.storage.delete("a"), /reset/, "a replaced storage is guarded too");
});

test("a guarded stub refuses every request but a GET", async () => {
  const sent = [];
  const stub = guardStub(
    { fetch: async (request) => (sent.push(request.method), new Response("ok")) },
    () => Error("reset"),
  );
  assert.equal(
    await (await stub.fetch(new Request("https://records.internal/records"))).text(),
    "ok",
  );
  await assert.rejects(
    stub.fetch(new Request("https://records.internal/lease", { method: "POST" })),
    /reset/,
  );
  assert.deepEqual(sent, ["GET"]);
});
