import test, { before } from "node:test";
import assert from "node:assert/strict";
import * as N from "@automerge/subduction";
import { commitId, sedimentreeId } from "@automerge/automerge-repo/sedimentree";
import {
  StorageBridge,
  nativeId,
  unsigned,
  unsignedFragment,
} from "./upstream/packages/automerge-repo-subduction/src/storage.ts";
import {
  decodeRecordFrame,
  encodeRecordFrame,
  RECORD_HEADER_BYTES,
} from "./upstream/packages/automerge-repo-subduction/src/record-codec.ts";

const limits = { maxRecordBytes: 65536, maxSnapshotBytes: 262144, maxRecords: 100 };
const tree = sedimentreeId("ac".repeat(16));
const records = [
  {
    kind: "commit",
    id: commitId("01".repeat(32)),
    parents: [],
    blob: Uint8Array.from({ length: 4096 }, (_, n) => n % 256),
  },
  {
    kind: "fragment",
    head: commitId("02".repeat(32)),
    boundary: [],
    checkpoints: [],
    blob: Uint8Array.from({ length: 8192 }, (_, n) => 255 - (n % 256)),
  },
];
const hex = (value) => Buffer.from(value).toString("hex");
const frames = [];
class Store {
  values = new Map();
  saves = 0;
  fail;
  async load(key) {
    return this.values.get(key)?.slice();
  }
  async list(prefix) {
    return [...this.values.keys()].filter((k) => k.startsWith(prefix));
  }
  async save(key, value) {
    this.saves++;
    if (this.fail === "before") throw Error("before atomic save");
    this.values.set(key, value.slice());
    if (this.fail === "after") throw Error("after atomic save");
  }
  async remove(key) {
    this.values.delete(key);
  }
}
const bridge = (store) => new StorageBridge(store, limits, () => {});
const read = async (store) => {
  const id = nativeId(tree);
  try {
    return await bridge(store).records(id);
  } finally {
    id.free();
  }
};
function legacy(frame) {
  return new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      tree: frame.tree,
      ...(frame.kind === "commit" ? { commit: frame.key } : { kind: frame.kind, head: frame.key }),
      signed: hex(frame.signed),
      signedDigest: frame.signedDigest,
      blob: hex(frame.blob),
    }),
  );
}
before(async () => {
  const signer = N.MemorySigner.fromBytes(new Uint8Array(32).fill(23));
  const store = new Store(),
    storage = bridge(store);
  const engine = new N.Subduction({ signer, storage });
  const id = nativeId(tree);
  try {
    await engine.storeBuiltBatch(
      id,
      [new N.CommitInput(unsigned(id, records[0]), records[0].blob)],
      [new N.FragmentInput(unsignedFragment(id, records[1]), records[1].blob)],
    );
    for (const record of records) {
      const entry = [...store.values].find(([path]) =>
        path.includes(record.kind === "commit" ? "/commits/" : "/fragments/"),
      );
      frames.push({
        path: entry[0],
        value: entry[1],
        frame: decodeRecordFrame(entry[1], limits.maxRecordBytes),
      });
    }
  } finally {
    await engine.disconnectAll();
    await storage.drain();
    engine.free();
    id.free();
    signer.free();
  }
});

test("binary loose commits and fragments preserve signed bytes with fixed overhead", async () => {
  const store = new Store();
  for (const { path, value, frame } of frames) {
    assert.equal(value.length, RECORD_HEADER_BYTES + frame.signed.length + frame.blob.length);
    assert.ok(value.length < legacy(frame).length);
    const padded = new Uint8Array(value.length + 13);
    padded.set(value, 7);
    assert.deepEqual(
      decodeRecordFrame(padded.subarray(7, 7 + value.length), limits.maxRecordBytes),
      frame,
    );
    assert.deepEqual(encodeRecordFrame(frame, limits.maxRecordBytes), value);
    store.values.set(path, value);
  }
  assert.deepEqual(await read(store), records);
});

test("legacy v1 and binary v2 frames hydrate together without rewriting", async () => {
  for (const legacyIndex of [0, 1]) {
    const store = new Store();
    frames.forEach(({ path, value, frame }, i) =>
      store.values.set(path, i === legacyIndex ? legacy(frame) : value),
    );
    assert.deepEqual(await read(store), records);
    assert.equal(store.saves, 0);
  }
});

