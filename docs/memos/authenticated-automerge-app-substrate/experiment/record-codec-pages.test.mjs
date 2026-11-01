import test, { before } from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import { commitId, sedimentreeId } from "@automerge/automerge-repo/sedimentree";
import {
  StorageBridge,
  nativeId,
  unsigned,
  unsignedFragment,
} from "./upstream/packages/automerge-repo-subduction/src/storage.ts";
import { decodeRecordFrame } from "./upstream/packages/automerge-repo-subduction/src/record-codec.ts";
import { commitAuthor, commitFrame } from "./pages/worker/actor-authorship.mjs";

// Pages reads saved commit frames with its own `commitFrame`, because its
// build fingerprint can't follow the bridge's TypeScript imports. This suite
// lives outside pages/ so it can hold that reader to the bridge's codec.

const limits = { maxRecordBytes: 65536, maxSnapshotBytes: 262144, maxRecords: 100 };
const tree = sedimentreeId("ac".repeat(16));
const actor = "a1".repeat(16);
const change = A.getLastLocalChange(
  A.change(A.init({ actor }), { time: 0 }, (doc) => (doc.text = "attested")),
);
const hash = A.decodeChange(change).hash;
class Store {
  values = new Map();
  async load(key) {
    return this.values.get(key)?.slice();
  }
  async list(prefix) {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }
  async save(key, value) {
    this.values.set(key, value.slice());
  }
  async remove(key) {
    this.values.delete(key);
  }
}
const saved = {};
let issuer;

before(async () => {
  const signer = N.MemorySigner.fromBytes(new Uint8Array(32).fill(29));
  issuer = Buffer.from(signer.verifyingKey()).toString("hex");
  const store = new Store();
  const storage = new StorageBridge(store, limits, () => {});
  const engine = new N.Subduction({ signer, storage });
  const id = nativeId(tree);
  try {
    const commit = { kind: "commit", id: commitId(hash), parents: [], blob: change };
    const fragment = {
      kind: "fragment",
      head: commitId("02".repeat(32)),
      boundary: [],
      checkpoints: [],
      blob: Uint8Array.from({ length: 512 }, (_, n) => n % 256),
    };
    await engine.storeBuiltBatch(
      id,
      [new N.CommitInput(unsigned(id, commit), change)],
      [new N.FragmentInput(unsignedFragment(id, fragment), fragment.blob)],
    );
    for (const [path, value] of store.values) {
      if (path.includes("/commits/")) saved.commit = { path, value };
      if (path.includes("/fragments/")) saved.fragment = { path, value };
    }
  } finally {
    await engine.disconnectAll();
    await storage.drain();
    engine.free();
    id.free();
    signer.free();
  }
});

test("Pages' commit frame reader agrees with the bridge codec on a saved commit", () => {
  const codec = decodeRecordFrame(saved.commit.value, limits.maxRecordBytes);
  const local = commitFrame(saved.commit.value);
  assert.equal(codec.kind, "commit");
  assert.equal(local.key, codec.key);
  assert.deepEqual(Buffer.from(local.signed), Buffer.from(codec.signed));
  assert.deepEqual(Buffer.from(local.blob), Buffer.from(codec.blob));
  assert.deepEqual(commitAuthor(saved.commit.path, saved.commit.value), {
    key: issuer,
    actor,
    hash,
  });
});

test("Pages' reader refuses what the codec reads as a fragment or a legacy v1 frame", () => {
  assert.equal(decodeRecordFrame(saved.fragment.value, limits.maxRecordBytes).kind, "fragment");
  assert.equal(commitFrame(saved.fragment.value), null);
  const codec = decodeRecordFrame(saved.commit.value, limits.maxRecordBytes);
  const legacy = new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      tree: codec.tree,
      commit: codec.key,
      signed: Buffer.from(codec.signed).toString("hex"),
      signedDigest: codec.signedDigest,
      blob: Buffer.from(codec.blob).toString("hex"),
    }),
  );
  assert.equal(decodeRecordFrame(legacy, limits.maxRecordBytes).key, codec.key);
  // Saves always write v2, so the save observer never sees a v1 frame.
  assert.equal(commitFrame(legacy), null);
});
