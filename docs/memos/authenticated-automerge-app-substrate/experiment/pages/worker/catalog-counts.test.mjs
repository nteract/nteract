import assert from "node:assert/strict";
import { test } from "node:test";
import { listAll } from "./catalog.mjs";
import { countCache, countedStorage } from "./catalog-counts.mjs";

/** One microtask turn, so concurrent callers interleave between reads. */
const yieldTurn = () => Promise.resolve();

/** Storage whose transactions stage their writes and apply them only when the
 * closure resolves. `retries` makes the next transaction run its closure that
 * many extra times, discarding each earlier attempt, as a storage retry
 * would. Every read yields a turn, so concurrent callers interleave. */
class TransactionalStorage {
  values = new Map();
  retries = 0;
  committed = 0;
  static view(base, staged) {
    const read = (key) => (staged.has(key) ? staged.get(key) : base.get(key));
    return {
      async get(key) {
        await yieldTurn();
        return structuredClone(read(key));
      },
      async put(key, value) {
        await yieldTurn();
        if (typeof key === "object") {
          for (const [name, entry] of Object.entries(key)) staged.set(name, structuredClone(entry));
          return;
        }
        staged.set(key, structuredClone(value));
      },
      async delete(key) {
        await yieldTurn();
        const keys = Array.isArray(key) ? key : [key];
        let removed = 0;
        for (const name of keys) {
          if (read(name) !== undefined) removed++;
          staged.set(name, undefined);
        }
        return Array.isArray(key) ? removed : removed > 0;
      },
      async list({ prefix = "", startAfter, limit = Infinity } = {}) {
        await yieldTurn();
        const keys = new Set([...base.keys(), ...staged.keys()]);
        return new Map(
          [...keys]
            .filter(
              (name) => name.startsWith(prefix) && (startAfter === undefined || name > startAfter),
            )
            .filter((name) => read(name) !== undefined)
            .sort()
            .slice(0, limit)
            .map((name) => [name, structuredClone(read(name))]),
        );
      },
    };
  }
  apply(staged) {
    for (const [key, value] of staged)
      if (value === undefined) this.values.delete(key);
      else this.values.set(key, value);
  }
  #direct(method, ...args) {
    const staged = new Map();
    return TransactionalStorage.view(this.values, staged)
      [method](...args)
      .then((result) => {
        this.apply(staged);
        return result;
      });
  }
  get(key) {
    return this.#direct("get", key);
  }
  put(key, value) {
    return this.#direct("put", key, value);
  }
  delete(key) {
    return this.#direct("delete", key);
  }
  list(options) {
    return this.#direct("list", options);
  }
  async transaction(run) {
    let retries = this.retries;
    this.retries = 0;
    for (;;) {
      const staged = new Map();
      const result = await run(TransactionalStorage.view(this.values, staged));
      if (retries-- > 0) continue;
      this.apply(staged);
      this.committed++;
      return result;
    }
  }
}

const stored = (raw) => [raw.values.get("host/count/active"), raw.values.get("host/count/trash")];
const scanned = async (raw) => [
  (await listAll(raw, "page/")).size,
  (await listAll(raw, "trash/")).size,
];
/** Storage with `pages` active entries and stored counts. */
async function seeded(pages = 3) {
  const raw = new TransactionalStorage();
  for (let index = 0; index < pages; index++) raw.values.set(`page/${index}`, { page_id: index });
  const storage = countedStorage(raw);
  await storage.rebuildCounts();
  assert.deepEqual(stored(raw), [pages, 0]);
  return { raw, storage };
}

test("the count cache machine covers every state and event", () => {
  const counts = { "page/": 1, "trash/": 0 };
  const states = {
    unloaded: { name: "unloaded" },
    loaded: { name: "loaded", counts },
    writingFromLoaded: { name: "writing", prior: { name: "loaded", counts } },
    writingFromUnloaded: { name: "writing", prior: { name: "unloaded" } },
    invalid: { name: "invalid" },
  };
  const next = { "page/": 2, "trash/": 0 };
  const table = {
    unloaded: {
      read: { name: "loaded", counts },
      begin: { name: "writing", prior: states.unloaded },
      commit: "no write holds the turn",
      commitNone: "no write holds the turn",
      fail: "no write holds the turn",
    },
    loaded: {
      read: { name: "loaded", counts },
      begin: { name: "writing", prior: states.loaded },
      commit: "no write holds the turn",
      commitNone: "no write holds the turn",
      fail: "no write holds the turn",
    },
    writingFromLoaded: {
      read: "a write holds the turn",
      begin: "a write already holds the turn",
      commit: { name: "loaded", counts: next },
      commitNone: states.loaded,
      fail: { name: "invalid" },
    },
    writingFromUnloaded: {
      read: "a write holds the turn",
      begin: "a write already holds the turn",
      commit: { name: "loaded", counts: next },
      // A write that never read the counts learns nothing about them.
      commitNone: { name: "unloaded" },
      fail: { name: "invalid" },
    },
    invalid: {
      read: { name: "loaded", counts },
      begin: { name: "writing", prior: states.invalid },
      commit: "no write holds the turn",
      commitNone: "no write holds the turn",
      fail: "no write holds the turn",
    },
  };
  const events = {
    read: { type: "read", counts },
    begin: { type: "begin" },
    commit: { type: "commit", counts: next },
    commitNone: { type: "commit", counts: undefined },
    fail: { type: "fail" },
  };
  for (const [stateName, row] of Object.entries(table))
    for (const [eventName, expected] of Object.entries(row)) {
      const result = countCache(states[stateName], events[eventName]);
      if (typeof expected === "string") {
        assert.equal(result.rejected, expected, `${stateName} × ${eventName}`);
        assert.equal(result.state, states[stateName]);
      } else assert.deepEqual(result, { state: expected }, `${stateName} × ${eventName}`);
    }
  assert.equal(countCache(states.loaded, { type: "other" }).rejected, "unknown event");
  // A read that found no stored counts is a loaded null.
  assert.deepEqual(countCache(states.unloaded, { type: "read", counts: null }), {
    state: { name: "loaded", counts: null },
  });
});

