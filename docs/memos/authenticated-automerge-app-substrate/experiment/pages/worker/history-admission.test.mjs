import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import { Repo, generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge";
import { recordBytes } from "@automerge/automerge-repo/sedimentree";
import { SubductionBackend } from "@automerge/automerge-repo-subduction";
import { treeId, closePeers, createPeer, connectPeers } from "../../backend.mjs";
import { DurableByteStore } from "./storage.mjs";
import { BufferedRecordStore, PageRecords, RemoteRecordSink } from "./record-persistence.mjs";
import { DocumentAdmission, isHistoryCapacityError } from "./history-admission.mjs";
import { documentMutation, recoverDocumentMutations } from "./mutations.mjs";
import { issueRetryToken, RETRY_LIFETIME_MS } from "./operation-journal.mjs";
import { retryKey } from "../model/retry-key.mjs";
import { buildPersistenceFixture } from "../../persistence-workload.mjs";

class Storage {
  values = new Map();
  afterPut;
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    const entries = typeof key === "string" ? [[key, value]] : Object.entries(key);
    for (const [path, data] of entries) {
      this.values.set(path, structuredClone(data));
      await this.afterPut?.(path, data);
    }
  }
  async delete(key) {
    for (const path of Array.isArray(key) ? key : [key]) this.values.delete(path);
  }
  async sync() {}
  async list({ prefix = "", startAfter = "", limit = Infinity } = {}) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([key]) => key.startsWith(prefix) && key > startAfter)
        .slice(0, limit),
    );
  }
  clone() {
    const copy = new Storage();
    copy.values = structuredClone(this.values);
    return copy;
  }
}
function noise(length, seed = 7) {
  return Uint8Array.from({ length }, () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed & 255;
  });
}
const bytes = (doc) => extractRecords(doc).reduce((sum, record) => sum + recordBytes(record), 0);
const recordPath = (record) =>
  `${record.kind}/${record.kind === "commit" ? record.id : record.head}`;
/** Bytes a host stores after it already holds `stored` and admits `next`. */
function unionBytes(stored, next) {
  const union = new Map(
    [...extractRecords(stored), ...extractRecords(next)].map((r) => [recordPath(r), r]),
  );
  return [...union.values()].reduce((sum, record) => sum + recordBytes(record), 0);
}

// A change's hash decides its sedimentree record shape. A hash with a leading
// zero byte (about 1 in 256) heads a fragment that bundles the history before
// it, instead of a loose commit. Random actors and wall-clock timestamps would
// make every fixture's shape, and so its byte budget, a coin flip. Fixtures use
// fixed actors and search fixed timestamps for the head shape a test needs.
const TIME = 1_790_000_000;
const ACTOR = {
  base: "0a".repeat(16),
  api: "0b".repeat(16),
  native: "0c".repeat(16),
};
function headKind(doc) {
  const [head] = A.getHeads(doc);
  return extractRecords(doc).find(
    (record) => (record.kind === "commit" ? record.id : record.head) === head,
  )?.kind;
}
function edit(doc, actor, change, kind = "commit") {
  for (let time = TIME; time < TIME + 4096; time++) {
    const next = A.change(A.clone(doc, { actor }), { time }, change);
    if (headKind(next) === kind) return next;
    A.free(next);
  }
  throw Error(`No ${kind}-headed edit within the timestamp search bound`);
}
const baseDoc = () =>
  edit(
    edit(A.init(), ACTOR.base, (doc) => {
      doc.page_id = "fixture";
      doc.stable = { text: "same identity" };
    }),
    ACTOR.base,
    (doc) => {
      doc.data = noise(4096);
    },
  );