test("encoding and decoding own their byte arrays", () => {
  const original = frames[0].value.slice();
  const decoded = decodeRecordFrame(original, limits.maxRecordBytes);
  const encoded = encodeRecordFrame(decoded, limits.maxRecordBytes);
  decoded.signed.fill(0);
  decoded.blob.fill(0);
  assert.deepEqual(original, frames[0].value);
  assert.deepEqual(encoded, original);
});

test("length, version, kind, reserved bytes, truncation and trailing bytes fail closed", () => {
  const value = frames[0].value;
  const invalid = [value.slice(0, 20), value.slice(0, -1), new Uint8Array(value.length + 1)];
  invalid[2].set(value);
  for (const [offset, byte] of [
    [0, 0],
    [3, 3],
    [4, 2],
    [5, 1],
    [6, 1],
    [7, 1],
  ]) {
    const copy = value.slice();
    copy[offset] = byte;
    invalid.push(copy);
  }
  for (const [offset, length] of [
    [8, 0],
    [8, 0xffffffff],
    [12, 0xffffffff],
    [12, 1],
  ]) {
    const copy = value.slice();
    new DataView(copy.buffer).setUint32(offset, length);
    invalid.push(copy);
  }
  for (const bytes of invalid) assert.throws(() => decodeRecordFrame(bytes, limits.maxRecordBytes));
  assert.throws(() =>
    decodeRecordFrame(value, frames[0].frame.signed.length + frames[0].frame.blob.length - 1),
  );
  assert.throws(() => encodeRecordFrame(frames[0].frame, 1));
  assert.throws(() =>
    encodeRecordFrame({ ...frames[0].frame, tree: "bad" }, limits.maxRecordBytes),
  );
  assert.throws(() =>
    decodeRecordFrame(
      new Uint8Array(limits.maxRecordBytes * 4 + 4097).fill(123),
      limits.maxRecordBytes,
    ),
  );
});

for (const kind of ["commit", "fragment"]) {
  test(`${kind}: stored tree/key/kind and signed-envelope checksum stay bound`, async () => {
    const original = frames.find((f) => f.frame.kind === kind);
    for (const offset of [4, 16, 48, 80, RECORD_HEADER_BYTES + original.frame.signed.length - 1]) {
      const store = new Store(),
        value = original.value.slice();
      value[offset] ^= 1;
      store.values.set(original.path, value);
      await assert.rejects(read(store), /version\/tree\/key\/kind|checksum mismatch/);
    }
  });
  test(`${kind}: blob digest and native signed-envelope decoding still reject corruption`, async () => {
    const original = frames.find((f) => f.frame.kind === kind);
    const store = new Store(),
      blobChanged = original.value.slice();
    blobChanged[blobChanged.length - 1] ^= 1;
    store.values.set(original.path, blobChanged);
    await assert.rejects(read(store), /Signed .*mismatch/);
    const malformed = new Uint8Array([0]);
    const meta = new N.BlobMeta(malformed),
      digest = meta.digest();
    try {
      store.values.set(
        original.path,
        encodeRecordFrame(
          { ...original.frame, signed: malformed, signedDigest: digest.toHexString() },
          limits.maxRecordBytes,
        ),
      );
      await assert.rejects(read(store));
    } finally {
      digest.free();
      meta.free();
    }
  });
}

test("one compound record remains one atomic byte-store value across uncertain saves", async () => {
  for (const failure of ["before", "after"]) {
    const store = new Store(),
      saved = [];
    const storage = new StorageBridge(store, limits, (_id, record) => saved.push(record));
    const original = frames[0],
      id = nativeId(tree);
    const key = N.CommitId.fromHexString(original.frame.key);
    const signed = N.SignedLooseCommit.tryDecode(original.frame.signed);
    try {
      store.fail = failure;
      await assert.rejects(storage.saveCommit(id, key, signed, original.frame.blob), /atomic save/);
      assert.deepEqual(saved, []);
      assert.equal(store.values.size, failure === "before" ? 0 : 1);
      if (failure === "after") assert.deepEqual(await read(store), [records[0]]);
      store.fail = undefined;
      await storage.saveCommit(id, key, signed, original.frame.blob);
      assert.deepEqual(await read(store), [records[0]]);
      assert.deepEqual(saved, [records[0]]);
      assert.equal(store.values.size, 1);
    } finally {
      signed.free();
      key.free();
      id.free();
    }
  }
});
