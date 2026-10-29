import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import {
  Repo,
  documentIdToBinary,
  generateAutomergeUrl,
  interpretAsDocumentId,
} from "@automerge/automerge-repo";
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge";
import { recordKey } from "@automerge/automerge-repo/sedimentree";
import {
  SubductionBackend,
  MemoryByteStore,
} from "./upstream/packages/automerge-repo-subduction/src/index.ts";
import { reclaimableRecords } from "./upstream/packages/automerge-repo-subduction/src/compaction.ts";
import { BufferedRecordStore } from "./pages/worker/record-persistence.mjs";
import { createPeer, connectPeers, closePeers, eventually } from "./backend.mjs";

let history = A.change(A.init({ actor: "a1".repeat(16) }), { time: 0 }, (doc) => {
  doc.text = "original text";
  doc.stable = { note: "preserve identity" };
  doc.count = 0;
});
const cursor = A.getCursor(history, ["text"], 4);
for (let i = 1; i <= 600; i++)
  history = A.change(history, { time: 0 }, (doc) => {
    doc.count = i;
  });
const loose = (doc) =>
  A.getAllChanges(doc).map((blob) => {
    const change = A.decodeChange(blob);
    return { kind: "commit", id: change.hash, parents: change.deps, blob };
  });
const records = loose(history);
// Preserve the exact loose encoding. extractRecords can use a different valid
// level-zero encoding, which the backend deliberately does not alias by hash.
const fragments = extractRecords(history).filter((record) => record.kind === "fragment");
assert.ok(fragments.length > 0);
const hashes = (doc) =>
  A.getAllChanges(doc)
    .map((change) => A.decodeChange(change).hash)
    .sort();
const noBarrier = async () => {};
const fresh = () => interpretAsDocumentId(generateAutomergeUrl());
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function peer(storage = new MemoryByteStore(), options = {}) {
  const signer = N.MemorySigner.fromBytes(new Uint8Array(32).fill(17));
  const backend = new SubductionBackend({ signer, storage, ...options });
  const repo = new Repo({ backend });
  return {
    storage,
    backend,
    repo,
    async close() {
      try {
        await repo.shutdown();
      } finally {
        await backend.close();
        signer.free();
      }
    },
  };
}
async function install(p, id = fresh()) {
  const tree = documentIdToBinary(id);
  await p.backend.storeSnapshot(tree, records);
  await p.backend.storeSnapshot(tree, fragments);
  return { id, tree };
}
async function content(p, id, expected = history) {
  const h = await p.repo.find(id, { signal: AbortSignal.timeout(5000) });
  assert.deepEqual(h.doc(), expected);
  assert.deepEqual(A.getHeads(h.doc()), A.getHeads(expected));
  assert.deepEqual(hashes(h.doc()), hashes(expected));
  assert.equal(A.getObjectId(h.doc().stable), A.getObjectId(expected.stable));
  assert.equal(A.getCursorPosition(h.doc(), ["text"], cursor), 4);
  return h;
}
async function entries(store) {
  return new Map(
    await Promise.all(
      (await store.list("subduction-v1/")).map(async (key) => [key, await store.load(key)]),
    ),
  );
}

test("native fragment reclamation preserves full CRDT history, cursors, object IDs and signed survivors", async () => {
  const p = peer();
  const { id, tree } = await install(p);
  let reopened;
  try {
    const before = await entries(p.storage);
    await assert.rejects(p.backend.compact(tree, {}), /durability barrier/);
    const result = await p.backend.compact(tree, { durable: noBarrier });
    assert.ok(result.removedRecords > 0, JSON.stringify(result));
    assert.ok(result.removedBytes > 0);
    const after = await entries(p.storage);
    assert.equal(before.size - after.size, result.removedRecords);
    for (const [key, value] of after)
      assert.deepEqual(value, before.get(key), "signed envelopes stay byte-for-byte intact");
    await content(p, id);
    await p.close();
    reopened = peer(p.storage);
    await content(reopened, id);
    assert.equal((await reopened.backend.compact(tree, { durable: noBarrier })).removedRecords, 0);
  } finally {
    if (reopened) await reopened.close();
    else await p.close();
  }
});

