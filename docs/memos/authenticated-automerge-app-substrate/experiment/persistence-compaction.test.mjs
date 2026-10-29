import test, { before, after } from "node:test";
let keepAlive;
before(() => {
  keepAlive = setInterval(() => {}, 1000);
});
after(() => clearInterval(keepAlive));
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  documentIdToBinary,
  generateAutomergeUrl,
  interpretAsDocumentId,
} from "@automerge/automerge-repo";
import { createPeer, connectPeers, closePeers, eventually } from "./backend.mjs";
import {
  BufferedRecordStore,
  PageRecords,
  RemoteRecordSink,
} from "./pages/worker/record-persistence.mjs";
import { assertSameIdentity, buildPersistenceFixture } from "./persistence-workload.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** In-process fault model for the real PageRecords protocol. A crash reopens only
 * the durability cut; successful put/remove is not automatically durable here.
 * This does not model provider output gates, replication, fsync, or failover. */
class DurabilityStorage {
  values = new Map();
  durable = new Map();
  deletions = [];
  beforeSync;
  afterSync;
  afterDelete;
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(values) {
    for (const [key, value] of Object.entries(values)) this.values.set(key, structuredClone(value));
  }
  async delete(keys) {
    for (const key of keys) {
      this.values.delete(key);
      this.deletions.push(key);
      await this.afterDelete?.(key);
    }
  }
  async sync() {
    await this.beforeSync?.();
    this.durable = structuredClone(this.values);
    await this.afterSync?.();
  }
  async list({ prefix, startAfter = "", limit = Infinity }) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([key]) => key.startsWith(prefix) && key > startAfter)
        .slice(0, limit),
    );
  }
  crashCopy() {
    const storage = new DurabilityStorage();
    storage.values = structuredClone(this.durable);
    storage.durable = structuredClone(this.durable);
    return storage;
  }
}

function persistence(storage = new DurabilityStorage()) {
  const owner = new PageRecords({ storage });
  const sink = new RemoteRecordSink({ fetch: (request) => owner.fetch(request) });
  return { storage, live: new BufferedRecordStore(sink) };
}

async function installed(fixture, p = persistence()) {
  const host = createPeer({ storage: p.live });
  const id = interpretAsDocumentId(generateAutomergeUrl());
  const tree = documentIdToBinary(id);
  await host.backend.storeSnapshot(tree, fixture.loose);
  await host.backend.flush();
  await p.live.flush();
  await host.backend.storeSnapshot(
    tree,
    fixture.covering.filter((r) => r.kind === "fragment"),
  );
  await host.backend.flush();
  return { host, id, tree, p };
}

test(
  "PageRecords durability wait leaves native edits and signed presence flowing before reclamation",
  { timeout: 15_000 },
  async () => {
    const fixture = buildPersistenceFixture({ rounds: 80 });
    assert.ok(fixture.metrics.coveringFragments > 0);
    const { host, id, tree, p } = await installed(fixture);
    const author = createPeer();
    const viewer = createPeer();
    const peers = [host, author, viewer],
      wires = [];
    const entered = deferred(),
      release = deferred();
    let maintenance;
    try {
      wires.push(await connectPeers(author, host), await connectPeers(viewer, host));
      const h = await host.repo.find(id, { signal: AbortSignal.timeout(5000) });
      const a = await author.repo.find(id, { signal: AbortSignal.timeout(5000) });
      const v = await viewer.repo.find(id, { signal: AbortSignal.timeout(5000) });
      await eventually(() => {
        assertSameIdentity(a.doc(), fixture.doc);
        assertSameIdentity(v.doc(), fixture.doc);
      });
      let first = true,
        completed = false;
      p.storage.beforeSync = async () => {
        if (!first) return;
        first = false;
        entered.resolve();
        await release.promise;
      };
      maintenance = host.backend.compact(tree, { durable: () => p.live.flush() }).then((value) => {
        completed = true;
        return value;
      });
      await entered.promise;
      assert.equal(
        p.storage.deletions.length,
        0,
        "no deletion before the real record-owner barrier",
      );
      await a.change((doc) => {
        A.splice(doc, ["blocks", "foundation", "richText"], 1, 0, "A live edit. ");
      });
      await v.change((doc) => {
        doc.extensions.futureType.concurrent = "viewer edit";
      });
      await eventually(() => {
        assert.ok(h.doc().blocks.foundation.richText.includes("A live edit."));
        assert.equal(a.doc().extensions.futureType.concurrent, "viewer edit");
        assert.ok(v.doc().blocks.foundation.richText.includes("A live edit."));
      });
      const presence = [];
      v.on("ephemeral-message", (event) => presence.push(event));
      a.broadcast({ blockId: "foundation", offset: 4 });
      await eventually(() =>
        assert.ok(
          presence.some(
            (event) => event.senderId === author.senderId && event.message.offset === 4,
          ),
        ),
      );
      assert.equal(completed, false, "native delivery is not a durability receipt");
      assert.equal(p.storage.deletions.length, 0);
      const expected = A.load(A.save(h.doc()));
      release.resolve();
      const result = await maintenance;
      assert.ok(result.removedRecords > 0, JSON.stringify(result));
      await p.live.flush();
      const restored = createPeer({ storage: persistence(p.storage.crashCopy()).live });
      peers.push(restored);
      try {
        const recovered = await restored.repo.find(id, { signal: AbortSignal.timeout(5000) });
        assertSameIdentity(recovered.doc(), expected);
      } finally {
        A.free(expected);
      }
    } finally {
      release.resolve();
      await maintenance?.catch(() => {});
      assert.deepEqual(await closePeers(peers, wires), []);
      fixture.free();
    }
  },
);

