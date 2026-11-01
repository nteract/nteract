import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import { generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import {
  extractRecords,
  getRecordMetadata,
  recordMetadataKey,
} from "@automerge/automerge-repo/sedimentree/automerge";
import { recordBytes, sedimentreeId } from "@automerge/automerge-repo/sedimentree";
import { MemoryByteStore } from "@automerge/automerge-repo-subduction";
import {
  StorageBridge,
  nativeId,
  unsigned,
} from "./upstream/packages/automerge-repo-subduction/src/storage.ts";
import { closePeers, connectPeers, createPeer, eventually, treeId } from "./backend.mjs";

const limits = {
  maxRecordBytes: 1 << 20,
  maxSnapshotBytes: 16 << 20,
  maxRecords: 1000,
  batchRecords: 128,
};
const TIME = 1_790_000_000;
const recordKey = (record) =>
  record.kind === "commit" ? `commits/${record.id}` : `fragments/${record.head}`;

/** Byte store that logs saves and can fail one save before writing it. */
class Store {
  values = new Map();
  saves = [];
  failAt;
  async load(key) {
    return this.values.get(key)?.slice();
  }
  async list(prefix) {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }
  async save(key, value) {
    if (this.saves.length === this.failAt) throw new Error("injected save failure");
    this.values.set(key, value.slice());
    this.saves.push(key);
  }
  async remove(key) {
    this.values.delete(key);
  }
}

/** Loose commits on one actor, fixed timestamps. `payloads[i]`, when given,
 * is the size of incompressible bytes change i stores, to set record sizes. */
function looseCommits(n, payloads = []) {
  let doc = A.init({ actor: "0e".repeat(16) });
  let state = 7;
  const noise = (size) =>
    Uint8Array.from({ length: size }, () => (state = (state * 1103515245 + 12345) >>> 0) >>> 24);
  for (let i = 0; i < n; i++)
    doc = A.change(doc, { time: TIME + i }, (draft) => {
      draft[`k${i}`] = payloads[i] ? noise(payloads[i]) : i;
    });
  return A.getAllChanges(doc).map((blob) => {
    const change = A.decodeChange(blob);
    return { kind: "commit", id: change.hash, parents: change.deps, blob };
  });
}

async function storeBatch(store, records, events, bounds = limits) {
  const signer = N.MemorySigner.fromBytes(new Uint8Array(32).fill(44));
  const bridge = new StorageBridge(
    store,
    bounds,
    (_id, batch) => events.push({ type: "notify", keys: batch.map(recordKey) }),
    () => events.push({ type: "failed" }),
  );
  const engine = new N.Subduction({ signer, storage: bridge });
  const id = nativeId(sedimentreeId("ce".repeat(16)));
  try {
    await engine.storeBuiltBatch(
      id,
      records.map((r) => new N.CommitInput(unsigned(id, r), r.blob)),
      [],
    );
  } finally {
    await engine.disconnectAll();
    await bridge.drain();
    engine.free();
    id.free();
    signer.free();
  }
}

const savedRecordKeys = (store) =>
  store.saves
    .filter((key) => !key.endsWith("/id"))
    .map((key) => key.split("/").slice(-2).join("/"));

test("a native batch notifies every saved record once, in save order, in bounded chunks", async () => {
  const records = looseCommits(300);
  const store = new Store();
  const events = [];
  await storeBatch(store, records, events);
  const notified = events.flatMap((event) => event.keys);
  assert.deepEqual(notified, savedRecordKeys(store), "save order, each record once");
  assert.deepEqual([...notified].sort(), records.map(recordKey).sort());
  assert.deepEqual(
    events.map((event) => event.keys.length),
    [128, 128, 44],
  );
});

test("a chunk never crosses the byte bound; a record over it is notified alone", async () => {
  // One actor's chain, so dependencies fix the save order to the input order.
  const records = looseCommits(7, [400, 400, 400, 4000, 400, 400, 400]);
  const sizes = new Map(records.map((record) => [recordKey(record), recordBytes(record)]));
  const small = Math.max(...[0, 1, 2, 4, 5, 6].map((i) => recordBytes(records[i])));
  const batchBytes = Math.floor(small * 2.5);
  assert.ok(recordBytes(records[3]) > batchBytes, "fixture needs one record over the bound");
  assert.ok(
    Math.min(...[0, 1, 2].map((i) => recordBytes(records[i]))) * 3 > batchBytes,
    "fixture needs three small records to cross the bound",
  );
  const store = new Store();
  const events = [];
  await storeBatch(store, records, events, { ...limits, batchBytes });
  assert.deepEqual(
    events.flatMap((event) => event.keys),
    records.map(recordKey),
  );
  // Two small records fit; the third would cross and starts a chunk; that
  // partial chunk is sent before the oversized record, which goes alone.
  assert.deepEqual(
    events.map((event) => event.keys.length),
    [2, 1, 1, 2, 1],
  );
  for (const { keys } of events)
    if (keys.length > 1)
      assert.ok(keys.reduce((total, key) => total + sizes.get(key), 0) <= batchBytes);
});

test("a failed native batch notifies its resolved prefix before reporting the failure", async () => {
  const records = looseCommits(200);
  const store = new Store();
  store.failAt = 151; // Fails after one full chunk and part of the next.
  const events = [];
  await assert.rejects(storeBatch(store, records, events), /injected save failure/);
  const notified = events.filter((event) => event.type === "notify").flatMap((e) => e.keys);
  assert.ok(notified.length > 128 && notified.length < records.length, `${notified.length}`);
  assert.deepEqual(notified, savedRecordKeys(store));
  const failed = events.findIndex((event) => event.type === "failed");
  assert.ok(failed > 0, "failure reported");
  assert.ok(
    events.slice(failed).every((event) => event.type === "failed"),
    "every resolved save notifies before the owner sees the failure",
  );
});

const words = "alpha beta gamma delta epsilon zeta eta theta".split(" ");
function edit(doc, i) {
  if (i % 40 === 0) doc = A.clone(doc, ["a1", "b2", "c3"][(i / 40) % 3].repeat(16));
  return A.change(doc, { time: TIME + i }, (draft) => {
    A.splice(draft, ["text"], (i * 7) % (draft.text.length + 1), 0, `${words[i % words.length]} `);
  });
}

test("catch-up with local edits converges, notifies every change, and submits only new representation", async () => {
  let doc = A.from({ text: "" }, { actor: "f0".repeat(16) });
  for (let i = 0; i < 400; i++) doc = edit(doc, i);
  const base = A.clone(doc);
  for (let i = 400; i < 1200; i++) doc = edit(doc, i);

  const id = interpretAsDocumentId(generateAutomergeUrl());
  const tree = treeId(id);
  const host = createPeer();
  await host.backend.storeSnapshot(tree, extractRecords(doc));
  const storage = new MemoryByteStore();
  const seeder = createPeer({ storage });
  await seeder.backend.storeSnapshot(tree, extractRecords(base));
  await closePeers([seeder]);

  const receiver = createPeer({ storage });
  const peers = [host, receiver];
  const wires = [];
  try {
    const handle = await receiver.repo.find(id);
    assert.deepEqual(A.getHeads(handle.doc()).sort(), A.getHeads(base).sort());

    // Everything the delegate submits for local edits.
    const submitted = [];
    const store = receiver.backend.store.bind(receiver.backend);
    receiver.backend.store = (tree, records) => {
      submitted.push(...records.map(recordKey));
      return store(tree, records);
    };
    // What a whole-document rescan before each edit would submit.
    const expected = new Set();
    let edits = 0;
    const localEdit = () => {
      const represented = new Set(getRecordMetadata(handle.doc()).map(recordMetadataKey));
      handle.change((draft) => A.splice(draft, ["text"], 0, 0, `local${edits++} `));
      for (const record of extractRecords(
        handle.doc(),
        (meta) => !represented.has(recordMetadataKey(meta)),
      ))
        expected.add(recordKey(record));
    };

    // Consumers must see one unbroken chain of heads from the cached copy to
    // the final document, so no change can go unnotified.
    const chain = [];
    handle.on("change", ({ patchInfo }) => {
      chain.push([A.getHeads(patchInfo.before).sort(), A.getHeads(patchInfo.after).sort()]);
      // A listener edit lands between incoming batches.
      if (chain.length <= 3) localEdit();
    });
    const timer = setInterval(() => edits < 12 && localEdit(), 3);
    const start = A.getHeads(handle.doc()).sort();
    wires.push(await connectPeers(receiver, host));
    const hostHandle = await host.repo.find(id);
    const target = A.getHeads(doc);
    await eventually(
      () => target.every((head) => A.hasHeads(handle.doc(), [head])) && edits >= 4,
      30_000,
    );
    clearInterval(timer);
    await eventually(
      () => A.getHeads(hostHandle.doc()).sort().join() === A.getHeads(handle.doc()).sort().join(),
      30_000,
    );

    const final = handle.doc();
    assert.ok(edits >= 4, "local edits interleaved with catch-up");
    assert.deepEqual(A.toJS(final), A.toJS(hostHandle.doc()));
    assert.equal(A.getAllChanges(final).length, A.getAllChanges(doc).length + edits);
    for (let i = 0; i < edits; i++) assert.match(final.text, new RegExp(`local${i} `));

    assert.deepEqual(chain[0][0], start);
    for (let i = 1; i < chain.length; i++) assert.deepEqual(chain[i][0], chain[i - 1][1]);
    assert.deepEqual(chain.at(-1)[1], A.getHeads(final).sort());

    await receiver.repo.flush();
    assert.deepEqual(new Set(submitted), expected);
  } finally {
    await closePeers(peers, wires);
  }
});
