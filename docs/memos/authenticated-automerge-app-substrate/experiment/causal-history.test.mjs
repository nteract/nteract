import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import { MemoryByteStore } from "@automerge/automerge-repo-subduction";
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge";
import { sedimentreeId } from "@automerge/automerge-repo/sedimentree";
import {
  StorageBridge,
  nativeId,
  unsigned,
  unsignedFragment,
} from "./upstream/packages/automerge-repo-subduction/src/storage.ts";
import { closePeers, createPeer } from "./backend.mjs";
import { buildPersistenceFixture } from "./persistence-workload.mjs";

const limits = { maxRecordBytes: 1 << 20, maxSnapshotBytes: 16 << 20, maxRecords: 1000 };
const TIME = 1_790_000_000;

/** Records each storage call; saveMany is one atomic call. */
class Store {
  values = new Map();
  calls = [];
  constructor({ atomic = true } = {}) {
    if (!atomic) this.saveMany = undefined;
  }
  async load(key) {
    return this.values.get(key)?.slice();
  }
  async list(prefix) {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }
  async save(key, value) {
    this.values.set(key, value.slice());
    this.calls.push([key]);
  }
  async saveMany(entries) {
    for (const [key, value] of entries) this.values.set(key, value.slice());
    this.calls.push(entries.map(([key]) => key));
  }
  async remove(key) {
    this.values.delete(key);
  }
}

const recordKey = (record) =>
  record.kind === "commit" ? `commits/${record.id}` : `fragments/${record.head}`;

/** What a record actually holds and needs, read from its Automerge payload. */
function payload(record) {
  const changes =
    record.kind === "commit" ? [A.decodeChange(record.blob)] : A.readBundle(record.blob).changes;
  const holds = new Set(changes.map((change) => change.hash));
  const needs = new Set(changes.flatMap((change) => change.deps).filter((h) => !holds.has(h)));
  return { holds, needs };
}

async function store(batch, options) {
  const signer = N.MemorySigner.fromBytes(new Uint8Array(32).fill(43));
  const bytes = new Store(options);
  const bridge = new StorageBridge(bytes, limits, () => {});
  const engine = new N.Subduction({ signer, storage: bridge });
  const id = nativeId(sedimentreeId("cd".repeat(16)));
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
  } finally {
    await engine.disconnectAll();
    await bridge.drain();
    engine.free();
    id.free();
    signer.free();
  }
  return bytes;
}

/** Every prefix of storage calls holds, for each record in it, a holder of
 * every change the record needs that some batch record holds. */
function assertCausalPrefixes(batch, bytes) {
  const call = (record) => {
    const index = bytes.calls.findIndex((keys) => keys.some((k) => k.endsWith(recordKey(record))));
    assert.ok(index >= 0, `${recordKey(record)} was saved`);
    return index;
  };
  const shapes = batch.map((record) => ({ record, ...payload(record) }));
  for (const { record, needs } of shapes)
    for (const need of needs) {
      const holders = shapes.filter((other) => other.holds.has(need));
      if (!holders.length) continue;
      assert.ok(
        holders.some((holder) => call(holder.record) <= call(record)),
        `${recordKey(record)} (call ${call(record)}) needs ${need.slice(0, 8)}, held later`,
      );
    }
  return call;
}

// r -> x -> c -> z -> w, one actor, fixed timestamps.
function chain() {
  let doc = A.init({ actor: "0d".repeat(16) });
  const hashes = [];
  for (const [index, key] of ["r", "x", "c", "z", "w"].entries()) {
    doc = A.change(doc, { time: TIME + index }, (draft) => {
      draft[key] = key;
    });
    hashes.push(A.getHeads(doc)[0]);
  }
  return { doc, hashes };
}
const loose = (doc, hash) => {
  const blob = A.getChanges(A.init(), doc).find((change) => A.decodeChange(change).hash === hash);
  return { kind: "commit", id: hash, parents: A.decodeChange(blob).deps, blob };
};
// A valid fragment whose boundary omits its external dependencies.
const bundle = (doc, hashes) => ({
  kind: "fragment",
  head: hashes.at(-1),
  boundary: [],
  checkpoints: [],
  blob: A.saveBundle(doc, hashes),
});

test("fragment dependencies come from the bundle, not its boundary", async () => {
  const { doc, hashes } = chain();
  const [r, x, c, z, w] = hashes;
  const upper = bundle(doc, [z, w]);
  assert.deepEqual(A.readBundle(upper.blob).deps, [c], "fixture needs c outside its boundary");
  const lower = bundle(doc, [r, x]);
  const middle = loose(doc, c);
  const batch = [upper, middle, lower];
  const bytes = await store(batch);
  const call = assertCausalPrefixes(batch, bytes);
  assert.ok(call(lower) < call(middle) && call(middle) < call(upper));
});

