import assert from "node:assert/strict";
import { test } from "node:test";
import { cbor } from "@automerge/automerge-repo";
import { MAX_STORED_BYTES } from "../model/limits.mjs";
import { DocStore, MemoryByteStore } from "../sync/doc-store.mjs";
import { MAX_COMMIT_TAIL_KEYS } from "../sync/commit-tail.mjs";
import { PlainByteStore } from "./plain-sync.mjs";

// Model an atomic multi-key put and inject interruptions between its calls or
// after a committed response is lost. These tests exercise the real adapters,
// not the backend's transaction implementation or durability barrier.
class AtomicStorage {
  values = new Map();
  puts = [];
  failBeforePut = 0;
  failAfterPut = 0;
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(entries) {
    const copy = structuredClone(entries);
    this.puts.push(copy);
    const call = this.puts.length;
    if (call === this.failBeforePut) throw new Error("injected staging or tail failure");
    for (const [key, value] of Object.entries(copy)) this.values.set(key, value);
    if (call === this.failAfterPut) throw new Error("committed then rejected");
  }
  async delete(key) {
    this.values.delete(key);
  }
  async list({ prefix = "", startAfter, limit = Infinity }) {
    return new Map(
      [...this.values]
        .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit),
    );
  }
}

const claims = (count) =>
  Array.from({ length: count }, (_, i) => [`actor/${i}`, cbor.encode({ host: true })]);
const metadata = ({ seq, heads }) => [[`metadata/${seq}`, cbor.encode({ seq, heads })]];
const byte = Uint8Array.of(1);

async function fixture() {
  const storage = new AtomicStorage();
  const bytes = new PlainByteStore(storage);
  const store = new DocStore(bytes);
  await store.append("d", Uint8Array.of(1), ["old"], [], { commitExtra: metadata });
  storage.puts = [];
  return { storage, bytes, store };
}

test("atomic publication reserves the full tail across staging batch boundaries", async () => {
  for (const count of [0, 125, 126, 127, 128, 255]) {
    const { storage, bytes, store } = await fixture();
    await store.append("d", Uint8Array.of(2), ["new"], claims(count), { commitExtra: metadata });
    const stagedKeys = [
      "plain/sync/d/o/2/0",
      "plain/sync/d/c/2",
      ...claims(count).map(([k]) => `plain/${k}`),
    ];
    const puts = storage.puts.map(Object.keys);
    assert.deepEqual(puts.slice(0, -1).flat(), stagedKeys);
    assert.ok(puts.every((keys) => keys.length <= MAX_COMMIT_TAIL_KEYS));
    assert.equal(puts.length, Math.ceil(stagedKeys.length / MAX_COMMIT_TAIL_KEYS) + 1);
    assert.deepEqual(puts.at(-1), ["plain/metadata/2", "plain/sync/d/m2"]);
    assert.deepEqual(cbor.decode(await bytes.load("metadata/2")), { seq: 2, heads: ["new"] });
    assert.deepEqual((await new DocStore(bytes).read("d")).manifest.heads, ["new"]);
  }
});

test("failure before any staging or tail put leaves old history and no new metadata", async () => {
  for (const count of [125, 126, 127, 255]) {
    const putCount = Math.ceil((count + 2) / MAX_COMMIT_TAIL_KEYS) + 1;
    for (let stop = 1; stop <= putCount; stop++) {
      const { storage, bytes, store } = await fixture();
      storage.failBeforePut = stop;
      await assert.rejects(
        store.append("d", Uint8Array.of(2), ["new"], claims(count), { commitExtra: metadata }),
        /injected/,
      );
      assert.deepEqual(store.manifest("d").heads, ["old"], "warm state reloads after failure");
      const cold = new DocStore(bytes);
      const read = await cold.read("d");
      assert.deepEqual(read.manifest.heads, ["old"]);
      assert.deepEqual(read.chunks, [Uint8Array.of(1)]);
      assert.equal(await bytes.load("metadata/2"), undefined);
      assert.deepEqual(cbor.decode(await bytes.load("metadata/1")), { seq: 1, heads: ["old"] });
      storage.failBeforePut = 0;
      // Reusing an unpublished sequence replaces any staged orphans. Neither
      // the failed bytes nor their metadata can leak into the committed retry.
      await cold.append("d", Uint8Array.of(3), ["retry"], claims(count), { commitExtra: metadata });
      assert.deepEqual((await new DocStore(bytes).read("d")).chunks, [
        Uint8Array.of(1),
        Uint8Array.of(3),
      ]);
      assert.deepEqual(cbor.decode(await bytes.load("metadata/2")), { seq: 2, heads: ["retry"] });
    }
  }
});

