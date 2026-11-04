import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { DocStore, MemoryByteStore } from "./doc-store.mjs";
import { Refusal } from "./host.mjs";
import { browser, host, newId, raw, until, urlOf } from "./test-helpers.mjs";

const history = (doc) =>
  A.getAllChanges(doc)
    .map((c) => A.decodeChange(c).hash)
    .sort();

async function fixture(t, { trusted = false, policy, syncTimeoutMs = 1000 } = {}) {
  const bytes = new MemoryByteStore();
  const h = await host({ bytes, policy });
  const id = newId();
  const base = A.from({ n: 0 });
  await h.seed(id, "page", base);
  const client = await browser(
    h,
    { trusted, principal: "account:a" },
    {
      scheduleLocalSync: (_id, start) => start(),
      syncTimeoutMs,
    },
  );
  t.after(() => client.repo.shutdown());
  const handle = await client.repo.find(urlOf(id));
  assert.equal((await client.backend.synchronizeTree(id)).outcome, "complete");
  await client.backend.flush();
  return { bytes, h, id, base, client, handle };
}

for (const trusted of [false, true])
  for (const committed of [false, true])
    for (const peerDelivery of [false, true])
      test(
        `io refusal recovery: trusted=${trusted}, committed=${committed}, peer=${peerDelivery}`,
        { timeout: 5000 },
        async (t) => {
          const { bytes, h, id, base, client, handle } = await fixture(t, { trusted });
          const save = bytes.saveMany.bind(bytes);
          bytes.saveMany = async (entries) => {
            if (committed) await save(entries);
            throw Error("injected append rejection");
          };
          t.after(() => {
            bytes.saveMany = save;
          });
          await handle.update((doc) =>
            A.change(doc, (d) => {
              d.n = 1;
            }),
          );
          const edited = A.clone(handle.doc());
          t.after(() => A.free(edited));
          const failed = await client.backend.synchronizeTree(id);
          assert.equal(failed.outcome, "failed");
          assert.equal(failed.peers[0].outcome, "failed");
          assert.equal(client.conn.closed, false, "io refusal leaves the connection open");
          bytes.saveMany = save;
          let expected = edited;
          if (peerDelivery) {
            const peer = raw(h, { principal: "account:b", role: "editor" });
            t.after(() => peer.link.client.close());
            const other = A.change(A.clone(base), (d) => {
              d.peer = "survived";
            });
            const helloDoc = A.init();
            const message = A.decodeSyncMessage(
              A.generateSyncMessage(helloDoc, A.initSyncState())[1],
            );
            A.free(helloDoc);
            message.changes = [A.getLastLocalChange(other)];
            peer.link.client.send({ t: "sync", doc: id, m: A.encodeSyncMessage(message), r: 1 });
            await until(() => peer.frames.some((f) => f.r === 1));
            assert.equal(peer.frames.find((f) => f.r === 1).t, "sync");
            expected = A.merge(A.clone(edited), other);
            A.free(other);
            t.after(() => A.free(expected));
          }
          assert.equal((await client.backend.synchronizeTree(id)).outcome, "complete");
          assert.deepEqual((await h.durableHeads(id)).sort(), A.getHeads(expected).sort());
          // A new host loads only durable bytes, not cached documents or manifests.
          const reopened = await host({ bytes });
          reopened.register(id);
          const restored = await reopened.document(id);
          assert.deepEqual(restored, expected);
          assert.deepEqual(A.getHeads(restored).sort(), A.getHeads(expected).sort());
          assert.deepEqual(history(restored), history(expected));
        },
      );

test(
  "a repeated non-fatal policy refusal ends each round without spinning or saving sync state",
  { timeout: 5000 },
  async (t) => {
    const { h, id, client, handle } = await fixture(t, {
      syncTimeoutMs: 50,
      policy: {
        admit() {
          throw new Refusal("history_capacity", "History is full");
        },
      },
    });
    const store = new DocStore(client.bytes);
    const saved = await store.syncState(id);
    assert.ok(saved);
    const frames = [];
    client.link.client.onMessage((frame) => {
      if (frame.t === "refused") frames.push(frame);
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = client.link.stats.framesAToB;
      if (attempt !== 1)
        await handle.update((doc) =>
          A.change(doc, (d) => {
            d.n++;
          }),
        );
      const result = await client.backend.synchronizeTree(id);
      assert.equal(result.outcome, "failed");
      assert.equal(result.peers[0].outcome, "failed");
      assert.equal(frames.length, attempt + 1);
      assert.equal(frames.at(-1).code, "history_capacity");
      assert.equal(frames.at(-1).fatal, false);
      const sent = client.link.stats.framesAToB;
      assert.ok(sent - before <= 3, "one bounded handshake per explicit attempt");
      const received = client.link.stats.framesBToA;
      // Longer than syncTimeoutMs: neither Repo nor the old frame timer retries.
      await delay(150);
      assert.equal(client.link.stats.framesAToB, sent);
      assert.equal(client.link.stats.framesBToA, received);
      await client.backend.flush();
      assert.deepEqual(await store.syncState(id), saved, "failed rounds do not persist a reset");
    }
    assert.equal(client.conn.closed, false);
    assert.equal((await h.document(id)).n, 0);
  },
);