const apiEdit = (doc) => {
  doc.api = noise(2048, 11);
};
const nativeEdit = (doc) => {
  doc.native = noise(2048, 12);
};
function host(
  mode,
  maxSnapshotBytes,
  storage = new Storage(),
  records = new Storage(),
  { maxBatchKeys } = {},
) {
  const owner = new PageRecords({ storage: records });
  const recordStore =
    mode === "buffered"
      ? new BufferedRecordStore(
          new RemoteRecordSink({ fetch: (request) => owner.fetch(request) }),
          { maxBatchKeys },
        )
      : new DurableByteStore(storage);
  const signer = N.MemorySigner.fromBytes(new Uint8Array(32).fill(23));
  const backend = new SubductionBackend({ signer, storage: recordStore, maxSnapshotBytes });
  const repo = new Repo({ backend });
  return {
    signer,
    backend,
    repo,
    recordStore,
    storage,
    records,
    async flush() {
      await repo.flush();
      await backend.flush();
      await recordStore.flush?.();
      await storage.sync();
    },
  };
}
function context(peer, handle, key = "api-intent") {
  return {
    storage: peer.storage,
    handle,
    admission: new DocumentAdmission(peer.backend, treeId(handle.documentId)),
    operation: "edit_page",
    args: { idempotency_key: key, base_heads: A.getHeads(handle.doc()) },
    identity: { principal: "user:owner", driver: "test" },
    apply: (doc) => {
      doc.api = noise(2048, 11);
    },
    flush: () => peer.flush(),
  };
}

for (const mode of ["local", "buffered"]) {
  test(`${mode}: native admission ahead of the reservation rejects before the API intent`, async () => {
    const base = baseDoc();
    const candidate = edit(base, ACTOR.api, apiEdit);
    const native = edit(base, ACTOR.native, nativeEdit);
    const peer = host(mode, bytes(candidate) + 32);
    try {
      const handle = await peer.repo.import(A.save(base));
      await peer.flush();
      const ctx = context(peer, handle);
      const flush = ctx.flush;
      let first = true;
      ctx.flush = async () => {
        if (first) {
          first = false;
          await peer.backend.storeSnapshot(treeId(handle.documentId), extractRecords(native));
        }
        await flush();
      };
      await assert.rejects(documentMutation(ctx), isHistoryCapacityError);
      assert.equal(await peer.storage.get("host/operation/api-intent"), undefined);
      assert.equal(handle.doc().api, undefined);
      assert.deepEqual(handle.doc().native, native.native);
      assert.equal(A.getObjectId(handle.doc().stable), A.getObjectId(base.stable));
    } finally {
      assert.deepEqual(await closePeers([peer], []), []);
    }
  });

  for (const outcome of ["before-put", "after-put"]) {
    test(`${mode}: ${outcome} failure retries the exact admitted intent without reauthoring`, async () => {
      const base = baseDoc();
      const peer = host(mode, bytes(base) + 16384);
      try {
        const handle = await peer.repo.import(A.save(base));
        await peer.flush();
        const ctx = context(peer, handle);
        const put = peer.storage.put.bind(peer.storage);
        let fail = true;
        peer.storage.put = async (key, value) => {
          if (key === "host/operation/api-intent" && value.pending && fail) {
            fail = false;
            if (outcome === "after-put") await put(key, value);
            throw Error("interrupted journal");
          }
          return put(key, value);
        };
        await assert.rejects(documentMutation(ctx), /interrupted journal/);
        const pending = ctx.admission.pending("host/operation/api-intent");
        assert.ok(pending.pending);
        assert.equal(handle.doc().api, undefined);
        const exact = pending.changes;
        ctx.apply = () => assert.fail("retry must not reauthor");
        const receipt = await documentMutation(ctx);
        assert.deepEqual(receipt, pending.receipt);
        assert.deepEqual(A.getChanges(base, handle.doc()), exact);
        assert.equal(A.getObjectId(handle.doc().stable), A.getObjectId(base.stable));
        assert.equal((await peer.storage.get("host/operation/api-intent")).pending, false);
        assert.equal(ctx.admission.pending("host/operation/api-intent"), undefined);
      } finally {
        assert.deepEqual(await closePeers([peer], []), []);
      }
    });
  }

  test(`${mode}: crash after intent recovers exact records before a new native writer`, async () => {
    const base = baseDoc();
    const cap = bytes(base) + 16384;
    const peer = host(mode, cap);
    const peers = [peer];
    try {
      const handle = await peer.repo.import(A.save(base));
      await peer.flush();
      const ctx = context(peer, handle);
      const replay = ctx.admission.replay.bind(ctx.admission);
      ctx.admission.replay = async () => {
        throw Error("crash before record install");
      };
      await assert.rejects(documentMutation(ctx), /crash before record install/);
      const pending = await peer.storage.get("host/operation/api-intent");
      assert.ok(pending.pending);
      assert.equal(handle.doc().api, undefined);
      const restored = host(mode, cap, peer.storage.clone(), peer.records.clone());
      peers.push(restored);
      const recovered = await restored.repo.find(handle.documentId);
      const admission = new DocumentAdmission(restored.backend, treeId(handle.documentId));
      await recoverDocumentMutations(
        restored.storage,
        recovered,
        () => restored.flush(),
        admission,
      );
      assert.ok(A.hasHeads(recovered.doc(), pending.receipt.heads));
      assert.deepEqual(A.getChanges(base, recovered.doc()), pending.changes);
      assert.equal(A.getObjectId(recovered.doc().stable), A.getObjectId(base.stable));
      assert.equal((await restored.storage.get("host/operation/api-intent")).pending, false);
      ctx.admission.replay = replay;
    } finally {
      assert.deepEqual(await closePeers(peers, []), []);
    }
  });
}

