import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { AutomergeSyncBackend } from "./backend.mjs";
import { DocStore, MemoryByteStore, concat } from "./doc-store.mjs";
import { SyncHost, Refusal } from "./host.mjs";
import { encodeFrame, decodeFrame } from "./wire.mjs";

for (const reject of [false, true])
  test(`queued-orphan recovery respects actual peer reset: reject=${reject}`, async (t) => {
    const actor = (n) => n.toString(16).padStart(32, "0"),
      id = "02".repeat(32);
    let base = A.init({ actor: actor(1) });
    for (let n = 0; n < 40; n++)
      base = A.change(base, { time: 0 }, (d) => {
        d.n = n;
      });
    const parent = A.change(A.clone(base, { actor: actor(2) }), { time: 0 }, (d) => {
      d.parent = 1;
    });
    const other = A.change(A.clone(base, { actor: actor(3) }), { time: 0 }, (d) => {
      d.remote = 1;
    });
    const remote = A.merge(A.clone(parent), A.clone(other));
    let desc = A.change(A.clone(parent, { actor: actor(225) }), { time: 0 }, (d) => {
      d.child = 1;
    });
    desc = A.change(desc, { time: 0 }, (d) => {
      d.child = 2;
    });
    const x = A.change(A.clone(base, { actor: actor(10000) }), { time: 0 }, (d) => {
      d.x = 1273;
    });
    const local = A.loadIncremental(
      A.clone(x),
      concat(A.getChangesSince(desc, A.getHeads(parent))),
    );
    const store = new DocStore(new MemoryByteStore());
    await store.compact(id, A.save(local), A.getHeads(local));
    await store.saveSyncState(
      id,
      A.encodeSyncState({ ...A.initSyncState(), sharedHeads: A.getHeads(base) }),
    );
    const b = await AutomergeSyncBackend.load({ store });
    const bytes = new MemoryByteStore();
    const h = await new SyncHost({
      bytes,
      policy: reject
        ? {
            admit() {
              throw new Refusal("history_capacity", "synthetic");
            },
          }
        : {},
    }).load();
    await h.seed(id, "page", A.clone(remote));
    const q = [];
    const ends = [0, 1].map((direction) => ({
      send: (f) => q.push({ direction, bytes: encodeFrame(f) }),
      onMessage(fn) {
        this.recv = fn;
      },
      onClose(fn) {
        this.closed = fn;
      },
      close() {
        this.closed?.();
      },
    }));
    h.accept(ends[1], { principal: "account:a", role: "editor" });
    b.addConnection(ends[0]);
    let outcome;
    const p = b
      .synchronizeTree(id)
      .then((r) => {
        outcome = r.outcome;
      })
      .catch((e) => {
        outcome = e.code;
      });
    const trace = [];
    for (let i = 0; i < 40 && q.length; i++) {
      const { direction, bytes } = q.shift(),
        f = decodeFrame(bytes),
        m = f.m && A.decodeSyncMessage(f.m);
      trace.push({
        direction,
        r: f.r,
        code: f.code,
        changes: m?.changes.length,
        have: m?.have.map((x) => x.lastSync),
        need: m?.need,
      });
      ends[1 - direction].recv(f);
      await h.durableHeads(id);
      await b.flush();
    }
    t.diagnostic(
      JSON.stringify({
        outcome: outcome ?? "pending",
        frames: trace.length,
        remaining: q.length,
        trace,
      }),
    );
    try {
      assert.equal(q.length, 0, "bounded native exchange without empty reset loop");
      assert.equal(outcome, reject ? "failed" : "complete");
      assert.ok(trace.some((f) => f.code === "missing_dependencies"));
      assert.ok(
        trace.some((f) => f.direction === 1 && f.r === 3 && f.have?.[0]?.length === 0),
        "actual peer reset advertisement retained",
      );
      const reopened = await new SyncHost({ bytes }).load();
      reopened.register(id);
      const read = await store.read(id);
      const restored = A.load(concat([read.snapshot, ...read.chunks].filter(Boolean)));
      assert.ok(A.hasHeads(restored, A.getHeads(desc)), "unqueued descendants retained locally");
      if (!reject) {
        const hashes = (doc) =>
          A.getAllChanges(doc)
            .map((c) => A.decodeChange(c).hash)
            .sort();
        assert.deepEqual(hashes(await reopened.document(id)), hashes(restored));
        assert.deepEqual(await h.durableHeads(id), A.getHeads(restored));
      } else assert.deepEqual(await h.durableHeads(id), A.getHeads(remote));
      A.free(restored);
    } finally {
      await b.close();
      await p;
      for (const d of [base, parent, other, remote, desc, x, local]) A.free(d);
    }
  });
