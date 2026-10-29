import test from "node:test";
import assert from "node:assert/strict";
import { createPeer, connectPeers, closePeers, eventually } from "../../backend.mjs";
import { BufferedRecordStore, PageRecords, RemoteRecordSink } from "./record-persistence.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class Storage {
  values = new Map();
  async get(key) {
    return this.values.get(key);
  }
  barrier;
  entered = deferred();
  async put(values) {
    for (const [key, value] of Object.entries(values)) this.values.set(key, value.slice());
  }
  async delete(keys) {
    for (const key of keys) this.values.delete(key);
  }
  async sync() {
    if (this.barrier) {
      this.entered.resolve();
      await this.barrier.promise;
    }
  }
  async list({ prefix, startAfter = "", limit }) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([key]) => key.startsWith(prefix) && key > startAfter)
        .slice(0, limit),
    );
  }
}

function persistence() {
  const storage = new Storage();
  const owner = new PageRecords({ storage });
  const sink = new RemoteRecordSink({ fetch: (request) => owner.fetch(request) });
  return { storage, sink, live: new BufferedRecordStore(sink) };
}

async function flushHost(peer, store) {
  await peer.repo.flush();
  await peer.backend.flush();
  await store.flush();
}

// Native handshake, signed Subduction records, subscriptions and Automerge all
// run for real. The byte wire and separate persistence object's storage are in
// process; this does not emulate celld's output gate or object-store latency.
test(
  "native peers keep exchanging concurrent edits while durable storage is blocked",
  { timeout: 10000 },
  async () => {
    const f = persistence();
    const author = createPeer();
    const host = createPeer({ storage: f.live });
    const viewer = createPeer();
    const peers = [author, host, viewer],
      wires = [];
    let reopened;
    try {
      const a = await author.repo.create({ title: "base", left: "", right: "" });
      wires.push(await connectPeers(author, host));
      const h = await host.repo.find(a.documentId);
      wires.push(await connectPeers(viewer, host));
      const b = await viewer.repo.find(a.documentId);
      await flushHost(host, f.live);

      await a.change((doc) => {
        doc.title = "first pending edit";
      });
      await eventually(() => assert.equal(h.doc().title, "first pending edit"));
      f.storage.barrier = deferred();
      let acknowledged = false;
      const receipt = flushHost(host, f.live).then(() => {
        acknowledged = true;
      });
      await f.storage.entered.promise;

      await Promise.all([
        a.change((doc) => {
          doc.left = "author kept writing";
        }),
        b.change((doc) => {
          doc.right = "reader tab kept writing too";
        }),
      ]);
      await eventually(() => {
        for (const handle of [a, h, b]) {
          assert.equal(handle.doc().title, "first pending edit");
          assert.equal(handle.doc().left, "author kept writing");
          assert.equal(handle.doc().right, "reader tab kept writing too");
        }
      });
      assert.equal(acknowledged, false, "live convergence must not manufacture a durable receipt");

      f.storage.barrier.resolve();
      await receipt;
      assert.equal(f.live.dirty, true, "later edits are outside the first persistence batch");
      await flushHost(host, f.live);
      assert.equal(f.live.dirty, false);
      reopened = createPeer({ storage: new BufferedRecordStore(f.sink) });
      const restored = await reopened.repo.find(a.documentId);
      assert.deepEqual(
        restored.doc(),
        h.doc(),
        "acknowledged history restores without any connected author",
      );
    } finally {
      f.storage.barrier?.resolve();
      if (reopened) peers.push(reopened);
      assert.deepEqual(await closePeers(peers, wires), []);
    }
  },
);

test(
  "restart restores acknowledged history and a surviving author replays unacknowledged edits",
  { timeout: 10000 },
  async () => {
    const f = persistence();
    const author = createPeer();
    let host = createPeer({ storage: f.live });
    const peers = [author],
      wires = [];
    let hostClosed = false;
    try {
      const a = await author.repo.create({ title: "acknowledged base" });
      wires.push(await connectPeers(author, host));
      const h = await host.repo.find(a.documentId);
      await flushHost(host, f.live);
      await a.change((doc) => {
        doc.title = "not yet durable";
      });
      await eventually(() => assert.equal(h.doc().title, "not yet durable"));
      assert.equal(f.live.dirty, true);

      // Native shutdown flushes its accepted local replica, not the separate
      // durability owner. Discarding the live store models losing that pending RAM.
      assert.deepEqual(await closePeers([host], wires), []);
      hostClosed = true;
      const restoredStore = new BufferedRecordStore(f.sink);
      host = createPeer({ storage: restoredStore });
      hostClosed = false;
      const restored = await host.repo.find(a.documentId);
      assert.equal(restored.doc().title, "acknowledged base");
      wires.push(await connectPeers(author, host));
      await eventually(() => assert.equal(restored.doc().title, "not yet durable"));
      await flushHost(host, restoredStore);

      const offline = createPeer({ storage: new BufferedRecordStore(f.sink) });
      peers.push(offline);
      assert.equal((await offline.repo.find(a.documentId)).doc().title, "not yet durable");
    } finally {
      if (!hostClosed) peers.push(host);
      assert.deepEqual(await closePeers(peers, wires), []);
    }
  },
);
