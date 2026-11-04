import assert from "node:assert/strict";
import { test } from "node:test";
import { cbor } from "@automerge/automerge-repo";
import { DocStore, MemoryByteStore } from "./doc-store.mjs";

test("append writes constant metadata and cold reads descriptors in numeric order", async () => {
  const bytes = new MemoryByteStore();
  const store = new DocStore(bytes);
  const sizes = [];
  for (let n = 1; n <= 100; n++) {
    const before = bytes.stats.savedBytes;
    await store.append("d", Uint8Array.of(n), ["aa".repeat(32)]);
    sizes.push(bytes.stats.savedBytes - before);
  }
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 2);
  assert.equal(cbor.decode(await bytes.load("sync/d/m")).chunks, undefined);
  assert.deepEqual(
    (await new DocStore(bytes).read("d")).chunks.map((c) => c[0]),
    Array.from({ length: 100 }, (_, i) => i + 1),
  );
  await store.compact("d", Uint8Array.of(200), ["bb".repeat(32)]);
  assert.deepEqual(await bytes.list("sync/d/c/"), []);
  assert.deepEqual((await new DocStore(bytes).read("d")).chunks, []);
  await store.append("d", Uint8Array.of(201), []);
  await store.remove("d");
  assert.deepEqual(await bytes.list("sync/d/"), []);
});

test("legacy inline manifests read and append until compaction upgrades them", async () => {
  const bytes = new MemoryByteStore();
  await bytes.saveMany([
    ["sync/d/o/3/0", Uint8Array.of(3)],
    ["sync/d/o/4/0", Uint8Array.of(4)],
    [
      "sync/d/m",
      cbor.encode({
        seq: 4,
        snapshot: { seq: 3, parts: 1, bytes: 1 },
        chunks: [{ seq: 4, parts: 1, bytes: 1 }],
        heads: ["aa"],
      }),
    ],
  ]);
  const store = new DocStore(bytes);
  assert.deepEqual((await store.read("d")).snapshot, Uint8Array.of(3));
  await store.append("d", Uint8Array.of(5), ["bb"]);
  assert.equal(cbor.decode(await bytes.load("sync/d/m")).chunks.length, 2);
  assert.deepEqual(
    (await new DocStore(bytes).read("d")).chunks.map((c) => c[0]),
    [4, 5],
  );
  await store.compact("d", Uint8Array.of(6), ["cc"]);
  assert.equal(cbor.decode(await bytes.load("sync/d/m")).version, 2);
  await store.append("d", Uint8Array.of(7), ["dd"]);
  const read = await new DocStore(bytes).read("d");
  assert.deepEqual(read.snapshot, Uint8Array.of(6));
  assert.deepEqual(read.chunks, [Uint8Array.of(7)]);
  assert.deepEqual(read.manifest.heads, ["dd"]);
});

test("crashes at each append/compaction write leave an old or complete manifest", async () => {
  for (const compact of [false, true]) {
    for (const stop of [1, 2, 3, 4]) {
      const bytes = new MemoryByteStore();
      const store = new DocStore(bytes);
      await store.append("d", Uint8Array.of(1), ["old"]);
      const save = bytes.saveMany.bind(bytes);
      // Unlike the atomic memory store, model a byte store interrupted after
      // any committed entry, including an ambiguous manifest write.
      bytes.saveMany = async (entries) => {
        let n = 0;
        for (const entry of entries) {
          await save([entry]);
          if (++n === stop) throw Error("crash");
        }
      };
      const extra = [["actor/a", Uint8Array.of(1)]];
      await store[compact ? "compact" : "append"]("d", Uint8Array.of(2), ["new"], extra).catch(
        (e) => assert.equal(e.message, "crash"),
      );
      bytes.saveMany = save;
      const cold = new DocStore(bytes);
      const read = await cold.read("d");
      const published = stop >= (compact ? 3 : 4);
      assert.deepEqual(read.manifest.heads, [published ? "new" : "old"]);
      assert.deepEqual(
        [read.snapshot, ...read.chunks].filter(Boolean).map((c) => c[0]),
        published ? (compact ? [2] : [1, 2]) : [1],
      );
      // Retry with different bytes at an unpublished seq. Old orphans cannot
      // leak into this commit, or overwrite any live object.
      await cold.append("d", Uint8Array.of(9), ["retry"]);
      assert.equal((await new DocStore(bytes).read("d")).chunks.at(-1)[0], 9);
    }
  }
});

test("a missing committed descriptor or object fails closed", async () => {
  for (const key of ["sync/d/c/1", "sync/d/o/1/0"]) {
    const bytes = new MemoryByteStore();
    await new DocStore(bytes).append("d", Uint8Array.of(1), []);
    await bytes.remove(key);
    await assert.rejects(new DocStore(bytes).read("d"), /Missing stored/);
  }
});

test("an ambiguous manifest put reloads before a warm retry allocates its seq", async () => {
  const bytes = new MemoryByteStore();
  const store = new DocStore(bytes);
  await store.append("d", Uint8Array.of(1), ["old"]);
  const save = bytes.saveMany.bind(bytes);
  bytes.saveMany = async (entries) => {
    await save(entries);
    throw Error("committed then rejected");
  };
  await assert.rejects(store.compact("d", Uint8Array.of(2), ["new"]), /rejected/);
  bytes.saveMany = save;
  await store.append("d", Uint8Array.of(3), ["retry"]);
  const read = await new DocStore(bytes).read("d");
  assert.equal(read.manifest.seq, 3);
  assert.deepEqual(read.snapshot, Uint8Array.of(2));
  assert.deepEqual(read.chunks, [Uint8Array.of(3)]);
});
