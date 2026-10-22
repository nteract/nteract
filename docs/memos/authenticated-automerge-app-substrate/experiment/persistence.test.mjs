import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPeer, closePeers } from "./backend.mjs";
import { FileByteStore } from "./file-store.mjs";

const run = promisify(execFile);
class CountedFailureStore extends FileByteStore {
  failedSaves = 0;
  async save(key, value) {
    if (this.failSaves) this.failedSaves++;
    return super.save(key, value);
  }
}

async function reopenInFreshProcess(root, documentId, seed) {
  const program = `
    import { createPeer, closePeers } from ${JSON.stringify(new URL("./backend.mjs", import.meta.url).href)};
    import { FileByteStore } from ${JSON.stringify(new URL("./file-store.mjs", import.meta.url).href)};
    const store = new FileByteStore(process.argv[1]);
    const peer = createPeer({ storage: store, seed: new Uint8Array(Buffer.from(process.argv[3], 'hex')) });
    try {
      const handle = await peer.repo.find(process.argv[2]);
      await peer.repo.flush();
      console.log(JSON.stringify({ doc: handle.doc(), heads: handle.heads(), key: peer.keyId, writes: store.writes }));
    } finally { await closePeers([peer]); }
  `;
  const { stdout } = await run(
    process.execPath,
    ["--input-type=module", "--eval", program, root, documentId, Buffer.from(seed).toString("hex")],
    { timeout: 10000 },
  );
  return JSON.parse(stdout.trim());
}

test(
  "real backend reports failed disk writes; fresh process recovers accepted history and a subsequent write",
  { timeout: 20000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "authenticated-repo-persistence-"));
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const store = new FileByteStore(root);
    let peer = createPeer({ storage: store, seed });
    try {
      const handle = await peer.repo.create({ count: 0, extensions: { unknown: [1, 2, 3] } });
      await peer.repo.flush();
      const id = handle.documentId,
        key = peer.keyId,
        initialHeads = handle.heads();
      assert.ok(store.writes > 0);
      store.failSaves = true;
      await assert.rejects(
        handle.change((doc) => {
          doc.count = 1;
        }),
        /save failure/,
      );
      await assert.rejects(peer.repo.flush());
      assert.equal(handle.doc().count, 1); // Optimistic memory is not a receipt.
      await closePeers([peer]);
      peer = undefined;
      store.failSaves = false;
      const recovered = await reopenInFreshProcess(root, id, seed);
      assert.equal(recovered.doc.count, 0);
      assert.deepEqual(recovered.heads, initialHeads);
      assert.equal(recovered.key, key);
      assert.equal(recovered.writes, 0);
      assert.deepEqual(recovered.doc.extensions.unknown, [1, 2, 3]);
      peer = createPeer({ storage: new FileByteStore(root), seed });
      const retried = await peer.repo.find(id);
      await retried.change((doc) => {
        doc.count = 1;
      });
      await peer.repo.flush();
      const acceptedHeads = retried.heads();
      await closePeers([peer]);
      peer = undefined;
      const accepted = await reopenInFreshProcess(root, id, seed);
      assert.equal(accepted.doc.count, 1);
      assert.deepEqual(accepted.heads, acceptedHeads);
      assert.equal(accepted.writes, 0);
    } finally {
      if (peer) await closePeers([peer]);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "failed flush retries the same optimistic edit without another change and fresh process recovers identical heads",
  { timeout: 20_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "authenticated-repo-same-edit-retry-"));
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const storage = new CountedFailureStore(root);
    let peer = createPeer({ storage, seed });
    try {
      const handle = await peer.repo.create({ count: 0, extensions: { unknown: [1, 2, 3] } });
      await peer.repo.flush();
      const initialHeads = handle.heads();
      const initialWrites = storage.writes;
      const documentId = handle.documentId;

      storage.failSaves = true;
      await assert.rejects(
        handle.change((doc) => {
          doc.count = 1;
        }),
        /save failure/,
      );
      const optimisticHeads = handle.heads();
      const optimisticDoc = JSON.parse(JSON.stringify(handle.doc()));
      assert.notDeepEqual(optimisticHeads, initialHeads);
      assert.equal(optimisticDoc.count, 1);
      const failuresAfterChange = storage.failedSaves;
      assert.ok(failuresAfterChange > 0);

      await assert.rejects(peer.repo.flush(), /Repo flush failed/);
      assert.ok(
        storage.failedSaves > failuresAfterChange,
        "flush retried while failure remained active",
      );
      assert.equal(
        storage.writes,
        initialWrites,
        "no writes succeeded during the injected failure",
      );
      assert.deepEqual(handle.heads(), optimisticHeads);
      assert.deepEqual(handle.doc(), optimisticDoc, "failed flush did not roll back local state");

      // Clear the storage fault, but do not call change again. Repo.flush must
      // retry the existing unsaved history rather than rely on a newer edit.
      storage.failSaves = false;
      await peer.repo.flush();
      assert.ok(storage.writes > initialWrites);
      assert.deepEqual(
        handle.heads(),
        optimisticHeads,
        "retry did not author a replacement change",
      );
      assert.deepEqual(handle.doc(), optimisticDoc);
      assert.deepEqual(await closePeers([peer]), []);
      peer = undefined;

      const recovered = await reopenInFreshProcess(root, documentId, seed);
      assert.deepEqual(recovered.heads, optimisticHeads);
      assert.deepEqual(recovered.doc, optimisticDoc);
      assert.equal(recovered.writes, 0, "fresh-process recovery did not need a repair write");
    } finally {
      if (peer) await closePeers([peer]);
      await rm(root, { recursive: true, force: true });
    }
  },
);