test("puts, deletes and transactions keep the counts equal to a scan", async () => {
  const raw = new TransactionalStorage();
  const storage = countedStorage(raw);
  // Before the counts are stored, writes leave them absent.
  await storage.put("page/a", {});
  assert.deepEqual(stored(raw), [undefined, undefined]);
  assert.equal(await storage.counts(), null);
  await storage.rebuildCounts();
  assert.deepEqual(stored(raw), [1, 0]);
  await storage.put({ "page/b": {}, "page/c": {}, "host/other": 1 });
  assert.deepEqual(stored(raw), [3, 0]);
  // Overwriting an existing key changes nothing.
  await storage.put("page/b", { title: "again" });
  assert.deepEqual(stored(raw), [3, 0]);
  await storage.transaction(async (transaction) => {
    await transaction.put("trash/b", {});
    await transaction.delete("page/b");
    // A nested transaction joins the outer one.
    await transaction.transaction((inner) => inner.put("trash/e", {}));
  });
  assert.deepEqual(stored(raw), [2, 2]);
  await storage.delete("page/missing");
  await storage.delete(["page/a", "trash/b", "trash/e"]);
  assert.deepEqual(stored(raw), [1, 0]);
  assert.deepEqual(await scanned(raw), stored(raw));
  assert.deepEqual(await storage.counts(), { "page/": 1, "trash/": 0 });
});

test("concurrent deletes of one key count it once", async () => {
  const { raw, storage } = await seeded(3);
  const results = await Promise.all([
    storage.delete("page/1"),
    storage.delete("page/1"),
    storage.delete(["page/1", "page/2"]),
  ]);
  assert.deepEqual(results, [true, false, 1]);
  assert.deepEqual(stored(raw), [1, 0]);
  assert.deepEqual(await scanned(raw), stored(raw));
  assert.deepEqual(await storage.counts(), { "page/": 1, "trash/": 0 });
});

test("a rolled-back transaction beside concurrent writes leaves the counts right", async () => {
  const { raw, storage } = await seeded(3);
  const writes = [
    storage.delete("page/0"),
    storage
      .transaction(async (transaction) => {
        await transaction.delete("page/1");
        await transaction.put("trash/1", {});
        throw new Error("rolled back");
      })
      .catch((error) => error.message),
    storage.delete("page/2"),
    storage.put("trash/x", {}),
  ];
  assert.deepEqual(await Promise.all(writes), [true, "rolled back", true, undefined]);
  assert.ok(raw.values.has("page/1"), "the rolled-back delete never landed");
  assert.deepEqual(stored(raw), [1, 1]);
  assert.deepEqual(await scanned(raw), stored(raw));
  assert.deepEqual(await storage.counts(), { "page/": 1, "trash/": 1 });
});

test("a failed write invalidates the cache and the next read loads storage", async () => {
  const { raw, storage } = await seeded(2);
  assert.deepEqual(await storage.counts(), { "page/": 2, "trash/": 0 });
  const put = raw.put.bind(raw);
  raw.put = async () => {
    throw new Error("storage refused");
  };
  // The put fails before a transaction exists, as an outage would.
  const transaction = raw.transaction.bind(raw);
  raw.transaction = async () => {
    throw new Error("storage refused");
  };
  await assert.rejects(storage.put("page/new", {}), /storage refused/);
  raw.put = put;
  raw.transaction = transaction;
  // Something else changed storage meanwhile; the invalid cache reads it.
  raw.values.set("host/count/active", 7);
  assert.deepEqual(await storage.counts(), { "page/": 7, "trash/": 0 });
});

test("a retried transaction counts its writes once", async () => {
  const { raw, storage } = await seeded(2);
  raw.retries = 2;
  let attempts = 0;
  await storage.transaction(async (transaction) => {
    attempts++;
    await transaction.put("page/new", {});
    await transaction.delete("page/0");
    await transaction.put("trash/0", {});
  });
  assert.equal(attempts, 3);
  assert.deepEqual(stored(raw), [2, 1]);
  assert.deepEqual(await scanned(raw), stored(raw));
  assert.deepEqual(await storage.counts(), { "page/": 2, "trash/": 1 });
  // A plain counted write retries the same way.
  raw.retries = 1;
  await storage.put("page/again", {});
  assert.deepEqual(stored(raw), [3, 1]);
  assert.deepEqual(await scanned(raw), stored(raw));
});

test("verifyCounts repairs counts and reports only a disagreement", async () => {
  const raw = new TransactionalStorage();
  raw.values.set("page/a", {});
  const storage = countedStorage(raw);
  // No stored counts: stored, but not reported as a repair.
  assert.equal(await storage.verifyCounts({ "page/": 1, "trash/": 0 }), false);
  assert.deepEqual(stored(raw), [1, 0]);
  assert.equal(await storage.verifyCounts({ "page/": 1, "trash/": 0 }), false);
  raw.values.set("page/b", {});
  assert.equal(await storage.verifyCounts({ "page/": 2, "trash/": 0 }), true);
  assert.deepEqual(await storage.counts(), { "page/": 2, "trash/": 0 });
});
