import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import * as A from "@automerge/automerge";
import { AutomergeSyncBackend, dependencyRecoveryStep } from "./backend.mjs";
import { concat, DocStore, MemoryByteStore } from "./doc-store.mjs";
import { Refusal } from "./host.mjs";
import { host } from "./test-helpers.mjs";
import { MAX_FRAME_BYTES, decodeFrame, encodeFrame } from "./wire.mjs";

const id = "02".repeat(32);
const history = (doc) =>
  A.getAllChanges(doc)
    .map((c) => A.decodeChange(c).hash)
    .sort();

// Synthetic fixtures only. No production hooks or document-content logging.
async function fixture(t, policy, onRefusal) {
  const base = A.change(A.init({ actor: "01".repeat(16) }), { time: 0 }, (d) => {
    d.n = 0;
  });
  let local = A.clone(base, { actor: (20).toString(16).padStart(32, "0") });
  local = A.change(local, { time: 0 }, (d) => {
    d.n = 1;
  });
  local = A.change(local, { time: 0 }, (d) => {
    d.n = 2;
  });
  const remote = A.change(A.clone(base, { actor: "ff".repeat(16) }), { time: 0 }, (d) => {
    d.peer = 1;
  });
  const bytes = new MemoryByteStore();
  const h = await host({ bytes, policy });
  await h.seed(id, "page", remote);
  const clientBytes = new MemoryByteStore();
  const starts = new Map();
  let closed = false;
  const backend = await AutomergeSyncBackend.load({
    store: new DocStore(clientBytes),
    onRefusal,
    scheduleLocalSync: (id, run) => {
      starts.set(id, run);
    },
  });
  await backend.store(id, [{ kind: "document", heads: A.getHeads(local), blob: A.save(local) }]);
  starts.get(id)();
  const queue = [];
  const trace = [];
  const end = (direction) => ({
    send(frame) {
      queue.push({ direction, frame: decodeFrame(encodeFrame(frame)) });
    },
    onMessage(run) {
      this.receive = run;
    },
    onClose(run) {
      this.closed = run;
    },
    close() {
      closed = true;
      this.closed?.();
    },
  });
  let client, server;
  const connect = () => {
    client = end("client");
    server = end("host");
    h.accept(server, { principal: "account:synthetic", role: "editor" });
    backend.addConnection(client);
  };
  connect();
  const deliver = async () => {
    const next = queue.shift();
    assert.ok(next, "a queued frame exists");
    const { direction, frame } = next;
    const decoded = frame.m && A.decodeSyncMessage(frame.m);
    let missing = [];
    if (direction === "client" && decoded?.changes.length) {
      const preview = A.loadIncremental(
        A.clone(await h.document(frame.doc)),
        concat(decoded.changes),
      );
      missing = A.getMissingDeps(preview, []);
      A.free(preview);
    }
    trace.push({
      direction,
      doc: frame.doc,
      r: frame.r,
      type: frame.t,
      code: frame.code,
      bytes: encodeFrame(frame).byteLength,
      heads: decoded?.heads,
      need: decoded?.need,
      have: decoded?.have.map(({ lastSync, bloom }) => ({
        lastSync,
        bloom: Buffer.from(bloom).toString("hex"),
      })),
      changes: decoded?.changes.map((blob) => {
        if (blob[8] === 0) {
          const doc = A.load(blob);
          const changes = A.getAllChanges(doc).map((change) => {
            const { hash, deps } = A.decodeChange(change);
            return { hash, deps };
          });
          A.free(doc);
          return { document: changes };
        }
        const { hash, deps } = A.decodeChange(blob);
        return { hash, deps };
      }),
      missing,
    });
    (direction === "client" ? server : client).receive(frame);
    await h.durableHeads(frame.doc);
    await backend.flush();
    return frame;
  };
  const drain = async () => {
    for (let n = 0; queue.length && n < 30; n++) await deliver();
    assert.equal(queue.length, 0, "the exchange is bounded");
  };
  t.after(async () => {
    await backend.close();
    for (const doc of [base, local, remote]) A.free(doc);
  });
  return {
    h,
    bytes,
    local,
    remote,
    backend,
    clientBytes,
    client,
    server,
    queue,
    trace,
    deliver,
    drain,
    start: (tree = id) => starts.get(tree)(),
    connect,
    isClosed: () => closed,
  };
}