test("metadata claims cannot authorize deleting an unrelated change or a partially covered bundle", () => {
  const fragment = fragments[0];
  const keep = new Set([recordKey(fragment)]);
  const bundled = new Set(A.readBundle(fragment.blob).changes.map((change) => change.hash));
  const unrelated = records.find((record) => !bundled.has(record.id));
  assert.ok(unrelated);
  const lying = { ...fragment, boundary: [unrelated.id] };
  assert.deepEqual(reclaimableRecords([lying, unrelated], [unrelated], keep), []);
  const covered = records.find((record) => bundled.has(record.id));
  assert.equal(reclaimableRecords([fragment, covered], [covered], keep).length, 1);
  const tip = records.at(-1);
  const partial = {
    kind: "fragment",
    head: tip.id,
    boundary: [],
    checkpoints: [],
    blob: A.saveBundle(history, [tip.id]),
  };
  assert.notEqual(partial.head, fragment.head);
  assert.ok(
    A.readBundle(partial.blob).deps.length > 0,
    "proof fixture has dependencies outside its bundle",
  );
  assert.deepEqual(
    reclaimableRecords([partial, fragment], [fragment], new Set([recordKey(partial)])),
    [],
  );
  const empty = { ...partial, blob: A.saveBundle(history, []) };
  assert.throws(() => reclaimableRecords([empty, covered], [covered], new Set([recordKey(empty)])));
  const corrupt = { ...fragment, blob: fragment.blob.slice() };
  corrupt.blob[corrupt.blob.length - 1] ^= 1;
  assert.throws(() => reclaimableRecords([corrupt, covered], [covered], keep));
});

test("an outstanding exact reservation prevents reclamation and release permits it", async () => {
  const p = peer();
  try {
    const { tree } = await install(p);
    await p.backend.reserveRecords(tree, "pending", records, noBarrier);
    let barriers = 0;
    assert.equal(
      (
        await p.backend.compact(tree, {
          durable: async () => {
            barriers++;
          },
        })
      ).skipped,
      "reservations",
    );
    assert.equal(barriers, 0);
    await p.backend.releaseReservation(tree, "pending");
    assert.ok((await p.backend.compact(tree, { durable: noBarrier })).removedRecords > 0);
  } finally {
    await p.close();
  }
});