for (const mode of ["local", "buffered"]) {
  // A fragment-headed reservation also carries base history the host already
  // stores as loose commits. Admission charges both representations, so the
  // reservation budget is the stored union, not the candidate's own records.
  test(`${mode}: a fragment-headed API edit is charged for the history it bundles`, async () => {
    const base = baseDoc();
    const loose = edit(base, ACTOR.api, apiEdit, "commit");
    const bundled = edit(base, ACTOR.api, apiEdit, "fragment");
    assert.deepEqual(
      extractRecords(bundled).map((record) => record.kind),
      ["fragment"],
    );
    assert.ok(unionBytes(base, bundled) > bytes(bundled) + 32);
    const peer = host(mode, Math.max(bytes(loose), bytes(bundled)) + 32);
    try {
      const handle = await peer.repo.import(A.save(base));
      await peer.flush();
      const admission = new DocumentAdmission(peer.backend, treeId(handle.documentId));
      const intent = (candidate) => ({
        fingerprint: "fixture",
        pending: true,
        changes: A.getChanges(base, candidate),
        receipt: { heads: A.getHeads(candidate) },
      });
      let persisted = 0;
      await assert.rejects(
        admission.reserve("bundled", intent(bundled), bundled, async () => {
          persisted++;
        }),
        (error) =>
          isHistoryCapacityError(error) && error.message === "Document history byte limit exceeded",
      );
      assert.equal(persisted, 0);
      assert.equal(admission.pending("bundled"), undefined);
      // The same edit as a loose commit only adds its own change to the stored base.
      await admission.reserve("loose", intent(loose), loose, async () => {
        persisted++;
      });
      assert.equal(persisted, 1);
      assert.ok(admission.pending("loose"));
    } finally {
      assert.deepEqual(await closePeers([peer], []), []);
    }
  });

  for (const head of ["commit", "fragment"]) {
    test(
      `${mode}: incoming authenticated native records cannot consume a recorded ${head}-headed API reservation`,
      { timeout: 10000 },
      async () => {
        const base = baseDoc();
        const candidate = edit(base, ACTOR.api, apiEdit, head);
        const native = edit(base, ACTOR.native, nativeEdit);
        // Exactly enough for the stored base plus the reservation: any native
        // record beyond that must be refused rather than spend reserved bytes.
        const peer = host(mode, unionBytes(base, candidate) + 32);
        const author = createPeer();
        const peers = [peer, author],
          wires = [];
        try {
          const a = await author.repo.import(A.save(base));
          const handle = await peer.repo.import(A.save(base), {
            docId: a.documentId,
          });
          wires.push(await connectPeers(author, peer));
          await peer.flush();
          const admission = new DocumentAdmission(peer.backend, treeId(handle.documentId));
          const entry = {
            fingerprint: "fixture",
            pending: true,
            changes: A.getChanges(base, candidate),
            receipt: { heads: A.getHeads(candidate) },
          };
          await admission.reserve("intent", entry, candidate, async () => {
            await peer.storage.put("host/operation/intent", entry);
            await peer.storage.sync();
          });
          // Observe the actual native rejection callback, without sleeps or polling.
          let rejected;
          const failure = new Promise((resolve) => {
            rejected = resolve;
          });
          const storageFailed = peer.backend.storageFailed.bind(peer.backend);
          peer.backend.storageFailed = (id) => {
            rejected();
            storageFailed(id);
          };
          // The author's backend signs and sends these exact native changes.
          await a.update((doc) => A.applyChanges(doc, A.getChanges(base, native))[0]);
          await failure;
          assert.equal(handle.doc().native, undefined);
          // Native failed admission remains visible to its persistence barrier.
          await assert.rejects(peer.backend.flush());
          await admission.replay("intent", entry, handle);
          await peer.flush();
          await peer.storage.put("host/operation/intent", {
            ...entry,
            pending: false,
          });
          await peer.storage.sync();
          await admission.release("intent");
          assert.deepEqual(handle.doc().api, candidate.api);
          assert.equal(handle.doc().native, undefined);
          assert.equal(A.getObjectId(handle.doc().stable), A.getObjectId(base.stable));
        } finally {
          assert.deepEqual(await closePeers(peers, wires), []);
        }
      },
    );
  }
}