test("a real Bloom omission recovers on the same socket without another edit", async (t) => {
  const f = await fixture(t);
  const round = f.backend.synchronizeTree(id);
  await f.drain();
  t.diagnostic(JSON.stringify(f.trace));
  t.diagnostic(
    JSON.stringify({
      frames: f.trace.length,
      bytes: f.trace.reduce((sum, frame) => sum + frame.bytes, 0),
      recoveryFrames: f.trace.filter((frame) => frame.r > 2).length,
      recoveryBytes: f.trace
        .filter((frame) => frame.r > 2)
        .reduce((sum, frame) => sum + frame.bytes, 0),
    }),
  );
  const omitted = f.trace.find((frame) => frame.missing.length);
  assert.ok(omitted, "native Automerge generated a descendant without its parent");
  const refusal = f.trace.find((frame) => frame.code === "missing_dependencies");
  assert.equal(refusal.r, omitted.r, "refusal identifies the exact incomplete frame");
  assert.equal((await round).outcome, "complete");
  const expected = A.merge(A.clone(f.local), A.clone(f.remote));
  const reopened = await host({ bytes: f.bytes });
  reopened.register(id);
  assert.deepEqual(history(await reopened.document(id)), history(expected));
  const stored = await new DocStore(f.clientBytes).read(id);
  const restored = A.load(concat([stored.snapshot, ...stored.chunks].filter(Boolean)));
  assert.deepEqual(history(restored), history(expected));
  assert.equal(f.backend.connected, true);
  assert.equal(f.isClosed(), false);
  A.free(expected);
  A.free(restored);
});

test("real dependency recovery records evidence; only explicit capture archives intact history", async (t) => {
  await import("fake-indexeddb/auto");
  const { PageSession } = await import("../viewer/session.mjs");
  const { decodeSnapshot, encodeSnapshot, listLocalRecoveries, writeLocalPage } =
    await import("../viewer/local-pages.mjs");
  const { key, store } = await import("../viewer/local-catalog.mjs");
  const identity = { principal: crypto.randomUUID(), displayName: "Synthetic writer" };
  const session = new PageSession(crypto.randomUUID(), {
    authentication: { identity, canWrite: true },
  });
  session.acceptAuthentication({ identity, canWrite: true });
  session.access = { canRead: true, canWrite: true, canComment: true, role: "owner", revision: 0 };
  const evidence = [];
  const f = await fixture(t, undefined, (item) => {
    evidence.push(item);
    session.observeRefusal(item);
  });
  let local = A.clone(f.local);
  const comments = A.from({ threads: {} });
  session.handle = { documentId: id, doc: () => local };
  session.commentsHandle = { documentId: "03".repeat(32), doc: () => comments };
  session.localPage = {
    principal: identity.principal,
    page_id: session.pageId,
    document_id: id,
    snapshot: encodeSnapshot(A.save(local)),
    title: "Synthetic recovery",
    updated_at: new Date().toISOString(),
  };
  session.dispatch({ type: "opened", denied: false });
  await writeLocalPage(identity, session.localPage);
  const checkpoint = await store.load(key(identity, session.pageId));
  const phase = session.phase$.snapshot();
  const handles = [session.handle, session.commentsHandle];
  const round = f.backend.synchronizeTree(id);
  for (let i = 0; i < 4; i++) await f.deliver();
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].code, "missing_dependencies");
  assert.equal(evidence[0].r, 2);
  assert.equal(evidence[0].doc, id);
  assert.equal(evidence[0].correlated, true);
  assert.ok(Object.isFrozen(evidence[0]));
  assert.equal(session.recoveryCapture.state.name, "idle");
  assert.equal((await listLocalRecoveries(identity, session.pageId)).length, 0);
  await f.drain();
  assert.equal((await round).outcome, "complete");
  const native = await new DocStore(f.clientBytes).read(id);
  A.free(local);
  local = A.load(concat([native.snapshot, ...native.chunks].filter(Boolean)));
  const before = history(local);
  assert.ok(A.hasHeads(local, A.getHeads(f.local)));
  assert.equal(session.recoveryCapture.state.name, "idle");
  assert.equal((await listLocalRecoveries(identity, session.pageId)).length, 0);
  const copy = await session.saveRecoveryCopy();
  const restored = A.load(decodeSnapshot(copy.snapshot));
  assert.deepEqual(history(restored), before);
  assert.deepEqual(history(local), before);
  assert.deepEqual(copy.refusal_evidence, evidence[0]);
  assert.deepEqual([session.handle, session.commentsHandle], handles);
  assert.equal(session.phase$.snapshot(), phase);
  assert.deepEqual(await store.load(key(identity, session.pageId)), checkpoint);
  assert.equal((await listLocalRecoveries(identity, session.pageId)).length, 1);
  assert.equal(f.isClosed(), false);
  for (const doc of [local, comments, restored]) A.free(doc);
});

