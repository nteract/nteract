import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import { Repo } from "@automerge/automerge-repo";
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge";
import { recordBytes } from "@automerge/automerge-repo/sedimentree";
import { SubductionBackend } from "@automerge/automerge-repo-subduction";
import { connectPeers, closePeers, createPeer, eventually, treeId } from "../../backend.mjs";
import { BACKEND_LIMITS, assertDocumentLimits } from "../model/limits.mjs";
import { Page } from "./index.mjs";
import { documentMutation } from "./mutations.mjs";
import { DurableByteStore } from "./storage.mjs";
import { DocumentAdmission, isHistoryCapacityError } from "./history-admission.mjs";

class Storage {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    this.values.delete(key);
  }
  async sync() {}
  async list({ prefix = "", startAfter = "", limit = Infinity } = {}) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([key]) => key.startsWith(prefix) && key > startAfter)
        .slice(0, limit),
    );
  }
}

// Stable incompressible bytes keep this at the real 16 MiB budget, without
// depending on randomness, wall-clock timing, or a test-only production limit.
function bytes(length, seed) {
  const output = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    output[i] = state & 255;
  }
  return output;
}
const size = (doc) => extractRecords(doc).reduce((sum, record) => sum + recordBytes(record), 0);
const pageId = "33333333-3333-4333-8333-333333333333";
const key = "host/operation/capacity-race";
const limitsError = (error) => /snapshot.*limit/i.test(error.message);
const capacityFailure = (error) =>
  error instanceof AggregateError
    ? error.errors.every(capacityFailure)
    : isHistoryCapacityError(error) || limitsError(error);

function host(storage, maxSnapshotBytes = BACKEND_LIMITS.maxSnapshotBytes) {
  const signer = N.MemorySigner.fromBytes(new Uint8Array(32).fill(23));
  const backend = new SubductionBackend({
    signer,
    storage: new DurableByteStore(storage),
    ...BACKEND_LIMITS,
    maxSnapshotBytes,
    syncTimeoutMilliseconds: 500,
  });
  const repo = new Repo({ backend });
  return { signer, backend, repo };
}
async function flush(peer) {
  await peer.repo.flush();
  await peer.backend.flush();
}

