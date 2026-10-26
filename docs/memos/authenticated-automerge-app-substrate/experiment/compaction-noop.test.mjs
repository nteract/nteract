import assert from "node:assert/strict";
import test from "node:test";
import {
  documentIdToBinary,
  generateAutomergeUrl,
  interpretAsDocumentId,
} from "@automerge/automerge-repo";
import { recordKey } from "@automerge/automerge-repo/sedimentree";
import {
  StorageBridge,
  nativeId,
} from "./upstream/packages/automerge-repo-subduction/src/storage.ts";
import { reclaimableRecords } from "./upstream/packages/automerge-repo-subduction/src/compaction.ts";
import { closePeers } from "./backend.mjs";
import { measuredPeer } from "./persistence-benchmark.mjs";
import {
  buildPersistenceFixture,
  MeasuredByteStore,
  MiB,
  assertSameIdentity,
} from "./persistence-workload.mjs";

function unreadablePayload(record) {
  const result = { ...record };
  Object.defineProperty(result, "blob", {
    get() {
      throw Error("Unnecessary history payload access");
    },
  });
  return result;
}

async function installed(fixture) {
  const storage = new MeasuredByteStore();
  const peer = measuredPeer(storage);
  const id = interpretAsDocumentId(generateAutomergeUrl()),
    tree = documentIdToBinary(id);
  await peer.backend.storeSnapshot(tree, fixture.loose);
  await peer.backend.storeSnapshot(
    tree,
    fixture.covering.filter((r) => r.kind === "fragment"),
  );
  return { peer, storage, id, tree };
}

test("no omitted candidates means retained fragment payloads are never decoded", () => {
  const fixture = buildPersistenceFixture({ rounds: 80 });
  try {
    const fragment = fixture.covering.find((r) => r.kind === "fragment");
    assert.ok(fragment);
    const retained = unreadablePayload(fragment);
    assert.deepEqual(
      reclaimableRecords([retained], [retained], new Set([recordKey(retained)])),
      [],
    );
  } finally {
    fixture.free();
  }
});

test("bridge no-op borrows its already-owned record snapshot without copying payloads again", async () => {
  const fixture = buildPersistenceFixture({ rounds: 80 });
  const { peer, storage, tree } = await installed(fixture);
  const native = nativeId(Buffer.from(tree).toString("hex"));
  try {
    // A separate store keeps namespace ownership exclusive to this test bridge.
    const bridge = new StorageBridge(
      storage.copy(),
      { maxRecords: 10000, maxRecordBytes: 16 * MiB, maxSnapshotBytes: 64 * MiB },
      () => {},
    );
    const captured = await bridge.records(native);
    assert.ok(captured.length > fixture.loose.length);
    const keep = captured.map(recordKey);
    // The initial owned snapshot was already copied by records(). A no-op must
    // neither duplicate those bytes nor require another look at their contents.
    const owned = captured.map(unreadablePayload);
    const result = await bridge.compact(native, owned, keep, () => {
      throw Error("Unexpected no-op durability barrier");
    });
    assert.equal(result.removedRecords, 0);
    assert.equal(result.beforeRecords, captured.length);
  } finally {
    native.free();
    assert.deepEqual(await closePeers([peer]), []);
    fixture.free();
  }
});

test("exact retry after compaction restores signed originals on the same live engine", async () => {
  const fixture = buildPersistenceFixture({ rounds: 80 });
  const { peer, storage, id, tree } = await installed(fixture);
  try {
    const original = storage.copy();
    const removed = await peer.backend.compact(tree, { durable: async () => {} });
    assert.ok(removed.removedRecords > 0);
    assert.equal(storage.values.size, original.values.size - removed.removedRecords);
    // No rejected write, flush failure, reopen, or native engine replacement is
    // allowed before this retry. Acknowledgment must restore exact bytes.
    await peer.backend.storeSnapshot(tree, fixture.loose);
    await peer.backend.flush();
    assert.equal(storage.digest(), original.digest());
    assert.deepEqual(storage.values, original.values);
    const handle = await peer.repo.find(id, { signal: AbortSignal.timeout(5000) });
    assertSameIdentity(handle.doc(), fixture.doc);
  } finally {
    assert.deepEqual(await closePeers([peer]), []);
    fixture.free();
  }
});
