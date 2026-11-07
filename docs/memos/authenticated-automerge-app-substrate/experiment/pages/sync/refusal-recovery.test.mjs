import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { DocStore, MemoryByteStore } from "./doc-store.mjs";
import { Refusal } from "./host.mjs";
import { browser, host, newId, raw, reconnect, until, urlOf } from "./test-helpers.mjs";
import { encodeFrame } from "./wire.mjs";

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
          const offered = [];
          client.link.host.onMessage((frame) => {
            if (frame.m) offered.push(A.decodeSyncMessage(frame.m));
          });
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
          if (!peerDelivery) assert.deepEqual(offered[0].have[0].lastSync, A.getHeads(base));
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

test("sync-state serialization preserves shared heads and bounds the first retry to missing history", (t) => {
  let base = A.from({ n: 0 }, { actor: "aa".repeat(16) });
  for (let n = 1; n < 800; n++)
    base = A.change(base, (d) => {
      d.n = n;
    });
  const heads = A.getHeads(base);
  const edited = A.change(A.clone(base, { actor: "bb".repeat(16) }), (d) => {
    d.n = 800;
  });
  const hash = A.getHeads(edited)[0];
  let state = {
    ...A.initSyncState(),
    sharedHeads: heads,
    theirHeads: heads,
    theirNeed: [],
    theirHave: [{ lastSync: heads, bloom: new Uint8Array() }],
    haveResponded: true,
  };
  [state] = A.generateSyncMessage(edited, state);
  assert.equal(state.sentHashes[hash], true);
  assert.equal(state.inFlight, true);
  const reset = A.decodeSyncState(A.encodeSyncState(state));
  assert.deepEqual(reset.sharedHeads, heads);
  assert.deepEqual(reset.sentHashes, {});
  assert.equal(reset.inFlight, false);
  assert.equal(reset.theirHeads, null);
  const measure = (start) => {
    let local = start;
    let sender = A.clone(edited);
    // The host retains its settled pre-refusal state; only the sender resets.
    let remote = {
      ...A.initSyncState(),
      sharedHeads: heads,
      lastSentHeads: heads,
      theirHeads: heads,
      theirNeed: [],
      theirHave: [{ lastSync: heads, bloom: new Uint8Array() }],
      haveResponded: true,
    };
    let doc = A.clone(base);
    const messages = [];
    let bytes = 0;
    for (let r = 1; r < 10; r++) {
      let message;
      [local, message] = A.generateSyncMessage(sender, local);
      if (!message) break;
      messages.push(A.decodeSyncMessage(message));
      bytes += encodeFrame({ t: "sync", doc: "01".repeat(16), m: message, r }).byteLength;
      [doc, remote] = A.receiveSyncMessage(doc, remote, message);
      [remote, message] = A.generateSyncMessage(doc, remote);
      bytes += encodeFrame({
        t: "sync",
        doc: "01".repeat(16),
        m: message,
        r,
        has: true,
        heads: A.getHeads(doc),
      }).byteLength;
      if (message) [sender, local] = A.receiveSyncMessage(sender, local, message);
    }
    assert.ok(A.hasHeads(doc, [hash]));
    const changes = messages.flatMap((m) => m.changes);
    assert.deepEqual(
      changes.map((c) => A.decodeChange(c).hash),
      [hash],
    );
    A.free(doc);
    A.free(sender);
    return { bytes, messages };
  };
  const before = measure(A.initSyncState());
  const after = measure(reset);
  assert.deepEqual(after.messages[0].have[0].lastSync, heads);
  assert.ok(
    after.messages[0].have[0].bloom.byteLength < before.messages[0].have[0].bloom.byteLength,
  );
  assert.ok(after.bytes < before.bytes);
  t.diagnostic(
    JSON.stringify({
      historyChanges: 800,
      beforeBytes: before.bytes,
      afterBytes: after.bytes,
      beforeBloom: before.messages[0].have[0].bloom.byteLength,
      afterBloom: after.messages[0].have[0].bloom.byteLength,
    }),
  );
  A.free(edited);
  A.free(base);
});