test("commit-then-throw reloads the complete tail before warm or restarted retries", async () => {
  for (const restart of [false, true]) {
    const { storage, bytes, store } = await fixture();
    storage.failAfterPut = 3; // 129 staged keys in two puts, then the tail.
    await assert.rejects(
      store.append("d", Uint8Array.of(2), ["committed"], claims(127), { commitExtra: metadata }),
      /committed then rejected/,
    );
    assert.equal(store.manifest("d").seq, 2);
    assert.deepEqual(store.manifest("d").heads, ["committed"]);
    const cold = new DocStore(bytes);
    assert.deepEqual((await cold.read("d")).chunks, [Uint8Array.of(1), Uint8Array.of(2)]);
    assert.deepEqual(cbor.decode(await bytes.load("metadata/2")), { seq: 2, heads: ["committed"] });
    storage.failAfterPut = 0;
    await (restart ? cold : store).append("d", Uint8Array.of(3), ["next"], [], {
      commitExtra: metadata,
    });
    assert.equal((await new DocStore(bytes).read("d")).manifest.seq, 3);
    assert.deepEqual(cbor.decode(await bytes.load("metadata/2")), { seq: 2, heads: ["committed"] });
    assert.deepEqual(cbor.decode(await bytes.load("metadata/3")), { seq: 3, heads: ["next"] });
  }
});

test("127 metadata keys plus the manifest fit, and 128 metadata keys fail before staging", async () => {
  const { storage, bytes, store } = await fixture();
  const many = (count) => Array.from({ length: count }, (_, i) => [`metadata/bound/${i}`, byte]);
  await store.append("d", byte, ["max"], claims(128), { commitExtra: () => many(127) });
  assert.equal(Object.keys(storage.puts.at(-1)).length, 128);
  storage.puts = [];
  await assert.rejects(
    store.append("d", byte, ["too many"], [], { commitExtra: () => many(128) }),
    /Commit metadata permits at most 127 keys/,
  );
  assert.equal(storage.puts.length, 0);
  assert.deepEqual((await new DocStore(bytes).read("d")).manifest.heads, ["max"]);
});

test("malformed, duplicate, reserved, oversized, and unsupported tails never stage writes", async () => {
  const cases = [
    [[], { commitExtra: 123 }, /synchronous function/],
    [[], { commitExtra: () => null }, /entry array/],
    [[], { commitExtra: async () => [] }, /synchronously/],
    [[], { commitExtra: () => [["", byte]] }, /nonempty string/],
    [[], { commitExtra: () => [["metadata/a", "not bytes"]] }, /Uint8Array/],
    [[], { commitExtra: () => [["metadata/a", byte, byte]] }, /Commit entries/],
    [
      [],
      {
        commitExtra: () => [
          ["metadata/a", byte],
          ["metadata/a", byte],
        ],
      },
      /Duplicate/,
    ],
    [[["metadata/a", byte]], { commitExtra: () => [["metadata/a", byte]] }, /Duplicate/],
    [
      [
        ["actor/a", byte],
        ["actor/a", byte],
      ],
      { commitExtra: metadata },
      /Duplicate/,
    ],
    [[["sync/d/c/2", byte]], { commitExtra: metadata }, /Duplicate/],
    [[], { commitExtra: () => [["sync/d/m2", byte]] }, /Duplicate/],
    [[], { commitExtra: () => [["sync/other/m", byte]] }, /reserved sync/],
    [[], { commitExtra: () => [["sync/d/s", byte]] }, /reserved sync/],
    [
      [],
      { commitExtra: () => [["metadata/large", new Uint8Array(MAX_STORED_BYTES)]] },
      /1,900,000/,
    ],
    [[["actor/large", new Uint8Array(MAX_STORED_BYTES)]], { commitExtra: metadata }, /1,900,000/],
    [
      [],
      {
        commitExtra: () => {
          throw new Error("builder failed");
        },
      },
      /builder failed/,
    ],
    [
      [],
      {
        commitExtra: ({ heads }) => {
          heads.push("corrupt");
          return [];
        },
      },
      /extensible|read only/,
    ],
  ];
  for (const [extra, options, error] of cases) {
    const { storage, bytes, store } = await fixture();
    await assert.rejects(store.append("d", byte, ["invalid"], extra, options), error);
    assert.equal(storage.puts.length, 0);
    assert.deepEqual((await new DocStore(bytes).read("d")).manifest.heads, ["old"]);
    assert.equal(await bytes.load("metadata/2"), undefined);
  }
  const bytes = new MemoryByteStore();
  await assert.rejects(
    new DocStore(bytes).append("d", byte, [], [], { commitExtra: metadata }),
    /does not support an atomic commit tail/,
  );
  assert.equal(bytes.stats.saves, 0);
});