test("records that depend on each other persist through one atomic save", async () => {
  const { doc, hashes } = chain();
  const [r, x, c, z] = hashes;
  // The fragment holds x and z; the loose commit c needs x and z needs c.
  const cycle = bundle(doc, [x, z]);
  const between = loose(doc, c);
  const root = loose(doc, r);
  const batch = [cycle, between, root];
  const bytes = await store(batch);
  const call = assertCausalPrefixes(batch, bytes);
  assert.equal(call(cycle), call(between), "one saveMany call");
  assert.ok(call(root) < call(cycle));
  // Without saveMany the group is still written, in sequence.
  const sequential = await store(batch, { atomic: false });
  for (const record of batch)
    assert.ok(sequential.calls.some((keys) => keys.some((k) => k.endsWith(recordKey(record)))));
});

test("a reversed compacted history reaches storage in causal order", async () => {
  const fixture = buildPersistenceFixture({ rounds: 8 });
  try {
    const fragments = fixture.covering.filter((record) => record.kind === "fragment");
    assert.ok(fragments.length > 0, "the fixture is compacted");
    // Loose copies of covered changes and the fragment, newest first.
    const batch = [...fixture.loose, ...fixture.covering]
      .filter(
        (record, index, all) => all.findIndex((o) => recordKey(o) === recordKey(record)) === index,
      )
      .reverse();
    assertCausalPrefixes(batch, await store(batch));
  } finally {
    fixture.free();
  }
});

// Fixed actors and timestamps keep every change here a loose commit.
function diamond() {
  let root = A.change(A.init({ actor: "0d".repeat(16) }), { time: TIME }, (draft) => {
    draft.root = true;
  });
  const left = A.change(A.clone(root, { actor: "0e".repeat(16) }), { time: TIME + 1 }, (draft) => {
    draft.left = true;
  });
  const right = A.change(A.clone(root, { actor: "0f".repeat(16) }), { time: TIME + 2 }, (draft) => {
    draft.right = true;
  });
  let merged = A.merge(A.clone(left), right);
  merged = A.change(merged, { time: TIME + 3 }, (draft) => {
    draft.merged = true;
  });
  const [r] = A.getHeads(root);
  const [a] = A.getHeads(left);
  const [b] = A.getHeads(right);
  return { doc: merged, r, a, b };
}

async function reopenWithout(doc, lose) {
  const storage = new MemoryByteStore();
  const writer = createPeer({ storage });
  const peers = [writer];
  const handle = await writer.repo.import(A.save(doc));
  await writer.repo.flush();
  await writer.backend.flush();
  for (const hash of lose) {
    const [key] = (await storage.list("")).filter((k) => k.endsWith(`/commits/${hash}`));
    assert.ok(key, `${hash.slice(0, 8)} is stored as a loose commit`);
    await storage.remove(key);
  }
  const reader = createPeer({ storage });
  peers.push(reader);
  let timer;
  const found = Promise.race([
    reader.repo.find(handle.documentId),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("lookup did not settle")), 5000);
    }),
  ]).finally(() => clearTimeout(timer));
  return { found, close: () => closePeers(peers) };
}

for (const [shape, lose, frontier, missing] of [
  // A stored merge whose other branch is lost: no checkpoint tip materializes.
  ["missing branch of a merge", ({ b }) => [b], ({ a }) => [a], ({ b }) => [b]],
  ["missing middle of a chain", ({ a }) => [a], ({ r }) => [r], ({ a }) => [a]],
]) {
  test(`lookup becomes ready on the materialized frontier: ${shape}`, async () => {
    const fixture = diamond();
    assert.deepEqual(
      extractRecords(fixture.doc).map((record) => record.kind),
      ["commit", "commit", "commit", "commit"],
    );
    const { found, close } = await reopenWithout(
      shape.includes("chain") ? linear(fixture) : fixture.doc,
      lose(fixture),
    );
    try {
      const handle = await found;
      assert.deepEqual(A.getHeads(handle.doc()), frontier(fixture));
      assert.deepEqual(A.getMissingDeps(handle.doc(), []), missing(fixture));
      // The queued changes apply once the lost change arrives.
      const all = A.getChanges(A.init(), fixture.doc);
      const lost = all.filter((change) => lose(fixture).includes(A.decodeChange(change).hash));
      await handle.update((doc) => A.applyChanges(doc, lost)[0]);
      assert.deepEqual(A.getMissingDeps(handle.doc(), []), []);
    } finally {
      assert.deepEqual(await close(), []);
    }
  });
}
// r -> a -> (the left branch only) for the chain shape.
function linear({ doc, a }) {
  let chain = A.init({ actor: "0d".repeat(16) });
  for (const change of A.getChanges(A.init(), doc)) {
    const decoded = A.decodeChange(change);
    if (decoded.hash === a || decoded.deps.length === 0) [chain] = A.applyChanges(chain, [change]);
  }
  return A.change(chain, { time: TIME + 9 }, (draft) => {
    draft.after = true;
  });
}

test("lookup over stored history with no materializable change is unavailable", async () => {
  const fixture = diamond();
  const { found, close } = await reopenWithout(fixture.doc, [fixture.r]);
  try {
    await assert.rejects(found, /is unavailable/);
  } finally {
    assert.deepEqual(await close(), []);
  }
});