test(
  "reconnecting re-offers an edit whose refusal was lost on the closed socket",
  { timeout: 5000 },
  async (t) => {
    let entered, release;
    const entering = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { h, id, client, handle } = await fixture(t, {
      policy: {
        async admit(_conn, _doc, _live, _fresh, preview) {
          entered();
          await gate;
          return preview;
        },
      },
    });
    t.after(release);
    await handle.update((doc) =>
      A.change(doc, (d) => {
        d.n = 1;
      }),
    );
    const heads = A.getHeads(handle.doc());
    await entering;
    client.link.client.close();
    await until(() => client.conn.closed);
    release();
    await h.durableHeads(id);
    reconnect(client, h);
    assert.equal((await client.backend.synchronizeTree(id)).outcome, "complete");
    assert.deepEqual(await h.durableHeads(id), heads);
  },
);

for (const code of [
  "actor_claimed",
  "history_capacity",
  "malformed_change",
  "io",
  "closed",
  "missing_dependencies",
  "converting",
])
  test(
    `incoming host changes after ${code} are acknowledged without a retry storm`,
    { timeout: 5000 },
    async (t) => {
      let refusals = 0;
      const terminal = ["actor_claimed", "history_capacity", "malformed_change"].includes(code);
      const { h, id, base, client, handle } = await fixture(t, {
        policy: {
          admit(conn, _doc, _live, _fresh, preview) {
            if (conn.principal === "account:a") {
              refusals++;
              throw new Refusal(code, "refused");
            }
            return preview;
          },
        },
      });
      const store = new DocStore(client.bytes);
      const saved = await store.syncState(id);
      await handle.update((doc) =>
        A.change(doc, (d) => {
          d.n = 1;
        }),
      );
      const refusedHeads = A.getHeads(handle.doc());
      assert.equal((await client.backend.synchronizeTree(id)).outcome, "failed");
      const peer = await browser(h, { principal: "account:b" });
      t.after(() => peer.repo.shutdown());
      const other = await peer.repo.find(urlOf(id));
      await other.update((doc) =>
        A.change(doc, (d) => {
          d.peer = 1;
        }),
      );
      assert.equal((await peer.backend.synchronizeTree(id)).outcome, "complete");
      await until(() => handle.doc().peer === 1);
      await delay(50);
      assert.equal(refusals, terminal ? 1 : code === "missing_dependencies" ? 3 : 2);
      const sent = client.link.stats.framesAToB;
      await delay(50);
      assert.equal(client.link.stats.framesAToB, sent);
      // Another host change must arrive: the first one was acknowledged.
      await other.update((doc) =>
        A.change(doc, (d) => {
          d.peer = 2;
        }),
      );
      assert.equal((await peer.backend.synchronizeTree(id)).outcome, "complete");
      await until(() => handle.doc().peer === 2);
      await delay(50);
      assert.equal(refusals, terminal ? 1 : code === "missing_dependencies" ? 4 : 3);
      assert.equal((await h.document(id)).n, base.n);
      if (terminal) {
        await client.backend.flush();
        assert.deepEqual(
          await store.syncState(id),
          saved,
          "ack-only rounds must not persist sync progress",
        );
        const durableHeads = await h.durableHeads(id);
        const durable = await h.document(id);
        assert.equal(A.hasHeads(A.view(durable, durableHeads), refusedHeads), false);
        assert.equal((await client.backend.synchronizeTree(id)).outcome, "failed");
        assert.equal(refusals, 2, "explicit synchronize permits retry");
        const refused = new Promise((resolve) => {
          client.link.client.onMessage((frame) => {
            if (frame.t === "refused") resolve();
          });
        });
        await handle.update((doc) =>
          A.change(doc, (d) => {
            d.n = 2;
          }),
        );
        await refused;
        assert.equal(refusals, 3, "local store permits retry");
        reconnect(client, h);
        assert.equal((await client.backend.synchronizeTree(id)).outcome, "failed");
        // Bloom false positives can first send a descendant without its refused
        // parent. missing_dependencies permits a fresh explicit round.
        for (let retry = 0; refusals < 4 && retry < 3; retry++)
          assert.equal((await client.backend.synchronizeTree(id)).outcome, "failed");
        assert.equal(refusals, 4, "new connection permits retry");
      }
    },
  );