test("the adapter validates direct callers and snapshots the entire request before awaiting", async () => {
  const storage = new AtomicStorage();
  const bytes = new PlainByteStore(storage);
  for (const [staged, tail] of [
    [[], []],
    [null, [["metadata/a", byte]]],
    [[], Array.from({ length: 129 }, (_, i) => [`metadata/${i}`, byte])],
    [[["a", byte]], [["a", byte]]],
    [
      [],
      [
        ["a", byte],
        ["a", byte],
      ],
    ],
    [
      [
        ["a", byte],
        ["a", byte],
      ],
      [["b", byte]],
    ],
    [[], [["a", new Uint8Array(MAX_STORED_BYTES)]]],
  ]) {
    await assert.rejects(bytes.saveWithCommitTail(staged, tail));
    assert.equal(storage.puts.length, 0);
  }
  const staged = Array.from({ length: 129 }, (_, i) => [`stage/${i}`, Uint8Array.of(1)]);
  const tail = [["publication", Uint8Array.of(2)]];
  const saving = bytes.saveWithCommitTail(staged, tail);
  staged[128][1][0] = 9;
  tail[0][1][0] = 9;
  tail[0][0] = "replaced";
  await saving;
  assert.deepEqual(await bytes.load("stage/128"), Uint8Array.of(1));
  assert.deepEqual(await bytes.load("publication"), Uint8Array.of(2));
  assert.equal(await bytes.load("replaced"), undefined);
  storage.puts = [];
  await bytes.saveWithCommitTail([], [["publication", byte]]);
  assert.equal(storage.puts.length, 1, "an empty staging prefix needs only the atomic tail put");
});

test("no-tail callers keep their existing adapter and batching behavior", async () => {
  for (const options of [{}, { commitExtra: () => [] }]) {
    const storage = new AtomicStorage();
    const bytes = new PlainByteStore(storage);
    const store = new DocStore(bytes);
    await store.append("d", byte, [], claims(126), options);
    assert.deepEqual(
      storage.puts.map((entries) => Object.keys(entries).length),
      [128, 1],
    );
    const memory = new MemoryByteStore();
    await new DocStore(memory).append("d", byte, [], [], options);
    assert.equal(memory.stats.saves, 3, "no atomic adapter capability is required");
  }
});

test("compaction and removal do not manufacture or reclaim caller metadata", async () => {
  const { storage, bytes, store } = await fixture();
  await store.append("d", Uint8Array.of(2), ["new"], [], { commitExtra: metadata });
  storage.puts = [];
  await store.compact("d", Uint8Array.of(3), ["new"]);
  assert.ok(
    storage.puts.every(
      (entries) => !Object.keys(entries).some((key) => key.startsWith("plain/metadata/")),
    ),
  );
  assert.equal((await new DocStore(bytes).read("d")).manifest.seq, 3);
  assert.deepEqual(await bytes.list("metadata/"), ["metadata/1", "metadata/2"]);
  assert.deepEqual(await bytes.list("sync/d/c/"), []);
  await store.remove("d");
  assert.equal(await new DocStore(bytes).read("d"), null);
  assert.deepEqual(await bytes.list("metadata/"), ["metadata/1", "metadata/2"]);
});

