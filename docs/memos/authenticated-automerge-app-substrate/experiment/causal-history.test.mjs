import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import { MemoryByteStore } from "@automerge/automerge-repo-subduction";
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge";
import { commitId, checkpointId, sedimentreeId } from "@automerge/automerge-repo/sedimentree";
import {
  StorageBridge,
  nativeId,
  unsigned,
  unsignedFragment,
} from "./upstream/packages/automerge-repo-subduction/src/storage.ts";
import { closePeers, createPeer } from "./backend.mjs";

const tree = sedimentreeId("cd".repeat(16));
const cid = (n) => commitId(n.toString(16).padStart(2, "0").repeat(32));
const limits = { maxRecordBytes: 4096, maxSnapshotBytes: 65536, maxRecords: 100 };

class Store {
  values = new Map();
  saved = [];
  async load(key) {
    return this.values.get(key)?.slice();
  }
  async list(prefix) {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }
  async save(key, value) {
    this.values.set(key, value.slice());
    this.saved.push(key);
  }
  async remove(key) {
    this.values.delete(key);
  }
}

// Fragment members other than head and checkpoints are opaque without decoding
// the bundle. Metadata alone still orders every edge it can name.
const member = cid(0x31); // inside `low`, named by its checkpoint prefix
const hidden = cid(0x32); // inside some fragment, named by nothing
const base = { kind: "commit", id: cid(0x01), parents: [], blob: Uint8Array.of(1) };
const low = {
  kind: "fragment",
  head: cid(0x10),
  boundary: [],
  checkpoints: [checkpointId(member.slice(0, 24))],
  blob: Uint8Array.of(16),
};
const high = {
  kind: "fragment",
  head: cid(0x20),
  boundary: [cid(0x10), base.id],
  checkpoints: [],
  blob: Uint8Array.of(32),
};
const childOfHead = { kind: "commit", id: cid(0x02), parents: [cid(0x20)], blob: Uint8Array.of(2) };
const childOfMember = { kind: "commit", id: cid(0x03), parents: [member], blob: Uint8Array.of(3) };
const merge = {
  kind: "commit",
  id: cid(0x04),
  parents: [childOfHead.id, childOfMember.id],
  blob: Uint8Array.of(4),
};
const childOfHidden = { kind: "commit", id: cid(0x05), parents: [hidden], blob: Uint8Array.of(5) };
// A loose chain above the merge, newest first.
const tail = Array.from({ length: 40 }, (_, n) => ({
  kind: "commit",
  id: cid(0x40 + n),
  parents: [n ? cid(0x40 + n - 1) : merge.id],
  blob: Uint8Array.of(0x40 + n),
})).reverse();
// Children before parents, as a native batch may arrive.
const batch = [...tail, merge, childOfHidden, childOfMember, childOfHead, high, base, low];

test("a native batch reaches storage parents first, so every prefix is causally closed", async () => {
  const signer = N.MemorySigner.fromBytes(new Uint8Array(32).fill(43));
  const store = new Store();
  const bridge = new StorageBridge(store, limits, () => {});
  const engine = new N.Subduction({ signer, storage: bridge });
  const id = nativeId(tree);
  try {
    await engine.storeBuiltBatch(
      id,
      batch
        .filter((r) => r.kind === "commit")
        .map((r) => new N.CommitInput(unsigned(id, r), r.blob)),
      batch
        .filter((r) => r.kind === "fragment")
        .map((r) => new N.FragmentInput(unsignedFragment(id, r), r.blob)),
    );
    const position = (record) => {
      const key = record.kind === "commit" ? `commits/${record.id}` : `fragments/${record.head}`;
      const index = store.saved.findIndex((path) => path.endsWith(key));
      assert.ok(index >= 0, `${key} was saved`);
      return index;
    };
    const before = (parent, child) =>
      assert.ok(position(parent) < position(child), `${position(parent)} < ${position(child)}`);
    before(low, high); // boundary names the lower fragment's head
    before(base, high); // boundary names a loose commit
    before(high, childOfHead); // parent is a fragment head
    before(low, childOfMember); // parent is a fragment checkpoint
    before(childOfHead, merge);
    before(childOfMember, merge);
    // A parent no metadata names waits for every fragment in the batch.
    before(low, childOfHidden);
    before(high, childOfHidden);
    for (const record of tail)
      for (const parent of record.parents)
        before(
          batch.find((r) => r.id === parent),
          record,
        );
  } finally {
    await engine.disconnectAll();
    await bridge.drain();
    engine.free();
    id.free();
    signer.free();
  }
});

// Fixed actor and timestamps keep every change a loose commit (no leading zero
// byte in its hash), so the stored shape is the same on every run.
function chain() {
  let doc = A.init({ actor: "0d".repeat(16) });
  for (const [time, key] of [
    [1_790_000_000, "first"],
    [1_790_000_001, "second"],
    [1_790_000_002, "third"],
  ])
    doc = A.change(doc, { time }, (draft) => {
      draft[key] = key;
    });
  return doc;
}

test("lookup becomes ready on the stored history that materializes", async () => {
  const doc = chain();
  assert.deepEqual(
    extractRecords(doc).map((record) => record.kind),
    ["commit", "commit", "commit"],
  );
  const changes = A.getAllChanges(doc).map((change) => A.decodeChange(change));
  const storage = new MemoryByteStore();
  const writer = createPeer({ storage });
  const peers = [writer];
  try {
    const handle = await writer.repo.import(A.save(doc));
    await writer.repo.flush();
    await writer.backend.flush();
    // Lose the middle commit: the newest one is stored without its parent.
    const [lost] = (await storage.list("")).filter((key) =>
      key.endsWith(`/commits/${changes[1].hash}`),
    );
    assert.ok(lost);
    await storage.remove(lost);
    const reader = createPeer({ storage });
    peers.push(reader);
    let timer;
    const found = await Promise.race([
      reader.repo.find(handle.documentId),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("lookup did not settle")), 5000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.deepEqual(A.getHeads(found.doc()), [changes[0].hash]);
    assert.equal(found.doc().third, undefined);
    // The orphan stays queued and applies once its parent arrives.
    assert.deepEqual(A.getMissingDeps(found.doc(), []), [changes[1].hash]);
    await found.update((current) => A.applyChanges(current, [A.getAllChanges(doc)[1]])[0]);
    assert.deepEqual(A.getHeads(found.doc()), A.getHeads(doc));
    assert.equal(found.doc().third, "third");
  } finally {
    assert.deepEqual(await closePeers(peers), []);
  }
});

test("lookup over stored history with no materializable head fails instead of hanging", async () => {
  const doc = chain();
  const changes = A.getAllChanges(doc).map((change) => A.decodeChange(change));
  const storage = new MemoryByteStore();
  const writer = createPeer({ storage });
  const peers = [writer];
  try {
    const handle = await writer.repo.import(A.save(doc));
    await writer.repo.flush();
    await writer.backend.flush();
    const [root] = (await storage.list("")).filter((key) =>
      key.endsWith(`/commits/${changes[0].hash}`),
    );
    await storage.remove(root);
    const reader = createPeer({ storage });
    peers.push(reader);
    let timer;
    await assert.rejects(
      Promise.race([
        reader.repo.find(handle.documentId),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("lookup did not settle")), 5000);
        }),
      ]).finally(() => clearTimeout(timer)),
      /is unavailable/,
    );
  } finally {
    assert.deepEqual(await closePeers(peers), []);
  }
});