// Seed legacy stranded intents through the former unreserved mutation path.
// Recovery must now preserve accepted history and expose an explicit write block.
// Real Repo, WASM, signed native records and native incoming writes; only the
// transport/storage are in process. No claim about celld's durability gate.
for (const interruption of ["apply-rejected", "crash-before-apply"]) {
  test(
    `legacy stranded intent remains readable: ${interruption}`,
    { timeout: 60000 },
    async (t) => {
      const storage = new Storage();
      const server = host(storage);
      const author = createPeer();
      const peers = [server, author];
      const wires = [];
      try {
        let base = A.from({ page_id: pageId, stable: { text: "preserve my identity" } });
        for (let n = 1; n <= 31; n++) {
          base = A.change(base, (doc) => {
            doc.payload = bytes(512 * 1024, n);
          });
        }
        const stableId = A.getObjectId(base.stable);
        const a = await author.repo.import(A.save(base));
        const h = await server.repo.import(A.save(base), { docId: a.documentId });
        wires.push(await connectPeers(author, server));
        await flush(server);
        await storage.put("host/document", {
          pageId,
          documentId: h.documentId,
          tree: treeId(h.documentId),
          deleted: false,
        });
        const before = h.doc();
        const baseBytes = size(before);
        const apply = (doc) => {
          doc.api = bytes(300 * 1024, 101);
        };
        const candidate = A.change(A.clone(before), apply);
        assertDocumentLimits(candidate);
        const args = { idempotency_key: "capacity-race", base_heads: A.getHeads(before) };
        const originalPut = storage.put.bind(storage);
        let nativeHeads, nativeBytes;
        storage.put = async (path, value) => {
          await originalPut(path, value);
          if (path !== key || !value.pending) return;
          // Pause exactly after the intent write; the native wire remains live.
          await a.change((doc) => {
            doc.native = bytes(300 * 1024, 102);
          });
          await eventually(() => assert.ok(h.doc().native), 10000);
          await flush(server);
          nativeHeads = A.getHeads(h.doc());
          nativeBytes = size(h.doc());
          assertDocumentLimits(h.doc());
          assert.ok(
            size(A.applyChanges(A.clone(h.doc()), value.changes)[0]) >
              BACKEND_LIMITS.maxSnapshotBytes,
          );
          if (interruption === "crash-before-apply") throw Error("injected crash after intent");
        };
        await assert.rejects(
          documentMutation({
            storage,
            handle: h,
            operation: "edit_page",
            args,
            identity: { principal: "fixture:owner", driver: "test" },
            apply,
            flush: () => flush(server),
          }),
          interruption === "crash-before-apply" ? /injected crash/ : limitsError,
        );
        storage.put = originalPut;
        const intent = await storage.get(key);
        assert.equal(intent.pending, true);
        assert.equal(
          !!h.doc().api,
          interruption === "apply-rejected",
          "rejected persistence is not rollback",
        );

        // Copy only accepted storage, before shutdown can retry optimistic edits.
        const snapshot = structuredClone(storage.values);
        const restoredStorage = new Storage();
        restoredStorage.values = structuredClone(snapshot);
        const restored = host(restoredStorage);
        peers.push(restored);
        const restoredHandle = await restored.repo.find(h.documentId);
        assert.ok(A.hasHeads(restoredHandle.doc(), nativeHeads));
        assert.equal(restoredHandle.doc().api, undefined);
        assert.equal(A.getObjectId(restoredHandle.doc().stable), stableId);
        assert.deepEqual(A.getChanges(before, restoredHandle.doc()), A.getChanges(before, a.doc()));

        const accepted = A.clone(restoredHandle.doc());

        // Use the actual Page constructor/recovery gate. Initialization alone is
        // replaced to attach this real backend without unrelated ACL setup.
        t.mock.method(Page.prototype, "initializeRepo", async function () {
          this.repo = restored.repo;
          this.backend = restored.backend;
          this.admission = new DocumentAdmission(restored.backend, treeId(h.documentId));
        });
        const page = new Page(
          { storage: restoredStorage, blockConcurrencyWhile: (fn) => fn() },
          {},
        );
        await page.ready;
        assert.equal(page.recoveryBlocked?.code, "page_recovery_blocked");
        assert.ok(A.hasHeads(page.handle.doc(), nativeHeads));
        assert.equal(
          page.handle.doc().api,
          undefined,
          "blocked recovery never poisons the serving handle",
        );
        assert.equal(A.getObjectId(page.handle.doc().stable), stableId);
        assert.equal((await restoredStorage.get(key)).pending, true);

        // Diagnostic control, NOT a proposed production fix: sufficient budget
        // recovers the exact journaled change and identities, without reauthoring.
        const rescueStorage = new Storage();
        rescueStorage.values = structuredClone(snapshot);
        const rescue = host(rescueStorage, BACKEND_LIMITS.maxSnapshotBytes + 1024 * 1024);
        peers.push(rescue);
        t.mock.method(Page.prototype, "initializeRepo", async function () {
          this.repo = rescue.repo;
          this.backend = rescue.backend;
          this.admission = new DocumentAdmission(rescue.backend, treeId(h.documentId));
        });
        const recovered = new Page(
          { storage: rescueStorage, blockConcurrencyWhile: (fn) => fn() },
          {},
        );
        await recovered.ready;
        assert.ok(A.hasHeads(recovered.handle.doc(), nativeHeads));
        assert.ok(A.hasHeads(recovered.handle.doc(), intent.receipt.heads));
        assert.equal(A.getObjectId(recovered.handle.doc().stable), stableId);
        assert.deepEqual(A.getChanges(accepted, recovered.handle.doc()), intent.changes);
        assert.equal((await rescueStorage.get(key)).pending, false);
        assert.deepEqual(
          await documentMutation({
            storage: rescueStorage,
            handle: recovered.handle,
            operation: "edit_page",
            args,
            identity: { principal: "fixture:owner", driver: "test" },
            apply: () => assert.fail("recovered retry must not reauthor the edit"),
            flush: () => recovered.flush(),
          }),
          intent.receipt,
        );
        t.diagnostic(
          JSON.stringify({
            baseBytes,
            nativeBytes,
            candidateBytes: size(candidate),
            recoveredBytes: size(recovered.handle.doc()),
            cap: BACKEND_LIMITS.maxSnapshotBytes,
          }),
        );
      } finally {
        // Shutdown retries optimistic writes. Close every backend/signer, allowing
        // only capacity failures from those retries, never unrelated I/O failures.
        const failures = await closePeers(peers, wires);
        assert.ok(
          failures.every(({ reason }) => capacityFailure(reason)),
          failures.map(({ reason }) => String(reason)).join("; "),
        );
      }
    },
  );
}