test("a reservation admitted while the durability barrier waits cancels deletion", async () => {
  const p = peer(),
    entered = deferred(),
    release = deferred();
  try {
    const { tree } = await install(p);
    const before = await entries(p.storage);
    const pending = p.backend.compact(tree, {
      durable: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    await p.backend.reserveRecords(tree, "arrived-during-flush", records, noBarrier);
    release.resolve();
    assert.equal((await pending).skipped, "reservations");
    assert.deepEqual(await entries(p.storage), before);
    await p.backend.releaseReservation(tree, "arrived-during-flush");
  } finally {
    release.resolve();
    await p.close();
  }
});

class Sink {
  durable = new Map();
  commits = 0;
  failCommit;
  failAfter;
  async *snapshot() {
    for (const entry of this.durable) yield entry;
  }
  async commit(batch) {
    this.commits++;
    let applied = 0;
    for (const [key, value] of batch) {
      if (this.failCommit === this.commits && this.failAfter === applied)
        throw Error("injected partial persistence failure");
      if (value === undefined) this.durable.delete(key);
      else this.durable.set(key, value.slice());
      applied++;
    }
    if (this.failCommit === this.commits) throw Error("injected ambiguous persistence failure");
  }
}

for (const phase of ["before-publish", "after-publish", "during-delete", "after-delete"])
  test(`buffered crash ${phase} preserves every original Automerge change`, async () => {
    const sink = new Sink(),
      store = new BufferedRecordStore(sink),
      p = peer(store);
    const id = fresh(),
      tree = documentIdToBinary(id);
    let reopened;
    try {
      await p.backend.storeSnapshot(tree, records);
      await store.flush();
      await p.backend.storeSnapshot(tree, fragments);
      const before = await entries(store);
      let barriers = 0;
      const durable = async () => {
        barriers++;
        if (phase === "before-publish" && barriers === 1)
          throw Error("injected before publication");
        if (phase === "during-delete" && barriers === 2) {
          sink.failCommit = sink.commits + 1;
          sink.failAfter = 3;
        }
        await store.flush();
        if (phase === "after-publish" && barriers === 1) throw Error("injected after publication");
        if (phase === "after-delete" && barriers === 2) throw Error("injected after deletion");
      };
      await assert.rejects(p.backend.compact(tree, { durable }), /injected/);
      if (barriers === 1)
        assert.deepEqual(await entries(store), before, "no removal before publication succeeds");
      await p.close();
      sink.failCommit = undefined;
      reopened = peer(new BufferedRecordStore(sink));
      await content(reopened, id);
      // Restart may retain any safe deletion prefix; repeating compaction is safe.
      await reopened.backend.compact(tree, { durable: () => reopened.storage.flush() });
      await content(reopened, id);
    } finally {
      if (reopened) await reopened.close();
      else await p.close();
    }
  });

test(
  "native edits keep flowing while compaction waits for remote durability",
  { timeout: 15000 },
  async () => {
    const host = createPeer(),
      author = createPeer(),
      viewer = createPeer();
    const peers = [host, author, viewer],
      wires = [];
    const entered = deferred(),
      release = deferred();
    try {
      const id = fresh(),
        tree = documentIdToBinary(id);
      await host.backend.storeSnapshot(tree, records);
      await host.backend.storeSnapshot(tree, fragments);
      wires.push(await connectPeers(author, host), await connectPeers(viewer, host));
      const h = await host.repo.find(id),
        a = await author.repo.find(id),
        v = await viewer.repo.find(id);
      let barriers = 0;
      const compact = host.backend.compact(tree, {
        durable: async () => {
          if (++barriers === 1) {
            entered.resolve();
            await release.promise;
          }
        },
      });
      await entered.promise;
      await a.change((doc) => {
        doc.live = "arrived while persistence waits";
      });
      await eventually(() => {
        assert.equal(h.doc().live, "arrived while persistence waits");
        assert.equal(v.doc().live, "arrived while persistence waits");
      });
      release.resolve();
      assert.ok((await compact).removedRecords > 0);
    } finally {
      release.resolve();
      assert.deepEqual(await closePeers(peers, wires), []);
    }
  },
);

for (const failureAt of [1, 4, 100, 300])
  test(`partial local removal at ${failureAt} preserves accounting and restart reclamation`, async () => {
    class FailingStore extends MemoryByteStore {
      removes = 0;
      fail = true;
      async remove(key) {
        await super.remove(key);
        if (this.fail && ++this.removes === failureAt) throw Error("injected removal prefix");
      }
    }
    const store = new FailingStore(),
      p = peer(store);
    let reopened;
    try {
      const { id, tree } = await install(p);
      await assert.rejects(
        p.backend.compact(tree, { durable: noBarrier }),
        /injected removal prefix/,
      );
      await p.backend.flush().catch(() => {});
      await content(p, id);
      await p.close();
      store.fail = false;
      reopened = peer(store);
      await content(reopened, id);
      const retry = await reopened.backend.compact(tree, { durable: noBarrier });
      assert.ok(retry.removedRecords > 0, JSON.stringify(retry));
      await content(reopened, id);
    } finally {
      if (reopened) await reopened.close();
      else await p.close();
    }
  });

test("reclaimed capacity admits a fresh record and exact snapshot retry restores exact records", async () => {
  const p = peer(undefined, { maxRecords: records.length + fragments.length });
  const entered = deferred(),
    release = deferred();
  try {
    const { tree } = await install(p);
    const nextDoc = A.change(A.clone(history), { time: 0 }, (doc) => {
      doc.after = "new";
    });
    const next = loose(nextDoc).find((record) => !records.some((old) => old.id === record.id));
    await assert.rejects(p.backend.store(tree, [next]), /snapshot limit/i);
    await p.backend.flush().catch(() => {}); // Retire the deliberately rejected capacity attempt.
    const pending = p.backend.compact(tree, {
      durable: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    let acknowledged = false;
    const retried = p.backend.storeSnapshot(tree, records).then(() => {
      acknowledged = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      acknowledged,
      false,
      "exact snapshot acknowledgment cannot race maintenance deletion",
    );
    release.resolve();
    assert.ok((await pending).removedRecords > 0);
    await retried;
    assert.equal(
      (await entries(p.storage)).size,
      records.length + fragments.length + 1,
      "exact retry restores each original record plus marker",
    );
    await p.backend.compact(tree, { durable: noBarrier });
    await p.backend.store(tree, [next]);
    A.free(nextDoc);
  } finally {
    release.resolve();
    await p.close();
  }
});

test(
  "a dormant native peer merges its offline edits after host reclamation",
  { timeout: 15000 },
  async () => {
    const host = createPeer(),
      dormant = createPeer();
    const peers = [host, dormant],
      wires = [];
    try {
      const id = fresh(),
        tree = documentIdToBinary(id);
      await host.backend.storeSnapshot(tree, records);
      await dormant.backend.storeSnapshot(tree, records);
      const old = await dormant.repo.find(id);
      await old.change((doc) => {
        doc.offline = "authored before reconnect";
      });
      await host.backend.storeSnapshot(tree, fragments);
      assert.ok((await host.backend.compact(tree, { durable: noBarrier })).removedRecords > 0);
      const current = await host.repo.find(id);
      await current.change((doc) => {
        doc.online = "authored after reclamation";
      });
      wires.push(await connectPeers(dormant, host));
      await eventually(() => {
        assert.equal(current.doc().offline, "authored before reconnect");
        assert.equal(old.doc().online, "authored after reclamation");
        assert.deepEqual(A.getHeads(current.doc()), A.getHeads(old.doc()));
        assert.deepEqual(hashes(current.doc()), hashes(old.doc()));
      });
      assert.equal(A.getObjectId(current.doc().stable), A.getObjectId(history.stable));
      assert.equal(A.getCursorPosition(current.doc(), ["text"], cursor), 4);
    } finally {
      assert.deepEqual(await closePeers(peers, wires), []);
    }
  },
);