test("buffered: remote prefix persistence failure recovers remaining exact history", async () => {
  const base = baseDoc();
  const peer = host("buffered", bytes(base) + 32768);
  const peers = [peer];
  try {
    const handle = await peer.repo.import(A.save(base));
    await peer.flush();
    // Both new changes stay loose commits. The fragment-headed variant of this
    // shape is covered by the flush-split tests below.
    const candidate = edit(edit(base, ACTOR.api, apiEdit), ACTOR.api, (doc) => {
      doc.next = noise(2048, 13);
    });
    assert.deepEqual(
      extractRecords(candidate).map((record) => record.kind),
      ["commit", "commit", "commit", "commit"],
    );
    const entry = {
      fingerprint: "fixture",
      pending: true,
      changes: A.getChanges(base, candidate),
      receipt: { heads: A.getHeads(candidate) },
    };
    const admission = new DocumentAdmission(peer.backend, treeId(handle.documentId));
    await admission.reserve("host/operation/prefix", entry, candidate, async () => {
      await peer.storage.put("host/operation/prefix", entry);
      await peer.storage.sync();
    });
    await admission.replay("host/operation/prefix", entry, handle);
    let writes = 0;
    peer.records.afterPut = (path) => {
      if (path.includes("/commits/") && ++writes === 1) throw Error("remote prefix interrupted");
    };
    await assert.rejects(peer.flush(), /Could not persist records/);
    const restored = host(
      "buffered",
      bytes(base) + 32768,
      peer.storage.clone(),
      peer.records.clone(),
    );
    peers.push(restored);
    const recovered = await restored.repo.find(handle.documentId);
    const acceptedHeads = A.getHeads(recovered.doc());
    await recoverDocumentMutations(
      restored.storage,
      recovered,
      () => restored.flush(),
      new DocumentAdmission(restored.backend, treeId(handle.documentId)),
    );
    assert.ok(A.hasHeads(recovered.doc(), acceptedHeads));
    assert.ok(A.hasHeads(recovered.doc(), entry.receipt.heads));
    assert.deepEqual(A.getChanges(base, recovered.doc()), entry.changes);
    assert.equal(A.getObjectId(recovered.doc().stable), A.getObjectId(base.stable));
    assert.equal((await restored.storage.get("host/operation/prefix")).pending, false);
    peer.records.afterPut = undefined;
    await peer.flush();
  } finally {
    assert.deepEqual(await closePeers(peers, []), []);
  }
});