test(
  "explicit synchronize during a gated ack waits for its own refused round",
  { timeout: 5000 },
  async (t) => {
    const { h, id, client, handle } = await fixture(t, {
      policy: {
        admit(conn, _doc, _live, _fresh, preview) {
          if (conn.principal === "account:a") throw new Refusal("history_capacity", "full");
          return preview;
        },
      },
    });
    await handle.update((doc) =>
      A.change(doc, (d) => {
        d.n = 1;
      }),
    );
    assert.equal((await client.backend.synchronizeTree(id)).outcome, "failed");
    const peer = await browser(h, { principal: "account:b" });
    t.after(() => peer.repo.shutdown());
    const other = await peer.repo.find(urlOf(id));
    const send = client.link.host.send;
    const held = [];
    client.link.host.send = (frame) => {
      if (frame.r !== undefined) held.push(frame);
      else send(frame);
    };
    t.after(() => {
      client.link.host.send = send;
    });
    const outgoing = [];
    client.link.host.onMessage((frame) => {
      if (frame.t === "sync") outgoing.push(frame);
    });
    await other.update((doc) =>
      A.change(doc, (d) => {
        d.peer = 1;
      }),
    );
    assert.equal((await peer.backend.synchronizeTree(id)).outcome, "complete");
    await until(() => held.length > 0);
    const ack = held.shift();
    assert.equal(ack.t, "sync");
    assert.ok(
      outgoing.every((frame) => !frame.m || A.decodeSyncMessage(frame.m).changes.length === 0),
    );
    let settled = false;
    const round = client.backend.synchronizeTree(id).then((result) => {
      settled = true;
      return result;
    });
    send(ack);
    await until(() => held.some((frame) => frame.t === "refused"));
    assert.equal(settled, false, "finishing the ack must not report local durability");
    const refused = held.find((frame) => frame.t === "refused");
    assert.ok(refused.r > ack.r);
    assert.ok(
      outgoing.some(
        (frame) => frame.r > ack.r && frame.m && A.decodeSyncMessage(frame.m).changes.length > 0,
      ),
    );
    client.link.host.send = send;
    send(refused);
    assert.equal((await round).outcome, "failed");
    assert.equal((await h.document(id)).n, 0);
  },
);

for (const code of ["io", "history_capacity", "missing_dependencies"])
  test(
    `a late ${code} refusal does not finish or suppress a newer in-flight round`,
    { timeout: 5000 },
    async (t) => {
      const { h, id, client, handle } = await fixture(t, { syncTimeoutMs: 100 });
      const send = client.link.host.send;
      const replies = [];
      client.link.host.send = (frame) => {
        replies.push(frame);
      };
      await handle.update((doc) =>
        A.change(doc, (d) => {
          d.n = 1;
        }),
      );
      assert.equal((await client.backend.synchronizeTree(id)).outcome, "failed");
      const old = replies.find((f) => f.r !== undefined);
      assert.ok(old);
      let settled = false;
      const round = client.backend.synchronizeTree(id).then((result) => {
        settled = true;
        return result;
      });
      await until(() => replies.some((f) => f.r > old.r));
      send({ t: "refused", doc: id, r: old.r, code, message: "late refusal", fatal: false });
      await delay(10);
      assert.equal(settled, false);
      client.link.host.send = send;
      for (const frame of replies.filter((f) => f.r > old.r)) send(frame);
      assert.equal((await round).outcome, "complete");
      assert.deepEqual(await h.durableHeads(id), A.getHeads(handle.doc()));
    },
  );
