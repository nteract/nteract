/**
 * createCloudNotebookPersistence — the per-runtime controller pair: the
 * chunked NotebookDoc seed store plus the render-only RuntimeStateDoc
 * paint cache. The cache is written from `save_state_doc()` under its own
 * envelope key and never touches the seed store's keys (a paint source,
 * not a seed); the seed store lives under `[notebookId, "chunks", ...]`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Subject } from "rxjs";
import {
  RUNTIME_STATE_CACHE_KEY_SEGMENT,
  decodeNotebookDocChunkMeta,
  decodePersistedNotebookDoc,
  encodeNotebookDocChunkMeta,
  encodePersistedNotebookDoc,
  notebookDocChunkMetaKey,
  notebookDocIncrementalChunkKey,
  notebookDocSnapshotChunkKey,
  type NotebookDocPersistenceMeta,
  type StorageAdapter,
  type StorageChunk,
  type StorageKey,
} from "runtimed";
import {
  PersistenceRearmGate,
  createCloudNotebookPersistence,
  loadCloudPersistedNotebookSeed,
} from "../viewer/notebook-persistence.ts";

function createRecordingAdapter(): StorageAdapter & { records: Map<string, Uint8Array> } {
  const records = new Map<string, Uint8Array>();
  return {
    records,
    load: async (key: StorageKey) => records.get(key.join("/")),
    save: async (key: StorageKey, data: Uint8Array) => {
      records.set(key.join("/"), data);
    },
    remove: async (key: StorageKey) => {
      records.delete(key.join("/"));
    },
    // Prefix-faithful range read so the chunk loader sees real records.
    loadRange: async (prefix: StorageKey) => {
      const rangePrefix = `${prefix.join("/")}/`;
      const chunks: StorageChunk[] = [];
      for (const [joined, data] of records) {
        if (joined.startsWith(rangePrefix)) {
          chunks.push({ key: joined.split("/"), data });
        }
      }
      return chunks;
    },
    // Prefix-faithful (mirrors the runtimed test adapter): a future
    // range-clear assertion in this file must never pass vacuously
    // against a clear-everything stub.
    removeRange: async (prefix: StorageKey) => {
      const exact = prefix.join("/");
      const rangePrefix = `${exact}/`;
      const doomed = Array.from(records.keys()).filter(
        (key) => key === exact || key.startsWith(rangePrefix),
      );
      for (const key of doomed) {
        records.delete(key);
      }
    },
  };
}

function createHarness() {
  const adapter = createRecordingAdapter();
  const notebookDocChanged$ = new Subject<void>();
  const runtimeState$ = new Subject<unknown>();
  let stateBytes = new Uint8Array([1]);
  const handle = {
    save: () => new Uint8Array([100]),
    save_since_heads: (headsHex: string[]) =>
      headsHex.length === 0 ? new Uint8Array([100]) : new Uint8Array([101]),
    get_heads_hex: () => ["doc-head"],
    save_state_doc: () => stateBytes,
    get_runtime_state_heads_hex: () => ["state-head"],
  };
  return {
    adapter,
    notebookDocChanged$,
    runtimeState$,
    handle,
    setStateBytes: (bytes: Uint8Array) => {
      stateBytes = bytes;
    },
    arm: (principal = "user:dev:alice", seedSavedHeadsHex?: string[]) =>
      createCloudNotebookPersistence({
        adapter,
        notebookId: "nb-1",
        principal,
        engine: { notebookDocChanged$, runtimeState$ },
        handle,
        seedSavedHeadsHex,
        throttleMs: 5,
      }),
  };
}

const ALICE = "user:dev:alice";
const SEED_SNAPSHOT_CHUNK_KEY = notebookDocSnapshotChunkKey("nb-1", ALICE, ["doc-head"]).join("/");
const SEED_CHUNK_META_KEY = notebookDocChunkMetaKey("nb-1", ALICE).join("/");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createCloudNotebookPersistence", () => {
  it("throttles runtime-state emissions into one cache record from save_state_doc", async () => {
    const harness = createHarness();
    const controller = harness.arm();
    assert.ok(controller);

    harness.runtimeState$.next({});
    harness.runtimeState$.next({});
    harness.setStateBytes(new Uint8Array([7, 7]));
    harness.runtimeState$.next({});
    await sleep(30);

    // Exactly one throttled write, capturing the LATEST state bytes, under
    // the cache key — and nothing under the NotebookDoc seed key (the
    // runtime-state stream must never cross-wire into the seed record).
    assert.deepEqual([...harness.adapter.records.keys()], ["nb-1/runtime-state-cache"]);
    const record = decodePersistedNotebookDoc(
      harness.adapter.records.get(`nb-1/${RUNTIME_STATE_CACHE_KEY_SEGMENT}`)!,
    );
    assert.deepEqual(record.bytes, new Uint8Array([7, 7]));
    assert.deepEqual(record.meta?.headsHex, ["state-head"]);
    assert.equal(record.meta?.principal, "user:dev:alice");
    controller.dispose();
  });

  it("writes the seed store as chunks from notebookDocChanged$ without touching the cache", async () => {
    const harness = createHarness();
    const controller = harness.arm();
    assert.ok(controller);

    harness.notebookDocChanged$.next();
    await sleep(30);

    // First save with an empty chunk inventory hits the compaction floor:
    // one snapshot chunk + the meta record, NEVER the legacy envelope key
    // (which is left to the migration fallback) and never the cache key.
    assert.deepEqual(
      [...harness.adapter.records.keys()].sort(),
      [SEED_CHUNK_META_KEY, SEED_SNAPSHOT_CHUNK_KEY].sort(),
    );
    assert.deepEqual(
      harness.adapter.records.get(SEED_SNAPSHOT_CHUNK_KEY),
      new Uint8Array([100]),
      "snapshot chunk carries handle.save() bytes",
    );
    const meta = decodeNotebookDocChunkMeta(harness.adapter.records.get(SEED_CHUNK_META_KEY)!);
    assert.equal(meta?.principal, "user:dev:alice");
    assert.deepEqual(meta?.headsHex, ["doc-head"]);
    controller.dispose();
  });

  it("seedSavedHeadsHex dedupes only the seed record, never the cache", async () => {
    const harness = createHarness();
    // The runtime seeded from a record at the handle's current doc heads.
    const controller = harness.arm("user:dev:alice", ["doc-head"]);
    assert.ok(controller);

    // The handshake's protocol-only change signal: unchanged doc heads must
    // not re-write the seed record the session just loaded.
    harness.notebookDocChanged$.next();
    // The cache controller's heads space is the RuntimeStateDoc's — the
    // seed's NotebookDoc heads must not suppress its first write.
    harness.runtimeState$.next({});
    await sleep(30);

    assert.deepEqual([...harness.adapter.records.keys()], ["nb-1/runtime-state-cache"]);
    controller.dispose();
  });

  it("arms nothing for anonymous principals", () => {
    const harness = createHarness();
    const controller = harness.arm("anonymous:viewer-session-1");

    assert.equal(controller, null);
    assert.equal(harness.notebookDocChanged$.observed, false);
    assert.equal(harness.runtimeState$.observed, false);
  });

  it("flushNow captures both records synchronously, before the handle is freed", async () => {
    const harness = createHarness();
    const controller = harness.arm();
    assert.ok(controller);

    const flush = controller.flushNow();
    // Simulate the session freeing the WASM handle right after flushNow
    // returns: any later capture would throw.
    harness.handle.save = () => {
      throw new Error("handle freed");
    };
    harness.handle.save_since_heads = () => {
      throw new Error("handle freed");
    };
    harness.handle.save_state_doc = () => {
      throw new Error("handle freed");
    };
    await flush;

    assert.deepEqual(
      [...harness.adapter.records.keys()].sort(),
      [SEED_CHUNK_META_KEY, SEED_SNAPSHOT_CHUNK_KEY, "nb-1/runtime-state-cache"].sort(),
    );
    controller.dispose();
  });
});

function chunkMeta(
  principal: string,
  overrides: Partial<NotebookDocPersistenceMeta> = {},
): NotebookDocPersistenceMeta {
  return {
    headsHex: ["chunk-head"],
    savedAt: 10,
    principal,
    schemaVersion: 1,
    generation: 7,
    ...overrides,
  };
}

function envelopeRecord(principal: string, bytes: Uint8Array, savedAt = 1): Uint8Array {
  return encodePersistedNotebookDoc(
    { headsHex: ["env-head"], savedAt, principal, schemaVersion: 1 },
    bytes,
  );
}

describe("loadCloudPersistedNotebookSeed", () => {
  it("prefers the chunk store and returns its inventory + generation", async () => {
    const adapter = createRecordingAdapter();
    await adapter.save(["nb-1", "snapshot"], envelopeRecord(ALICE, new Uint8Array([9])));
    await adapter.save(notebookDocSnapshotChunkKey("nb-1", ALICE, ["h1"]), new Uint8Array([1, 2]));
    await adapter.save(notebookDocIncrementalChunkKey("nb-1", ALICE, "abcd"), new Uint8Array([3]));
    await adapter.save(
      notebookDocChunkMetaKey("nb-1", ALICE),
      encodeNotebookDocChunkMeta(chunkMeta(ALICE)),
    );

    const seed = await loadCloudPersistedNotebookSeed(adapter, "nb-1", ALICE);
    assert.ok(seed);
    // Concatenated snapshot-then-incremental bytes, not the envelope's.
    assert.deepEqual(seed.bytes, new Uint8Array([1, 2, 3]));
    assert.equal(seed.meta?.principal, ALICE);
    assert.equal(seed.meta?.generation, 7);
    assert.equal(seed.chunks?.length, 2);
    // Reading must not clear anything.
    assert.ok(adapter.records.has("nb-1/snapshot"));
    assert.ok(adapter.records.has(SEED_CHUNK_META_KEY));
  });

  it("never sees another principal's sub-range — single-principal unions by construction", async () => {
    const adapter = createRecordingAdapter();
    await adapter.save(["nb-1", "snapshot"], envelopeRecord(ALICE, new Uint8Array([9])));
    // Another principal's store, meta and all — under a different prefix.
    await adapter.save(
      notebookDocSnapshotChunkKey("nb-1", "user:dev:mallory", ["h1"]),
      new Uint8Array([1, 2]),
    );
    await adapter.save(
      notebookDocChunkMetaKey("nb-1", "user:dev:mallory"),
      encodeNotebookDocChunkMeta(chunkMeta("user:dev:mallory")),
    );

    const seed = await loadCloudPersistedNotebookSeed(adapter, "nb-1", ALICE);
    assert.ok(seed);
    assert.deepEqual(seed.bytes, new Uint8Array([9]), "fell back to the envelope record");
    assert.equal(seed.chunks, undefined);
    // The foreign sub-range is invisible — and untouched (no clears).
    assert.ok(adapter.records.has(notebookDocChunkMetaKey("nb-1", "user:dev:mallory").join("/")));
  });

  it("treats missing/corrupt chunk meta as unverifiable: clears ONLY this sub-range, falls back", async () => {
    const adapter = createRecordingAdapter();
    await adapter.save(["nb-1", "snapshot"], envelopeRecord(ALICE, new Uint8Array([9])));
    await adapter.save(
      ["nb-1", RUNTIME_STATE_CACHE_KEY_SEGMENT],
      envelopeRecord(ALICE, new Uint8Array([8])),
    );
    await adapter.save(notebookDocSnapshotChunkKey("nb-1", ALICE, ["h1"]), new Uint8Array([1, 2]));
    // No meta record at all.
    await adapter.save(
      notebookDocChunkMetaKey("nb-1", "user:dev:mallory"),
      encodeNotebookDocChunkMeta(chunkMeta("user:dev:mallory")),
    );

    const seed = await loadCloudPersistedNotebookSeed(adapter, "nb-1", ALICE);
    assert.ok(seed);
    assert.deepEqual(seed.bytes, new Uint8Array([9]));
    const remaining = [...adapter.records.keys()].sort();
    assert.deepEqual(
      remaining,
      [
        notebookDocChunkMetaKey("nb-1", "user:dev:mallory").join("/"),
        "nb-1/runtime-state-cache",
        "nb-1/snapshot",
      ].sort(),
      "own sub-range cleared; envelope, paint cache, and the foreign sub-range survive",
    );
  });

  it("prefers a strictly NEWER envelope (rollback rule) and keeps the chunks in place", async () => {
    const adapter = createRecordingAdapter();
    // Chunks written at savedAt=10; a rolled-back app version then wrote
    // the envelope at savedAt=20 with offline edits.
    await adapter.save(notebookDocSnapshotChunkKey("nb-1", ALICE, ["h1"]), new Uint8Array([1, 2]));
    await adapter.save(
      notebookDocChunkMetaKey("nb-1", ALICE),
      encodeNotebookDocChunkMeta(chunkMeta(ALICE, { savedAt: 10 })),
    );
    await adapter.save(["nb-1", "snapshot"], envelopeRecord(ALICE, new Uint8Array([9]), 20));

    const seed = await loadCloudPersistedNotebookSeed(adapter, "nb-1", ALICE);
    assert.ok(seed);
    assert.deepEqual(seed.bytes, new Uint8Array([9]), "the newer envelope seeds");
    assert.equal(seed.chunks, undefined, "no chunk inventory rides a non-chunk seed");
    // The stale chunks stay: the session's first save snapshots fresh
    // into the same sub-range and later loads union both lines.
    assert.ok(adapter.records.has(notebookDocSnapshotChunkKey("nb-1", ALICE, ["h1"]).join("/")));
  });

  it("keeps preferring the chunk store when it is as new or newer than the envelope", async () => {
    const adapter = createRecordingAdapter();
    await adapter.save(notebookDocSnapshotChunkKey("nb-1", ALICE, ["h1"]), new Uint8Array([1, 2]));
    await adapter.save(
      notebookDocChunkMetaKey("nb-1", ALICE),
      encodeNotebookDocChunkMeta(chunkMeta(ALICE, { savedAt: 20 })),
    );
    await adapter.save(["nb-1", "snapshot"], envelopeRecord(ALICE, new Uint8Array([9]), 20));

    const seed = await loadCloudPersistedNotebookSeed(adapter, "nb-1", ALICE);
    assert.ok(seed);
    assert.deepEqual(seed.bytes, new Uint8Array([1, 2]), "ties prefer the live chunk format");
    assert.equal(seed.chunks?.length, 1);
  });

  it("ignores a newer envelope under ANOTHER principal", async () => {
    const adapter = createRecordingAdapter();
    await adapter.save(notebookDocSnapshotChunkKey("nb-1", ALICE, ["h1"]), new Uint8Array([1, 2]));
    await adapter.save(
      notebookDocChunkMetaKey("nb-1", ALICE),
      encodeNotebookDocChunkMeta(chunkMeta(ALICE, { savedAt: 10 })),
    );
    await adapter.save(
      ["nb-1", "snapshot"],
      envelopeRecord("user:dev:mallory", new Uint8Array([9]), 20),
    );

    const seed = await loadCloudPersistedNotebookSeed(adapter, "nb-1", ALICE);
    assert.ok(seed);
    assert.deepEqual(seed.bytes, new Uint8Array([1, 2]));
  });

  it("returns the envelope record when no chunks exist (migration fallback)", async () => {
    const adapter = createRecordingAdapter();
    await adapter.save(["nb-1", "snapshot"], envelopeRecord(ALICE, new Uint8Array([9])));

    const seed = await loadCloudPersistedNotebookSeed(adapter, "nb-1", ALICE);
    assert.ok(seed);
    assert.deepEqual(seed.bytes, new Uint8Array([9]));
    assert.equal(seed.chunks, undefined);
  });

  it("returns undefined when nothing is persisted", async () => {
    const adapter = createRecordingAdapter();
    const seed = await loadCloudPersistedNotebookSeed(adapter, "nb-1", ALICE);
    assert.equal(seed, undefined);
  });

  it("migration: an envelope-seeded controller's first save writes a snapshot chunk and leaves the envelope", async () => {
    const harness = createHarness();
    await harness.adapter.save(["nb-1", "snapshot"], envelopeRecord(ALICE, new Uint8Array([9])));
    // Seeded from the envelope: heads-dedupe initialized, chunk inventory empty.
    const controller = harness.arm(ALICE, ["env-head"]);
    assert.ok(controller);

    harness.notebookDocChanged$.next();
    await sleep(30);

    assert.deepEqual(
      [...harness.adapter.records.keys()].sort(),
      [SEED_CHUNK_META_KEY, SEED_SNAPSHOT_CHUNK_KEY, "nb-1/snapshot"].sort(),
      "fresh snapshot chunk written; envelope left in place for rollback",
    );
    controller.dispose();
  });
});

describe("persistence single heal (self-disable -> one re-arm)", () => {
  it("the controller pair signals self-disable ONCE even when both controllers die", async () => {
    const harness = createHarness();
    let heads = 0;
    harness.handle.get_heads_hex = () => [`h${heads}`];
    let stateHeads = 0;
    harness.handle.get_runtime_state_heads_hex = () => [`s${stateHeads}`];
    harness.adapter.save = async () => {
      throw new Error("quota exceeded");
    };
    const selfDisabled: number[] = [];
    const controller = createCloudNotebookPersistence({
      adapter: harness.adapter,
      notebookId: "nb-1",
      principal: ALICE,
      engine: {
        notebookDocChanged$: harness.notebookDocChanged$,
        runtimeState$: harness.runtimeState$,
      },
      handle: harness.handle,
      throttleMs: 5,
      onSelfDisabled: () => selfDisabled.push(1),
    });
    assert.ok(controller);

    // Kill the NotebookDoc controller: three failed captures (heads must
    // move; a failed write forgets its optimistic key, but distinct heads
    // keep this honest).
    for (let i = 0; i < 3; i++) {
      heads += 1;
      harness.notebookDocChanged$.next();
      await sleep(20);
    }
    assert.equal(selfDisabled.length, 1, "first controller death signals");

    // Kill the runtime-state cache controller too: no second signal —
    // they share one backend and one heal budget.
    for (let i = 0; i < 3; i++) {
      stateHeads += 1;
      harness.runtimeState$.next({});
      await sleep(20);
    }
    assert.equal(selfDisabled.length, 1, "the pair signals at most once");
    controller.dispose();
  });

  it("PersistenceRearmGate: one retry on the next trigger; a second failure stays disabled", () => {
    const gate = new PersistenceRearmGate();

    // No self-disable yet: online transitions consume nothing.
    assert.equal(gate.takeRearm(), false);

    // Self-disable, then the next online event -> the single re-arm.
    gate.noteSelfDisabled();
    assert.equal(gate.takeRearm(), true, "one retry is owed");
    assert.equal(gate.takeRearm(), false, "and only one");

    // The re-armed controller fails again: disabled for the session.
    gate.noteSelfDisabled();
    assert.equal(gate.takeRearm(), false, "the single heal is spent");
  });
});
