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
import { recordBytes } from "@automerge/automerge-repo/sedimentree";
import {
  SubductionBackend,
  MemoryByteStore,
} from "./upstream/packages/automerge-repo-subduction/src/index.ts";

let history = A.from({ title: "history", local: "", cached: "" });
for (let i = 0; i < 601; i++)
  history = A.change(history, (doc) => {
    doc.title = `history-${i % 2}`;
  });
const loose = (doc) =>
  A.getAllChanges(doc).map((blob) => {
    const change = A.decodeChange(blob);
    return { kind: "commit", id: change.hash, parents: change.deps, blob };
  });
const records = loose(history);
assert.equal(records.length, 602);
const freshId = () => interpretAsDocumentId(generateAutomergeUrl());
function peer(storage = new MemoryByteStore(), options = {}) {
  const signer = N.MemorySigner.fromBytes(crypto.getRandomValues(new Uint8Array(32)));
  const backend = new SubductionBackend({
    signer,
    storage,
    maxSnapshotBytes: 16 * 1024 * 1024,
    ...options,
  });
  const repo = new Repo({ backend });
  return {
    storage,
    backend,
    repo,
    async close() {
      try {
        await repo.shutdown();
      } finally {
        try {
          await backend.close();
        } finally {
          signer.free();
        }
      }
    },
  };
}
const count = async (storage) =>
  (await storage.list("subduction-v1/")).filter((k) => k.includes("/commits/")).length;

// All records are real separate Automerge changes, admitted by the real native
// backend; no protocol/engine mock can turn a rejected snapshot into a pass.
test("602-record local checkpoints bootstrap an empty replica without widening ordinary store", async () => {
  const p = peer(),
    id = freshId(),
    tree = documentIdToBinary(id);
  try {
    await assert.rejects(
      p.backend.store(tree, records.slice(0, 129)),
      /Store batch\/record limit exceeded/,
    );
    assert.equal(await count(p.storage), 0);
    await p.backend.storeSnapshot(tree, records);
    const handle = await p.repo.find(id, { signal: AbortSignal.timeout(5000) });
    assert.deepEqual(A.getHeads(handle.doc()), A.getHeads(history));
    assert.equal(await count(p.storage), 602);
    await p.backend.storeSnapshot(tree, records);
    assert.equal(await count(p.storage), 602, "exact retries do not grow storage");
  } finally {
    await p.close();
  }
});

test("snapshot merging keeps both divergent histories at the requested document id", async () => {
  const p = peer(),
    id = freshId(),
    tree = documentIdToBinary(id);
  const local = A.change(A.clone(history), (doc) => {
    doc.local = "kept on this replica";
  });
  const cached = A.change(A.clone(history), (doc) => {
    doc.cached = "kept in shared checkpoint";
  });
  try {
    await p.backend.storeSnapshot(tree, loose(local));
    await p.backend.storeSnapshot(tree, loose(cached));
    const handle = await p.repo.find(id, { signal: AbortSignal.timeout(5000) });
    assert.equal(handle.doc().local, local.local);
    assert.equal(handle.doc().cached, cached.cached);
    assert.equal(await count(p.storage), 604);
  } finally {
    await p.close();
    A.free(local);
    A.free(cached);
  }
});

test("a failed native snapshot prefix can be reopened and retried under the same id", async () => {
  class FailingStore extends MemoryByteStore {
    writes = 0;
    fail = true;
    async save(key, value) {
      await super.save(key, value);
      if (this.fail && key.includes("/commits/") && ++this.writes === 20)
        throw Error("injected saved prefix failure");
    }
  }
  const storage = new FailingStore(),
    first = peer(storage),
    id = freshId(),
    tree = documentIdToBinary(id);
  await assert.rejects(first.backend.storeSnapshot(tree, records));
  const partial = await count(storage);
  assert.ok(partial > 0 && partial < 602, `expected persisted prefix, got ${partial}`);
  await first.backend.flush().catch(() => {}); // Report and retire the deliberately failed attempt.
  await first.close();
  storage.fail = false;
  const reopened = peer(storage);
  try {
    await reopened.backend.storeSnapshot(tree, records);
    const handle = await reopened.repo.find(id, { signal: AbortSignal.timeout(5000) });
    assert.deepEqual(A.getHeads(handle.doc()), A.getHeads(history));
    assert.equal(await count(storage), 602);
  } finally {
    await reopened.close();
  }
});

for (const limit of ["count", "bytes"])
  test(`snapshot union ${limit} limit rejects before persisting any incoming record`, async () => {
    const total = records.reduce((sum, r) => sum + recordBytes(r), 0);
    const p = peer(
      undefined,
      limit === "count" ? { maxRecords: 601 } : { maxSnapshotBytes: total - 1 },
    );
    const tree = documentIdToBinary(freshId());
    try {
      await p.backend.storeSnapshot(tree, records.slice(0, 100));
      await assert.rejects(
        p.backend.storeSnapshot(tree, records.slice(100)),
        /Tree snapshot limit exceeded/,
      );
      assert.equal(await count(p.storage), 100);
      await p.backend.flush().catch(() => {});
    } finally {
      await p.close();
    }
  });

test("same-key snapshot conflict rejects the whole incoming set before mutation", async () => {
  const p = peer(),
    tree = documentIdToBinary(freshId());
  try {
    await p.backend.storeSnapshot(tree, records.slice(0, 1));
    const conflicting = { ...records[0], blob: new Uint8Array([1, 2, 3]) };
    await assert.rejects(
      p.backend.storeSnapshot(tree, [...records.slice(1), conflicting]),
      /Different same-key representation/,
    );
    assert.equal(await count(p.storage), 1);
    await p.backend.flush().catch(() => {});
  } finally {
    await p.close();
  }
});

test("snapshot aggregate and individual record admission remain bounded", async () => {
  const p = peer(undefined, { maxRecords: 601 }),
    tree = documentIdToBinary(freshId());
  try {
    await assert.rejects(
      p.backend.storeSnapshot(tree, records),
      /Store batch\/record limit exceeded/,
    );
    assert.equal(await count(p.storage), 0);
  } finally {
    await p.close();
  }
  const small = peer(undefined, { maxRecordBytes: recordBytes(records[0]) + 511 });
  try {
    await assert.rejects(
      small.backend.storeSnapshot(tree, records.slice(0, 1)),
      /Store batch\/record limit exceeded/,
    );
    assert.equal(await count(small.storage), 0);
  } finally {
    await small.close();
  }
});