/** Restart readiness is bounded: a lookup that does not settle fails the test. */
async function findWithin(repo, documentId, ms = 5000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`repo.find did not settle within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([repo.find(documentId), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// The candidate's `api` change heads a fragment that bundles the base history,
// and the `next` commit depends on it. One flush carries both records.
function fragmentParentCandidate(base) {
  const candidate = edit(edit(base, ACTOR.api, apiEdit, "fragment"), ACTOR.api, (doc) => {
    doc.next = noise(2048, 13);
  });
  const records = extractRecords(candidate);
  const [head] = A.getHeads(candidate);
  const child = records.find((record) => record.kind === "commit" && record.id === head);
  assert.ok(child, "the newest change is a loose commit");
  const parent = records.find(
    (record) => record.kind === "fragment" && child.parents.includes(record.head),
  );
  assert.ok(parent, "its only parent heads a fragment");
  return { candidate, child, parent };
}

async function stageIntent(peer, handle, base, candidate, key) {
  const entry = {
    fingerprint: "fixture",
    pending: true,
    changes: A.getChanges(base, candidate),
    receipt: { heads: A.getHeads(candidate) },
  };
  const admission = new DocumentAdmission(peer.backend, treeId(handle.documentId));
  await admission.reserve(key, entry, candidate, async () => {
    await peer.storage.put(key, entry);
    await peer.storage.sync();
  });
  await admission.replay(key, entry, handle);
  return entry;
}

test("buffered: every split of a flush leaves a history that restarts", async () => {
  const base = baseDoc();
  const { candidate, child, parent } = fragmentParentCandidate(base);
  const cap = unionBytes(base, candidate) + 32768;
  // Count the record keys one complete flush writes, then interrupt after each.
  const writes = async (peer) => {
    const keys = [];
    peer.records.afterPut = (path) => {
      if (path.startsWith("repo/")) keys.push(path);
    };
    await peer.flush();
    peer.records.afterPut = undefined;
    return keys;
  };
  const prepare = async () => {
    const peer = host("buffered", cap);
    const handle = await peer.repo.import(A.save(base));
    await peer.flush();
    const entry = await stageIntent(peer, handle, base, candidate, "host/operation/split");
    return { peer, handle, entry };
  };
  const probe = await prepare();
  const keys = await writes(probe.peer);
  assert.deepEqual(await closePeers([probe.peer], []), []);
  const childKey = keys.findIndex((key) => key.endsWith(`/commits/${child.id}`));
  const parentKey = keys.findIndex((key) => key.endsWith(`/fragments/${parent.head}`));
  assert.ok(childKey >= 0 && parentKey >= 0, "one flush writes both records");
  // Persist the parent-holding fragment before the commit that depends on it.
  assert.ok(parentKey < childKey, `fragment written at ${parentKey}, child at ${childKey}`);

  for (let split = 1; split < keys.length; split++) {
    const { peer, handle, entry } = await prepare();
    const peers = [peer];
    try {
      let written = 0;
      // The mock stores each key before afterPut runs: `split` keys are durable.
      peer.records.afterPut = (path) => {
        if (path.startsWith("repo/") && ++written === split) throw Error("batch split");
      };
      await assert.rejects(peer.flush(), /Could not persist records/);
      const restored = host("buffered", cap, peer.storage.clone(), peer.records.clone());
      peers.push(restored);
      const recovered = await findWithin(restored.repo, handle.documentId);
      await recoverDocumentMutations(
        restored.storage,
        recovered,
        () => restored.flush(),
        new DocumentAdmission(restored.backend, treeId(handle.documentId)),
      );
      assert.ok(A.hasHeads(recovered.doc(), entry.receipt.heads), `split ${split}`);
      assert.deepEqual(recovered.doc().next, candidate.next);
      assert.equal(A.getObjectId(recovered.doc().stable), A.getObjectId(base.stable));
      peer.records.afterPut = undefined;
    } finally {
      assert.deepEqual(await closePeers(peers, []), []);
    }
  }
});

// Records stored without causal ordering can hold a child commit without the
// fragment that holds its parent. Startup must not wait for that parent.
for (const journal of [true, false]) {
  test(`buffered: a stored commit without its parent fragment restarts ${journal ? "and replays its intent" : "with the reachable history"}`, async () => {
    const base = baseDoc();
    const { candidate, child, parent } = fragmentParentCandidate(base);
    const cap = unionBytes(base, candidate) + 32768;
    const peer = host("buffered", cap);
    const peers = [peer];
    try {
      const handle = await peer.repo.import(A.save(base));
      await peer.flush();
      const baseHeads = A.getHeads(handle.doc());
      const key = "host/operation/legacy";
      // A journaled API edit stays pending: the crash precedes its receipt.
      // Otherwise the history came from a native peer and has no intent.
      const entry = journal
        ? await stageIntent(peer, handle, base, candidate, key)
        : await handle.update((doc) => A.applyChanges(doc, A.getChanges(base, candidate))[0]);
      await peer.flush();
      const records = peer.records.clone();
      const fragment = [...records.values.keys()].find((path) =>
        path.endsWith(`/fragments/${parent.head}`),
      );
      assert.ok(fragment);
      assert.ok([...records.values.keys()].some((path) => path.endsWith(`/commits/${child.id}`)));
      records.values.delete(fragment);
      const restored = host("buffered", cap, peer.storage.clone(), records);
      peers.push(restored);
      const recovered = await findWithin(restored.repo, handle.documentId);
      // Readiness falls back to the history that materializes. The orphaned
      // commit stays queued: nothing stored is discarded.
      assert.deepEqual(A.getHeads(recovered.doc()), baseHeads);
      assert.equal(recovered.doc().next, undefined);
      assert.deepEqual(A.getMissingDeps(recovered.doc(), []), [parent.head]);
      if (journal) {
        await recoverDocumentMutations(
          restored.storage,
          recovered,
          () => restored.flush(),
          new DocumentAdmission(restored.backend, treeId(handle.documentId)),
        );
        assert.ok(A.hasHeads(recovered.doc(), entry.receipt.heads));
        assert.equal((await restored.storage.get(key)).pending, false);
      } else {
        // A peer that still holds the parent completes the queued child.
        const [api] = A.getChanges(base, candidate).filter(
          (change) => A.decodeChange(change).hash === parent.head,
        );
        await recovered.update((doc) => A.applyChanges(doc, [api])[0]);
        await restored.flush();
      }
      assert.deepEqual(recovered.doc().next, candidate.next);
      assert.deepEqual(A.getMissingDeps(recovered.doc(), []), []);
      assert.equal(A.getObjectId(recovered.doc().stable), A.getObjectId(base.stable));
      // The repaired history restarts cleanly.
      const again = host("buffered", cap, restored.storage.clone(), restored.records.clone());
      peers.push(again);
      const reopened = await findWithin(again.repo, handle.documentId);
      assert.deepEqual(reopened.doc().next, candidate.next);
    } finally {
      assert.deepEqual(await closePeers(peers, []), []);
    }
  });
}

for (const mode of ["local", "buffered"]) {
  test(`${mode}: failed terminal cleanup cannot revive a pending intent after receipt retirement`, async (t) => {
    let now = Date.parse("2026-10-25T00:00:00Z");
    t.mock.method(Date, "now", () => now);
    const base = baseDoc();
    const peer = host(mode, bytes(base) + 32768);
    const release = peer.backend.releaseReservation.bind(peer.backend);
    let key;
    try {
      const handle = await peer.repo.import(A.save(base));
      await peer.flush();
      const ctx = context(peer, handle);
      const tokenContext = {
        scope: "page:fixture",
        principal: ctx.identity.principal,
      };
      const issued = await issueRetryToken(peer.storage, tokenContext);
      const originalKey = await retryKey(issued.retry_token, "cleanup-original");
      key = `host/operation/${originalKey}`;
      ctx.args = {
        ...ctx.args,
        idempotency_key: originalKey,
        retry_token: issued.retry_token,
      };
      let fail = true;
      peer.backend.releaseReservation = async (tree, requestKey) => {
        if (requestKey === key && fail) {
          fail = false;
          assert.equal((await peer.storage.get(key)).pending, false);
          throw Error("terminal cleanup interrupted");
        }
        return release(tree, requestKey);
      };
      await assert.rejects(documentMutation(ctx), /terminal cleanup interrupted/);
      assert.equal(ctx.admission.pending(key), undefined);
      assert.equal(ctx.admission.hasPending, false);
      const completed = await peer.storage.get(key);
      assert.equal(completed.pending, false);
      assert.ok(A.hasHeads(handle.doc(), completed.receipt.heads));

      // A new request must work despite the old bridge cleanup failure. It
      // also retires the expired terminal receipt under the durable floor.
      now += RETRY_LIFETIME_MS + 1;
      const fresh = await issueRetryToken(peer.storage, tokenContext);
      await documentMutation({
        ...ctx,
        args: {
          idempotency_key: await retryKey(fresh.retry_token, "cleanup-next-request"),
          retry_token: fresh.retry_token,
          base_heads: A.getHeads(handle.doc()),
        },
        apply: (doc) => {
          doc.afterCleanup = true;
        },
      });
      assert.equal(handle.doc().afterCleanup, true);
      assert.equal(await peer.storage.get(key), undefined);
      const heads = A.getHeads(handle.doc());
      await assert.rejects(
        documentMutation({
          ...ctx,
          apply: () => assert.fail("an expired operation must not be reauthored"),
        }),
        { status: 410, code: "retry_expired" },
      );
      assert.deepEqual(A.getHeads(handle.doc()), heads);
      assert.equal(ctx.admission.hasPending, false);
      // The retained bridge reservation still cleans up safely; it never
      // double-charged identities which the completed operation had stored.
      await release(treeId(handle.documentId), key);
    } finally {
      peer.backend.releaseReservation = release;
      assert.deepEqual(await closePeers([peer], []), []);
    }
  });
}

// Every persistence cut of a flush must restart: ready on what the durable
// records build, or unavailable only when they build nothing. Each PageRecords
// write here holds one key (`maxBatchKeys: 1`), or one atomic record group, so
// the cuts are every boundary a production flush could stop at.
const CUT_CAP = 4 * 1024 * 1024;
const RECORD_PATH = /\/(commits|fragments)\/([0-9a-f]{64})$/;

function linearEdits(base, count = 5) {
  let doc = base;
  for (let i = 0; i < count; i++)
    doc = edit(doc, ACTOR.api, (draft) => {
      draft[`line${i}`] = noise(512, 40 + i);
    });
  return doc;
}

function mergeHeavy(base, rounds = 3) {
  const actors = ["1a", "1b", "1c"].map((actor) => actor.repeat(16));
  let doc = base;
  let time = TIME + 100;
  for (let round = 0; round < rounds; round++) {
    const branches = actors.map((actor, i) =>
      A.change(A.clone(doc, { actor }), { time: time++ }, (draft) => {
        draft[`round${round}actor${i}`] = noise(256, 20 + round * 3 + i);
      }),
    );
    doc = branches.reduce(
      (merged, branch) => A.merge(merged, branch),
      A.clone(doc, { actor: actors[0] }),
    );
  }
  return A.change(doc, { time: time++ }, (draft) => {
    draft.merged = true;
  });
}

/** Capture each atomic PageRecords write of one flush. */
async function recordFlush(peer) {
  const before = peer.records.clone();
  const writes = [];
  const put = peer.records.put.bind(peer.records);
  peer.records.put = async (key, value) => {
    const entries = typeof key === "string" ? [[key, value]] : Object.entries(key);
    const repo = entries.filter(([path]) => path.startsWith("repo/"));
    if (repo.length) writes.push(repo.map(([path, data]) => [path, structuredClone(data)]));
    return put(key, value);
  };
  try {
    await peer.flush();
  } finally {
    peer.records.put = put;
  }
  return { before, writes };
}

/** The history a set of durable records builds, from their Automerge payloads. */
function buildable(records, byPath) {
  let doc = A.init();
  try {
    for (const path of records.values.keys()) {
      const match = RECORD_PATH.exec(path);
      const record = match && byPath.get(`${match[1]}/${match[2]}`);
      if (record) doc = A.loadIncremental(doc, record.blob);
    }
    return { heads: A.getHeads(doc).sort(), missing: A.getMissingDeps(doc, []) };
  } finally {
    A.free(doc);
  }
}

const recordIndex = (...lists) =>
  new Map(
    lists
      .flat()
      .map((record) => [
        recordPath(record).replace("commit/", "commits/").replace("fragment/", "fragments/"),
        record,
      ]),
  );

async function restartAt(scenario, writes, label) {
  const records = scenario.before.clone();
  for (const write of writes)
    for (const [path, data] of write) records.values.set(path, structuredClone(data));
  const expected = buildable(records, scenario.byPath);
  const restored = host("buffered", CUT_CAP, scenario.storage.clone(), records);
  try {
    if (!expected.heads.length) {
      await assert.rejects(findWithin(restored.repo, scenario.documentId), /is unavailable/, label);
      return expected;
    }
    const handle = await findWithin(restored.repo, scenario.documentId);
    assert.deepEqual(A.getHeads(handle.doc()).sort(), expected.heads, label);
    if (scenario.entry) {
      await recoverDocumentMutations(
        restored.storage,
        handle,
        () => restored.flush(),
        new DocumentAdmission(restored.backend, treeId(scenario.documentId)),
      );
      assert.ok(A.hasHeads(handle.doc(), scenario.entry.receipt.heads), label);
      assert.deepEqual(A.getMissingDeps(handle.doc(), []), [], label);
    }
    return expected;
  } finally {
    assert.deepEqual(await closePeers([restored], []), []);
  }
}

async function journaledScenario(name, base, candidate) {
  const peer = host("buffered", CUT_CAP, undefined, undefined, { maxBatchKeys: 1 });
  try {
    const handle = await peer.repo.import(A.save(base));
    await peer.flush();
    const entry = await stageIntent(peer, handle, base, candidate, `host/operation/${name}`);
    const { before, writes } = await recordFlush(peer);
    return {
      name,
      before,
      writes,
      entry,
      storage: peer.storage.clone(),
      documentId: handle.documentId,
      byPath: recordIndex(extractRecords(base), extractRecords(candidate)),
    };
  } finally {
    assert.deepEqual(await closePeers([peer], []), []);
  }
}

async function importScenario(name, records, documentId, store) {
  const peer = host("buffered", CUT_CAP, undefined, undefined, { maxBatchKeys: 1 });
  try {
    documentId = await store(peer);
    const { before, writes } = await recordFlush(peer);
    return {
      name,
      before,
      writes,
      storage: peer.storage.clone(),
      documentId,
      byPath: recordIndex(records),
    };
  } finally {
    assert.deepEqual(await closePeers([peer], []), []);
  }
}

function shuffled(items, seed) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    const j = seed % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

test(
  "buffered: every persistence cut of a flush restarts on the history it builds",
  { timeout: 120_000 },
  async () => {
    const base = baseDoc();
    const fresh = mergeHeavy(baseDoc());
    const fixture = buildPersistenceFixture({ rounds: 8 });
    try {
      const compacted = [...fixture.loose, ...fixture.covering].filter(
        (record, index, all) =>
          all.findIndex((o) => recordPath(o) === recordPath(record)) === index,
      );
      assert.ok(
        compacted.some((record) => record.kind === "fragment"),
        "a compacted history",
      );
      const scenarios = [
        await journaledScenario("linear", base, linearEdits(base)),
        await journaledScenario("merge-heavy", base, mergeHeavy(base)),
        await journaledScenario("fragment-parent", base, fragmentParentCandidate(base).candidate),
        await importScenario(
          "fresh merge-heavy",
          extractRecords(fresh),
          undefined,
          async (peer) => {
            const handle = await peer.repo.import(A.save(fresh));
            return handle.documentId;
          },
        ),
        await importScenario("compacted snapshot", compacted, undefined, async (peer) => {
          const documentId = interpretAsDocumentId(generateAutomergeUrl());
          await peer.backend.storeSnapshot(treeId(documentId), compacted);
          return documentId;
        }),
      ];
      let restarts = 0;
      for (const scenario of scenarios) {
        assert.ok(scenario.writes.length > 1, `${scenario.name} splits into several writes`);
        for (let cut = 0; cut <= scenario.writes.length; cut++) {
          const expected = await restartAt(
            scenario,
            scenario.writes.slice(0, cut),
            `${scenario.name} cut ${cut}/${scenario.writes.length}`,
          );
          restarts++;
          // Causal order: every prefix holds the parents of what it holds.
          assert.deepEqual(expected.missing, [], `${scenario.name} cut ${cut} is causally closed`);
        }
      }
      // Readiness does not depend on that order: arbitrary write orders of the
      // fresh history, including children before parents, still restart.
      const [, , , unordered] = scenarios;
      const single = unordered.writes.flat().map((entry) => [entry]);
      for (const seed of [7, 19]) {
        const order = shuffled(single, seed);
        for (let cut = 0; cut <= order.length; cut++) {
          await restartAt(
            unordered,
            order.slice(0, cut),
            `shuffle ${seed} cut ${cut}/${order.length}`,
          );
          restarts++;
        }
      }
      assert.ok(restarts > 60, `${restarts} restarts`);
    } finally {
      fixture.free();
    }
  },
);

test("local: records saved together reach Durable Object storage in one put", async () => {
  const storage = new Storage();
  const calls = [];
  const put = storage.put.bind(storage);
  storage.put = async (key, value) => {
    calls.push(typeof key === "string" ? [key] : Object.keys(key));
    return put(key, value);
  };
  const store = new DurableByteStore(storage);
  await store.saveMany([
    ["tree/a", Uint8Array.of(1)],
    ["tree/b", Uint8Array.of(2)],
  ]);
  assert.deepEqual(calls, [["repo/tree/a", "repo/tree/b"]]);
  assert.deepEqual(await store.load("tree/b"), Uint8Array.of(2));
});
