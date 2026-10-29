import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  documentIdToBinary,
  generateAutomergeUrl,
  interpretAsDocumentId,
} from "@automerge/automerge-repo";
import {
  buildPersistenceFixture,
  assertSameIdentity,
  identityProof,
  MeasuredByteStore,
  actors,
} from "./persistence-workload.mjs";
import { measuredPeer } from "./persistence-benchmark.mjs";
import { closePeers } from "./backend.mjs";

test("mixed human/agent corpus is deterministic and preserves a live passage comment", () => {
  const a = buildPersistenceFixture({ rounds: 16 });
  const b = buildPersistenceFixture({ rounds: 16 });
  try {
    assertSameIdentity(a.doc, b.doc);
    assert.deepEqual(a.metrics, b.metrics);
    const proof = identityProof(a.doc);
    assert.equal(proof.comment.status, "attached");
    assert.equal(proof.comment.text, "The Parquet file remains the bulk data source.");
    assert.deepEqual(proof.actors, [actors.human, actors.agent]);
    const restored = A.load(A.save(a.doc));
    try {
      assertSameIdentity(restored, a.doc);
    } finally {
      A.free(restored);
    }
    const merged = A.merge(A.clone(a.doc), a.dormant);
    try {
      assert.equal(identityProof(merged).comment.text, proof.comment.text);
      assert.ok(merged.blocks.foundation.richText.includes("Offline note:"));
      assert.ok(merged.blocks.notes.richText.includes("Phone draft retained."));
    } finally {
      A.free(merged);
    }
  } finally {
    a.free();
    b.free();
  }
});

test("real backend reopens mixed edits without changing heads, objects, marks, or comment cursors", async () => {
  const fixture = buildPersistenceFixture({ rounds: 32 });
  const storage = new MeasuredByteStore();
  let peer = measuredPeer(storage);
  const id = interpretAsDocumentId(generateAutomergeUrl());
  const tree = documentIdToBinary(id);
  try {
    await peer.backend.storeSnapshot(tree, fixture.loose);
    await peer.backend.storeSnapshot(
      tree,
      fixture.covering.filter((record) => record.kind === "fragment"),
    );
    await peer.backend.flush();
    const writes = storage.operations.filter(
      (op) => op.type === "save" && /\/(commits|fragments)\//.test(op.key),
    ).length;
    await peer.backend.storeSnapshot(tree, fixture.loose);
    await peer.backend.flush();
    assert.equal(
      storage.operations.filter(
        (op) => op.type === "save" && /\/(commits|fragments)\//.test(op.key),
      ).length,
      writes,
      "exact native retry must not rewrite records",
    );
    assert.deepEqual(await closePeers([peer]), []);
    peer = measuredPeer(storage.copy());
    const handle = await peer.repo.find(id, { signal: AbortSignal.timeout(5000) });
    assertSameIdentity(handle.doc(), fixture.doc);
    assert.equal(peer.storage.counters.saves, 0, "reopen should not author or rewrite data");
  } finally {
    assert.deepEqual(await closePeers([peer]), []);
    fixture.free();
  }
});

for (const phase of ["before", "after"]) {
  test(`interrupted native record ${phase}-write retries exact history after restart`, async () => {
    const fixture = buildPersistenceFixture({ rounds: 16 });
    const store = new MeasuredByteStore();
    let saves = 0;
    store.hook = (event) => {
      if (
        event.type === "save" &&
        event.phase === phase &&
        event.key.includes("/commits/") &&
        ++saves === 5
      )
        throw Error(`injected ${phase}-write failure`);
    };
    let peer = measuredPeer(store);
    const id = interpretAsDocumentId(generateAutomergeUrl());
    const tree = documentIdToBinary(id);
    try {
      await assert.rejects(peer.backend.storeSnapshot(tree, fixture.loose), /injected/);
      await peer.backend.flush().catch(() => {});
      assert.deepEqual(await closePeers([peer]), []);
      peer = measuredPeer(store.copy());
      await peer.backend.storeSnapshot(tree, fixture.loose);
      await peer.backend.flush();
      const handle = await peer.repo.find(id, { signal: AbortSignal.timeout(5000) });
      assertSameIdentity(handle.doc(), fixture.doc);
    } finally {
      assert.deepEqual(await closePeers([peer]), []);
      fixture.free();
    }
  });
}

test("corrupt persisted record emits an I/O failure and never opens or rewrites the page", async () => {
  const fixture = buildPersistenceFixture({ rounds: 8 });
  const store = new MeasuredByteStore();
  let peer = measuredPeer(store);
  const id = interpretAsDocumentId(generateAutomergeUrl());
  const tree = documentIdToBinary(id);
  try {
    await peer.backend.storeSnapshot(tree, fixture.loose);
    await peer.backend.flush();
    assert.deepEqual(await closePeers([peer]), []);
    const copied = store.copy();
    const key = [...copied.values.keys()].find((k) => k.includes("/commits/"));
    const value = copied.values.get(key);
    value[Math.floor(value.length / 2)] ^= 0xff;
    peer = measuredPeer(copied);
    await assert.rejects(peer.repo.find(id, { signal: AbortSignal.timeout(5000) }), (error) => {
      assert.notEqual(error.name, "TimeoutError");
      return true;
    });
    const observation = peer.backend.open(tree);
    try {
      await assert.rejects(async () => {
        for await (const event of observation.events) {
          if (event.type === "failure") {
            assert.equal(event.error.code, "io");
            throw event.error;
          }
          assert.notEqual(
            event.type,
            "local-load-complete",
            "corrupt history must not finish loading",
          );
        }
        throw Error("Missing explicit failure event");
      }, /encoded data|record|integrity|corrupt|decode|utf|metadata|blob/i);
    } finally {
      await observation.close();
    }
    assert.equal(copied.counters.saves, 0);
    await peer.backend.flush().catch(() => {});
  } finally {
    await closePeers([peer]);
    fixture.free();
  }
});
