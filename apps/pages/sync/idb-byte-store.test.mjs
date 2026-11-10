import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { AutomergeSyncBackend } from "./backend.mjs";
import { DocStore } from "./doc-store.mjs";
import { IdbByteStore } from "./idb-byte-store.mjs";
import { newId } from "./test-helpers.mjs";

test("the IndexedDB byte store round-trips, lists by prefix and removes", async () => {
  const store = new IdbByteStore(`t-${newId()}`);
  await store.saveMany([
    ["sync/a/m", new Uint8Array([1])],
    ["sync/a/o/1/0", new Uint8Array([2, 3])],
    ["other", new Uint8Array([4])],
  ]);
  assert.deepEqual(await store.load("sync/a/o/1/0"), new Uint8Array([2, 3]));
  assert.deepEqual(await store.list("sync/"), ["sync/a/m", "sync/a/o/1/0"]);
  await store.remove("sync/a/m");
  assert.equal(await store.load("sync/a/m"), undefined);
  await store.destroy();
});

test("a backend over IndexedDB reopens its document", async () => {
  const name = `t-${newId()}`;
  const id = newId();
  const doc = A.change(A.from({ n: 1 }), (d) => (d.n = 2));
  const first = await AutomergeSyncBackend.load({
    store: new DocStore(new IdbByteStore(name)),
  });
  for (const blob of A.getAllChanges(doc)) {
    const c = A.decodeChange(blob);
    await first.store(id, [{ kind: "commit", id: c.hash, parents: [...c.deps].sort(), blob }]);
  }
  await first.close();
  const second = await AutomergeSyncBackend.load({
    store: new DocStore(new IdbByteStore(name)),
  });
  const { value } = await second.open(id).events[Symbol.asyncIterator]().next();
  assert.equal(A.load(value.records[0].blob).n, 2);
  await second.close();
});