test("repeated missing dependencies exhaust one retry per explicit attempt, not per waiter", async (t) => {
  const f = await fixture(t, {
    admit() {
      throw new Refusal("missing_dependencies", "synthetic");
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = f.trace.filter((frame) => frame.type === "refused").length;
    const round = f.backend.synchronizeTree(id);
    // Additional waiters cannot replenish an in-flight attempt's retry budget.
    const other = f.backend.synchronizeTree(id);
    await f.drain();
    assert.equal((await round).outcome, "failed");
    assert.equal((await other).outcome, "failed");
    assert.equal(f.trace.filter((frame) => frame.type === "refused").length - before, 2);
    t.mock.timers.tick(30_000);
    assert.equal(f.queue.length, 0, "old timeouts do not restart refused attempts");
  }
});

test("background recovery runs without a synchronize waiter or another local edit", async (t) => {
  const f = await fixture(t);
  await f.drain();
  assert.ok(f.trace.some((frame) => frame.code === "missing_dependencies"));
  assert.ok(A.hasHeads(await f.h.document(id), A.getHeads(f.local)));
  assert.equal(f.isClosed(), false);
});

test("a retry cannot report saved before its matching durable acknowledgment", async (t) => {
  const f = await fixture(t);
  let settled = false;
  const round = f.backend.synchronizeTree(id).then((result) => {
    settled = true;
    return result;
  });
  for (let i = 0; i < 7; i++) await f.deliver();
  assert.equal(settled, false);
  assert.ok(A.hasHeads(await f.h.document(id), A.getHeads(f.local)));
  assert.equal(f.queue[0].frame.r, 4);
  await f.deliver();
  assert.equal((await round).outcome, "complete");
});

test("recovery respects a newer edit's scheduled local hold", async (t) => {
  const f = await fixture(t);
  const round = f.backend.synchronizeTree(id);
  for (let i = 0; i < 3; i++) await f.deliver();
  const newer = A.change(A.clone(f.local), { time: 0 }, (d) => {
    d.n = 3;
  });
  const blob = A.getLastLocalChange(newer);
  const { hash, deps } = A.decodeChange(blob);
  await f.backend.store(id, [{ kind: "commit", id: hash, parents: deps, blob }]);
  await f.deliver();
  assert.equal(f.queue.length, 0, "refusal does not bypass the pending local scheduler");
  f.start();
  await f.drain();
  assert.equal((await round).outcome, "complete");
  assert.ok(A.hasHeads(await f.h.document(id), A.getHeads(newer)));
  A.free(newer);
});

for (const rejected of [false, true])
  test(`waiters join held recovery without sending or replenishing its budget: rejected=${rejected}`, async (t) => {
    const f = await fixture(
      t,
      rejected
        ? {
            admit() {
              throw new Refusal("missing_dependencies", "synthetic repeated refusal");
            },
          }
        : undefined,
    );
    const waiters = [f.backend.synchronizeTree(id)];
    void waiters[0].catch(() => {});
    for (let i = 0; i < 3; i++) await f.deliver();
    const newer = A.change(A.clone(f.local), { time: 0 }, (d) => {
      d.n = 3;
    });
    const blob = A.getLastLocalChange(newer);
    const { hash, deps } = A.decodeChange(blob);
    await f.backend.store(id, [{ kind: "commit", id: hash, parents: deps, blob }]);
    await f.deliver();
    assert.equal(f.queue.length, 0);
    for (let i = 0; i < 3; i++) {
      waiters.push(f.backend.synchronizeTree(id));
      void waiters.at(-1).catch(() => {});
      assert.equal(f.queue.length, 0, "joining a suspended attempt must not send while held");
    }
    f.start();
    await f.drain();
    const results = await Promise.all(waiters);
    assert.ok(results.every((result) => result.outcome === (rejected ? "failed" : "complete")));
    assert.equal(new Set(results.map((result) => result.roundId)).size, 1);
    assert.equal(
      f.trace.filter((frame) => frame.type === "refused").length,
      rejected ? 2 : 1,
      "one resync budget across every waiter",
    );
    const stored = await new DocStore(f.clientBytes).read(id);
    const restored = A.load(concat([stored.snapshot, ...stored.chunks].filter(Boolean)));
    assert.ok(A.hasHeads(restored, A.getHeads(newer)));
    assert.equal(A.hasHeads(await f.h.document(id), A.getHeads(newer)), !rejected);
    A.free(restored);
    A.free(newer);
  });

test(
  "near frame limit recovery refuses safely and retains every local change",
  {
    skip: process.env.PAGES_SYNC_LIMIT_TEST !== "1",
    timeout: 120_000,
  },
  async (t) => {
    const f = await fixture(t);
    const round = f.backend.synchronizeTree(id);
    for (let i = 0; i < 3; i++) await f.deliver();
    let local = A.clone(f.local);
    let maxRecord = 0;
    for (let i = 0; i < 3; i++) {
      const payload = new Uint8Array(
        createHash("shake256", { outputLength: 11 * 1024 * 1024 })
          .update(`synthetic-frame-${i}`)
          .digest(),
      );
      local = A.change(local, { time: 0 }, (doc) => {
        doc[`payload${i}`] = payload;
      });
      const blob = A.getLastLocalChange(local);
      maxRecord = Math.max(maxRecord, blob.length);
      assert.ok(blob.length < 16 * 1024 * 1024, "each local record fits the configured limit");
      const { hash, deps } = A.decodeChange(blob);
      await f.backend.store(id, [{ kind: "commit", id: hash, parents: deps, blob }]);
    }
    await f.deliver();
    f.start();
    await f.drain();
    assert.equal((await round).outcome, "failed");
    const largestFrame = Math.max(...f.trace.map((frame) => frame.bytes));
    assert.ok(largestFrame > MAX_FRAME_BYTES);
    assert.ok(largestFrame < MAX_FRAME_BYTES * 1.05);
    assert.ok(f.trace.some((frame) => frame.code === "receive_queue_full"));
    assert.deepEqual(history(await f.h.document(id)), history(f.remote));
    assert.deepEqual(await f.h.durableHeads(id), A.getHeads(f.remote));
    const saved = await new DocStore(f.clientBytes).read(id);
    const restored = A.load(concat([saved.snapshot, ...saved.chunks].filter(Boolean)));
    const expected = A.merge(A.clone(local), A.clone(f.remote));
    assert.deepEqual(history(restored), history(expected));
    assert.equal(f.isClosed(), true);
    assert.equal(f.queue.length, 0);
    t.diagnostic(
      JSON.stringify({
        largestFrame,
        frameLimit: MAX_FRAME_BYTES,
        maxRecord,
        refusalCodes: f.trace.filter((frame) => frame.code).map((frame) => frame.code),
        totalFrames: f.trace.length,
        preservedChanges: history(restored).length,
      }),
    );
    for (const doc of [restored, expected, local]) A.free(doc);
  },
);

test("dependency recovery transitions have one retry until a new attempt", () => {
  const events = ["start", "complete", "missing", "stop", "suspend", "resume", "connect"];
  const expected = {
    ready: ["ready", "ready", "retrying", "blocked", "ready", "ready", "ready"],
    retrying: ["retrying", "ready", "blocked", "blocked", "suspended", "retrying", "ready"],
    suspended: ["suspended", "ready", "blocked", "blocked", "suspended", "retrying", "ready"],
    blocked: ["ready", "ready", "blocked", "blocked", "blocked", "blocked", "ready"],
  };
  for (const [state, outcomes] of Object.entries(expected))
    for (const [i, event] of events.entries())
      assert.equal(dependencyRecoveryStep(state, event), outcomes[i], `${state}/${event}`);
});

test("a held recovery does not hold another document or borrow its retry budget", async (t) => {
  const f = await fixture(t);
  const round = f.backend.synchronizeTree(id);
  for (let i = 0; i < 3; i++) await f.deliver();
  const newer = A.change(A.clone(f.local), { time: 0 }, (d) => {
    d.n = 3;
  });
  await f.backend.store(id, [{ kind: "document", heads: A.getHeads(newer), blob: A.save(newer) }]);
  await f.deliver();
  const otherId = "03".repeat(32);
  await f.h.seed(otherId, "page", f.remote);
  await f.backend.store(otherId, [
    { kind: "document", heads: A.getHeads(f.local), blob: A.save(f.local) },
  ]);
  f.start(otherId);
  const other = f.backend.synchronizeTree(otherId);
  await f.drain();
  assert.equal((await other).outcome, "complete");
  assert.ok(f.trace.filter((frame) => frame.doc === id).every((frame) => frame.r <= 2));
  f.start();
  await f.drain();
  assert.equal((await round).outcome, "complete");
  assert.ok(A.hasHeads(await f.h.document(id), A.getHeads(newer)));
  assert.ok(A.hasHeads(await f.h.document(otherId), A.getHeads(f.local)));
  A.free(newer);
});

test("reconnect during held recovery ignores old success and waits for local release", async (t) => {
  const f = await fixture(t);
  const round = f.backend.synchronizeTree(id);
  await f.deliver();
  const oldSuccess = f.queue[0].frame;
  await f.deliver();
  await f.deliver();
  const newer = A.change(A.clone(f.local), { time: 0 }, (d) => {
    d.n = 3;
  });
  await f.backend.store(id, [{ kind: "document", heads: A.getHeads(newer), blob: A.save(newer) }]);
  await f.deliver();
  f.connect();
  assert.equal((await round).outcome, "failed", "old connection's waiters settle on close");
  const retry = f.backend.synchronizeTree(id);
  f.client.receive(oldSuccess);
  assert.equal(f.queue.length, 0, "neither reconnect nor old success bypasses the hold");
  f.start();
  await f.drain();
  assert.equal((await retry).outcome, "complete");
  assert.ok(A.hasHeads(await f.h.document(id), A.getHeads(newer)));
  A.free(newer);
});

test("bounded wire accounting with 256 divergent changes per side during recovery", async (t) => {
  const f = await fixture(t);
  const round = f.backend.synchronizeTree(id);
  for (let i = 0; i < 3; i++) await f.deliver();
  let local = A.clone(f.local);
  let remote = A.clone(f.remote);
  for (let i = 0; i < 256; i++) {
    local = A.change(local, { time: 0 }, (d) => {
      d[`local_${i}`] = `${i}:` + "x".repeat(256);
    });
    remote = A.change(remote, { time: 0 }, (d) => {
      d[`remote_${i}`] = `${i}:` + "y".repeat(256);
    });
  }
  await f.backend.store(id, [{ kind: "document", heads: A.getHeads(local), blob: A.save(local) }]);
  await f.deliver();
  await f.h.seed(id, "page", remote);
  await f.drain();
  const before = f.trace.length;
  const start = performance.now();
  f.start();
  await f.drain();
  assert.equal((await round).outcome, "complete");
  const expected = A.merge(A.clone(local), A.clone(remote));
  const reopened = await host({ bytes: f.bytes });
  reopened.register(id);
  assert.deepEqual(history(await reopened.document(id)), history(expected));
  t.diagnostic(
    JSON.stringify({
      syntheticChangesPerSide: 256,
      payloadCharactersPerChange: 256,
      framesAfterRelease: f.trace.length - before,
      bytesAfterRelease: f.trace.slice(before).reduce((sum, frame) => sum + frame.bytes, 0),
      fixtureRecoveryMs: performance.now() - start,
      localSnapshotBytes: A.save(local).length,
      hostSnapshotBytes: A.save(remote).length,
    }),
  );
  for (const doc of [local, remote, expected]) A.free(doc);
});

for (const code of [
  "missing_dependencies",
  "history_capacity",
  "actor_claimed",
  "invalid_page_content",
])
  test(`recovery stops at ${code}, preserves history, and never reports saved`, async (t) => {
    const f = await fixture(t, {
      admit() {
        throw new Refusal(code, "synthetic refusal");
      },
    });
    const saved = await new DocStore(f.clientBytes).syncState(id);
    const round = f.backend.synchronizeTree(id);
    await f.drain();
    const result = await round;
    assert.equal(result.outcome, "failed");
    assert.equal(result.peers[0].outcome, "failed");
    assert.deepEqual(
      f.trace.filter((frame) => frame.type === "refused").map((frame) => frame.code),
      ["missing_dependencies", code],
    );
    assert.deepEqual(history(await f.h.document(id)), history(f.remote));
    assert.deepEqual(await new DocStore(f.clientBytes).syncState(id), saved);
    const local = await new DocStore(f.clientBytes).read(id);
    const restored = A.load(concat([local.snapshot, ...local.chunks].filter(Boolean)));
    assert.ok(A.hasHeads(restored, A.getHeads(f.local)), "all local edits remain durable locally");
    A.free(restored);
    assert.equal(f.queue.length, 0);
    assert.equal(f.backend.connected, true);
  });

test("duplicate and late refusals cannot reset or settle the retry", async (t) => {
  const f = await fixture(t);
  let settled = false;
  const round = f.backend.synchronizeTree(id).then((result) => {
    settled = true;
    return result;
  });
  for (let i = 0; i < 3; i++) await f.deliver();
  const refusal = f.queue[0].frame;
  assert.equal(refusal.t, "refused");
  await f.deliver();
  f.client.receive(refusal);
  f.client.receive({ ...refusal, code: "history_capacity" });
  assert.equal(settled, false);
  await f.drain();
  assert.equal((await round).outcome, "complete");
  const saved = await new DocStore(f.clientBytes).syncState(id);
  f.client.receive(refusal);
  assert.equal(f.queue.length, 0);
  const next = f.backend.synchronizeTree(id);
  await f.drain();
  assert.equal((await next).outcome, "complete");
  assert.deepEqual(await new DocStore(f.clientBytes).syncState(id), saved);
});

for (const fatal of [false, true])
  test(`uncorrelated or fatal refusal never authorizes retry: fatal=${fatal}`, async (t) => {
    const f = await fixture(t);
    const round = f.backend.synchronizeTree(id);
    for (let i = 0; i < 3; i++) await f.deliver();
    f.queue[0].frame.fatal = fatal;
    if (!fatal) delete f.queue[0].frame.r;
    await f.deliver();
    assert.equal((await round).outcome, "failed");
    assert.equal(f.queue.length, 0);
  });

test("missing and duplicate change hashes stay native protocol concerns", async (t) => {
  const f = await fixture(t);
  const round = f.backend.synchronizeTree(id);
  await f.deliver();
  await f.deliver();
  const decoded = A.decodeSyncMessage(f.queue[0].frame.m);
  assert.equal(decoded.changes.length, 1);
  decoded.changes.push(decoded.changes[0]);
  f.queue[0].frame.m = A.encodeSyncMessage(decoded);
  await f.drain();
  assert.equal((await round).outcome, "complete");
  assert.ok(A.hasHeads(await f.h.document(id), A.getHeads(f.local)));
});