for (const phase of [
  "before-publication",
  "ambiguous-publication",
  "partial-deletion",
  "after-deletion",
]) {
  test(
    `real PageRecords protocol recovers full mixed-edit history after ${phase}`,
    { timeout: 10_000 },
    async () => {
      const fixture = buildPersistenceFixture({ rounds: 80 });
      const { host, id, tree, p } = await installed(fixture);
      const peers = [host];
      let barriers = 0;
      try {
        if (phase === "before-publication")
          p.storage.beforeSync = () => {
            throw Error("injected before publication");
          };
        if (phase === "ambiguous-publication")
          p.storage.afterSync = () => {
            throw Error("injected after publication");
          };
        if (phase === "partial-deletion")
          p.storage.afterDelete = () => {
            if (p.storage.deletions.length === 3) {
              p.storage.durable = structuredClone(p.storage.values);
              throw Error("injected durable deletion prefix");
            }
          };
        await assert.rejects(
          host.backend.compact(tree, {
            durable: async () => {
              await p.live.flush();
              if (++barriers === 2 && phase === "after-deletion")
                throw Error("injected after deletion");
            },
          }),
          /persist|injected/,
        );
        if (phase.includes("publication")) assert.equal(p.storage.deletions.length, 0);
        const restoredPersistence = persistence(p.storage.crashCopy());
        const restored = createPeer({ storage: restoredPersistence.live });
        peers.push(restored);
        const recovered = await restored.repo.find(id, { signal: AbortSignal.timeout(5000) });
        assertSameIdentity(recovered.doc(), fixture.doc);
        await restored.backend.compact(tree, { durable: () => restoredPersistence.live.flush() });
        assertSameIdentity(recovered.doc(), fixture.doc);
        const oldPeer = createPeer();
        peers.push(oldPeer);
        await oldPeer.backend.storeSnapshot(
          tree,
          A.getAllChanges(fixture.dormant).map((blob) => {
            const c = A.decodeChange(blob);
            return { kind: "commit", id: c.hash, parents: c.deps, blob };
          }),
        );
        const oldHandle = await oldPeer.repo.find(id, { signal: AbortSignal.timeout(5000) });
        const wires = [await connectPeers(oldPeer, restored)];
        const expected = A.merge(A.clone(fixture.doc), fixture.dormant);
        try {
          await eventually(() => {
            assertSameIdentity(recovered.doc(), expected);
            assertSameIdentity(oldHandle.doc(), expected);
          });
        } finally {
          A.free(expected);
          await Promise.all(wires.flat().map((wire) => wire.disconnect()));
        }
      } finally {
        assert.deepEqual(await closePeers(peers), []);
        fixture.free();
      }
    },
  );
}

test("a newly recorded reservation blocks deletion after the PageRecords durability wait", async () => {
  const fixture = buildPersistenceFixture({ rounds: 80 });
  const { host, tree, p } = await installed(fixture);
  const entered = deferred(),
    release = deferred();
  let maintenance;
  try {
    let once = true;
    p.storage.beforeSync = async () => {
      if (!once) return;
      once = false;
      entered.resolve();
      await release.promise;
    };
    maintenance = host.backend.compact(tree, { durable: () => p.live.flush() });
    await entered.promise;
    await host.backend.reserveRecords(
      tree,
      "pending-agent-intent",
      fixture.loose.slice(-1),
      async () => {},
    );
    release.resolve();
    assert.equal((await maintenance).skipped, "reservations");
    assert.equal(p.storage.deletions.length, 0);
    await host.backend.releaseReservation(tree, "pending-agent-intent");
    assert.ok(
      (await host.backend.compact(tree, { durable: () => p.live.flush() })).removedRecords > 0,
    );
  } finally {
    release.resolve();
    await maintenance?.catch(() => {});
    assert.deepEqual(await closePeers([host]), []);
    fixture.free();
  }
});