test("prototype-special keys remain literal caller metadata", async () => {
  const { bytes, store } = await fixture();
  const keys = ["__proto__", "constructor", "toString"];
  await store.append("d", byte, [], [], {
    commitExtra: () => keys.map((key) => [key, byte]),
  });
  for (const key of keys) assert.deepEqual(await bytes.load(key), byte);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

test("a failed first publication leaves no document or metadata, and can be retried", async () => {
  const storage = new AtomicStorage();
  const bytes = new PlainByteStore(storage);
  const store = new DocStore(bytes);
  storage.failBeforePut = 2;
  await assert.rejects(
    store.append("d", byte, ["failed"], [], { commitExtra: metadata }),
    /injected/,
  );
  assert.equal(store.manifest("d"), null);
  assert.equal(await new DocStore(bytes).read("d"), null);
  assert.equal(await bytes.load("metadata/1"), undefined);
  storage.failBeforePut = 0;
  await store.append("d", Uint8Array.of(2), ["retry"], [], { commitExtra: metadata });
  assert.equal((await new DocStore(bytes).read("d")).manifest.seq, 1);
  assert.deepEqual(cbor.decode(await bytes.load("metadata/1")), { seq: 1, heads: ["retry"] });
});

test("legacy history can atomically publish metadata before compaction upgrades it", async () => {
  const storage = new AtomicStorage();
  const bytes = new PlainByteStore(storage);
  await bytes.saveMany([
    ["sync/d/o/1/0", byte],
    ["sync/d/m", cbor.encode({ seq: 1, chunks: [{ seq: 1, parts: 1, bytes: 1 }], heads: ["old"] })],
  ]);
  const store = new DocStore(bytes);
  storage.puts = [];
  storage.failBeforePut = 2;
  await assert.rejects(
    store.append("d", byte, ["failed"], [], { commitExtra: metadata }),
    /injected/,
  );
  assert.deepEqual((await new DocStore(bytes).read("d")).manifest.heads, ["old"]);
  assert.equal(await bytes.load("metadata/2"), undefined);
  storage.failBeforePut = 0;
  await store.append("d", Uint8Array.of(2), ["new"], [], { commitExtra: metadata });
  assert.equal(await bytes.load("sync/d/m"), undefined);
  assert.deepEqual((await new DocStore(bytes).read("d")).chunks, [byte, Uint8Array.of(2)]);
  await store.compact("d", Uint8Array.of(3), ["new"]);
  assert.equal((await new DocStore(bytes).read("d")).manifest.version, 2);
  assert.deepEqual(cbor.decode(await bytes.load("metadata/2")), { seq: 2, heads: ["new"] });
});

test("rejected async metadata builders never leak unhandled rejections or start writes", async () => {
  for (const commitExtra of [
    async () => {
      throw new Error("async builder failed");
    },
    () => Promise.reject(new Error("promise builder failed")),
    () => ({
      // oxlint-disable-next-line unicorn/no-thenable -- Exercise a rejected non-native async result.
      then(_resolve, reject) {
        reject(new Error("thenable builder failed"));
      },
    }),
  ]) {
    const { storage, bytes, store } = await fixture();
    await assert.rejects(
      store.append("d", byte, ["invalid"], [], { commitExtra }),
      /synchronously/,
    );
    // Give any leaked rejection a turn to surface. node:test fails this test
    // on unhandledRejection, even though append's TypeError was caught above.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(storage.puts.length, 0);
    assert.deepEqual(store.manifest("d").heads, ["old"]);
    assert.deepEqual((await new DocStore(bytes).read("d")).manifest.heads, ["old"]);
  }
});

test("the metadata key bound is checked before copying the builder result", async () => {
  const { storage, store } = await fixture();
  const oversized = Array.from({ length: 128 });
  oversized[Symbol.iterator] = () => {
    throw new Error("must not spread an oversized tail");
  };
  await assert.rejects(
    store.append("d", byte, [], [], { commitExtra: () => oversized }),
    /Commit metadata permits at most 127 keys/,
  );
  assert.equal(storage.puts.length, 0);
});
