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

const SEED_SNAPSHOT_CHUNK_KEY = notebookDocSnapshotChunkKey("nb-1", ["doc-head"]).join("/");
const SEED_CHUNK_META_KEY = notebookDocChunkMetaKey("nb-1").join("/");

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

function chunkMeta(principal: string, headsHex = ["chunk-head"]): NotebookDocPersistenceMeta {
  return { headsHex, savedAt: 1, principal, schemaVersion: 1 };
}

function envelopeRecord(principal: string, bytes: Uint8Array): Uint8Array {
  return encodePersistedNotebookDoc(
    { headsHex: ["env-head"], savedAt: 1, principal, schemaVersion: 1 },
    bytes,
  );
}

describe("loadCloudPersistedNotebookSeed", () => {
  it("prefers the chunk store and returns its inventory", async () => {
    const adapter = createRecordingAdapter();
    await adapter.save(["nb-1", "snapshot"], envelopeRecord("user:dev:alice", new Uint8Array([9])));
    await adapter.save(notebookDocSnapshotChunkKey("nb-1", ["h1"]), new Uint8Array([1, 2]));
    await adapter.save(notebookDocIncrementalChunkKey("nb-1", "abcd"), new Uint8Array([3]));
    await adapter.save(
      notebookDocChunkMetaKey("nb-1"),
      encodeNotebookDocChunkMeta(chunkMeta("user:dev:alice")),
    );

    const seed = await loadCloudPersistedNotebookSeed(adapter, "nb-1", "user:dev:alice");
    assert.ok(seed);
    // Concatenated snapshot-then-incremental bytes, not the envelope's.
    assert.deepEqual(seed.bytes, new Uint8Array([1, 2, 3]));
    assert.equal(seed.meta?.principal, "user:dev:alice");
    assert.equal(seed.chunks?.length, 2);
    // Reading must not clear anything.
    assert.ok(adapter.records.has("nb-1/snapshot"));
    assert.ok(adapter.records.has(SEED_CHUNK_META_KEY));
  });

  it("clears ONLY the chunk range on principal mismatch and falls back to the envelope", async () => {
    const adapter = createRecordingAdapter();
    await adapter.save(["nb-1", "snapshot"], envelopeRecord("user:dev:alice", new Uint8Array([9])));
    await adapter.save(
      ["nb-1", RUNTIME_STATE_CACHE_KEY_SEGMENT],
      envelopeRecord("user:dev:alice", new Uint8Array([8])),
    );
    await adapter.save(notebookDocSnapshotChunkKey("nb-1", ["h1"]), new Uint8Array([1, 2]));
    await adapter.save(
      notebookDocChunkMetaKey("nb-1"),
      encodeNotebookDocChunkMeta(chunkMeta("user:dev:mallory")),
    );

    const seed = await loadCloudPersistedNotebookSeed(adapter, "nb-1", "user:dev:alice");
    assert.ok(seed);
    assert.deepEqual(seed.bytes, new Uint8Array([9]), "fell back to the envelope record");
    assert.equal(seed.chunks, undefined);
    const remaining = [...adapter.records.keys()].sort();
    assert.deepEqual(
      remaining,
      ["nb-1/runtime-state-cache", "nb-1/snapshot"],
      "chunk range cleared; envelope and paint cache survive",
    );
  });

  it("treats missing/corrupt chunk meta as unverifiable: clears chunks, falls back", async () => {
    const adapter = createRecordingAdapter();
    await adapter.save(["nb-1", "snapshot"], envelopeRecord("user:dev:alice", new Uint8Array([9])));
    await adapter.save(notebookDocSnapshotChunkKey("nb-1", ["h1"]), new Uint8Array([1, 2]));
    // No meta record at all.

    const seed = await loadCloudPersistedNotebookSeed(adapter, "nb-1", "user:dev:alice");
    assert.ok(seed);
    assert.deepEqual(seed.bytes, new Uint8Array([9]));
    assert.equal(adapter.records.has(SEED_SNAPSHOT_CHUNK_KEY.replace("doc-head", "h1")), false);
  });

  it("returns the envelope record when no chunks exist (migration fallback)", async () => {
    const adapter = createRecordingAdapter();
    await adapter.save(["nb-1", "snapshot"], envelopeRecord("user:dev:alice", new Uint8Array([9])));

    const seed = await loadCloudPersistedNotebookSeed(adapter, "nb-1", "user:dev:alice");
    assert.ok(seed);
    assert.deepEqual(seed.bytes, new Uint8Array([9]));
    assert.equal(seed.chunks, undefined);
  });

  it("returns undefined when nothing is persisted", async () => {
    const adapter = createRecordingAdapter();
    const seed = await loadCloudPersistedNotebookSeed(adapter, "nb-1", "user:dev:alice");
    assert.equal(seed, undefined);
  });

  it("migration: an envelope-seeded controller's first save writes a snapshot chunk and leaves the envelope", async () => {
    const harness = createHarness();
    await harness.adapter.save(
      ["nb-1", "snapshot"],
      envelopeRecord("user:dev:alice", new Uint8Array([9])),
    );
    // Seeded from the envelope: heads-dedupe initialized, chunk inventory empty.
    const controller = harness.arm("user:dev:alice", ["env-head"]);
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
