import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BufferedRecordStore,
  PageRecords,
  RemoteRecordSink,
  encodeRecordBatch,
  decodeRecordBatch,
} from "./record-persistence.mjs";
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
class Storage {
  values = new Map();
  barrier;
  puts = 0;
  async put(values) {
    this.puts++;
    for (const [key, value] of Object.entries(values)) this.values.set(key, value.slice());
  }
  async delete(keys) {
    for (const key of keys) this.values.delete(key);
  }
  async sync() {
    await this.barrier?.promise;
  }
  async list({ prefix, startAfter = "", limit }) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .filter(([key]) => key.startsWith(prefix) && key > startAfter)
        .slice(0, limit),
    );
  }
}
function fixture(options) {
  const storage = new Storage();
  const owner = new PageRecords({ storage });
  const sink = new RemoteRecordSink({ fetch: (request) => owner.fetch(request) });
  const live = new BufferedRecordStore(sink, options);
  return { storage, owner, sink, live };
}
const bytes = (value) => new TextEncoder().encode(value);

test("live reads and edits proceed while remote persistence is held; flush waits for durability", async () => {
  const f = fixture();
  await f.live.save("tree/first", bytes("one"));
  assert.equal(f.storage.values.size, 0);
  f.storage.barrier = deferred();
  const saving = f.live.flush();
  let saved = false;
  void saving.then(() => {
    saved = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.storage.puts, 1);
  assert.equal(saved, false);
  await f.live.save("tree/second", bytes("two"));
  assert.deepEqual(await f.live.load("tree/first"), bytes("one"));
  assert.deepEqual(await f.live.load("tree/second"), bytes("two"));
  assert.equal(saved, false);
  f.storage.barrier.resolve();
  await saving;
  assert.equal(f.live.dirty, true);
  await f.live.flush();
  const reopened = new BufferedRecordStore(f.sink);
  assert.deepEqual(await reopened.load("tree/second"), bytes("two"));
  assert.equal(f.live.dirty, false);
});

test("ambiguous persistence failure retains edits, newer replacements, and deletions for retry", async () => {
  const f = fixture();
  await f.live.save("tree/a", bytes("old"));
  await f.live.save("tree/b", bytes("remove"));
  f.storage.barrier = deferred();
  const saving = f.live.flush();
  const failed = assert.rejects(saving, /persist/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await f.live.save("tree/a", bytes("new"));
  await f.live.remove("tree/b");
  f.storage.barrier.reject(Error("bucket unavailable"));
  await failed;
  assert.equal(f.live.dirty, true);
  f.storage.barrier = undefined;
  await f.live.flush();
  const reopened = new BufferedRecordStore(f.sink);
  assert.deepEqual(await reopened.load("tree/a"), bytes("new"));
  assert.equal(await reopened.load("tree/b"), undefined);
});

test("batched persistence and paginated restore retain600 records without altering host metadata", async () => {
  const f = fixture();
  f.storage.values.set("host/private", bytes("control"));
  for (let i = 0; i < 600; i++)
    await f.live.save(`tree/${i.toString().padStart(4, "0")}`, bytes(String(i)));
  assert.equal(f.storage.puts, 0);
  await f.live.flush();
  assert.equal(f.storage.puts, 5);
  const reopened = new BufferedRecordStore(f.sink);
  assert.equal((await reopened.list("")).length, 600);
  assert.deepEqual(await reopened.load("tree/0599"), bytes("599"));
  assert.deepEqual(f.storage.values.get("host/private"), bytes("control"));
});

test("large native records stay binary and are split below request limits", async () => {
  const f = fixture();
  const value = new Uint8Array(1_850_000).fill(7);
  await f.live.save("tree/a", value);
  await f.live.save("tree/b", value);
  value.fill(9);
  await f.live.flush();
  assert.equal(f.storage.puts, 2);
  const reopened = new BufferedRecordStore(f.sink);
  const loaded = await reopened.load("tree/a");
  assert.equal(loaded[0], 7);
  loaded.fill(5);
  assert.equal((await reopened.load("tree/a"))[0], 7);
  assert.equal((await reopened.list("")).length, 2);
});

test("capacity rejects before replacing accepted data; failed restore never exposes a partial replica", async () => {
  const f = fixture({ maxBytes: 12 });
  await f.live.save("key", bytes("123456789"));
  await assert.rejects(f.live.save("key", bytes("1234567890")), { status: 413 });
  assert.deepEqual(await f.live.load("key"), bytes("123456789"));
  await f.live.flush();
  const small = new BufferedRecordStore(f.sink, { maxBytes: 5 });
  await assert.rejects(small.load("key"), /capacity/);
});

test("malformed and conflicting batches never reach storage", async () => {
  const f = fixture();
  const request = (body) =>
    new Request("https://records.internal/records", { method: "POST", body });
  assert.equal((await f.owner.fetch(request(new Uint8Array([0, 0, 0])))).status, 400);
  const duplicate = encodeRecordBatch([
    ["key", bytes("a")],
    ["key", undefined],
  ]);
  assert.equal((await f.owner.fetch(request(duplicate))).status, 400);
  assert.equal(f.storage.puts, 0);
  const entries = [
    ["clé", new Uint8Array()],
    ["gone", undefined],
  ];
  assert.deepEqual(decodeRecordBatch(encodeRecordBatch(entries)), entries);
});
