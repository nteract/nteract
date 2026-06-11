/**
 * Chunked NotebookDoc store tests: capture/compaction discipline in
 * NotebookDocPersistence's chunked mode, the chunk loader, and the
 * range-scoped clear. Mock adapter with an operation log so ordering
 * claims (write-before-delete, chunk-then-meta crash ordering, saveBatch
 * atomicity ride-through) are pinned, not assumed.
 *
 * The review-round invariants get their own pins here too: the
 * incremental basis must be chunk-store-covered (an envelope-migrated
 * seed never cuts incrementals before its first snapshot commits — even
 * racing a held-then-failed first snapshot), and the generation epoch
 * drops incrementals whose store another session cleared.
 */

import { Subject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  NotebookDocPersistence,
  clearPersistedNotebookDocChunks,
  decodeNotebookDocChunkMeta,
  encodeNotebookDocChunkMeta,
  loadAllPersistedNotebookDocChunkStores,
  loadPersistedNotebookDocChunks,
  notebookDocChunkMetaKey,
  notebookDocIncrementalChunkKey,
  notebookDocSnapshotChunkKey,
  type NotebookDocChunkInfo,
  type NotebookDocPersistenceMeta,
} from "../src/persistence/notebook-doc-persistence";
import type { StorageAdapter, StorageChunk, StorageKey } from "../src/persistence/storage-adapter";

type Op =
  | { op: "save"; key: StorageKey }
  | { op: "saveBatch"; keys: StorageKey[] }
  | { op: "remove"; key: StorageKey };

interface RecordingAdapter extends StorageAdapter {
  ops: Op[];
  records: Map<string, Uint8Array>;
}

const joinKey = (key: StorageKey) => key.join("/");

const PRINCIPAL = "user:test:alice";

function createRecordingAdapter({ withSaveBatch = true } = {}): RecordingAdapter {
  const records = new Map<string, Uint8Array>();
  const ops: Op[] = [];
  const adapter: RecordingAdapter = {
    records,
    ops,
    load: vi.fn(async (key: StorageKey) => records.get(joinKey(key))),
    save: vi.fn(async (key: StorageKey, data: Uint8Array) => {
      ops.push({ op: "save", key });
      records.set(joinKey(key), data);
    }),
    remove: vi.fn(async (key: StorageKey) => {
      ops.push({ op: "remove", key });
      records.delete(joinKey(key));
    }),
    loadRange: vi.fn(async (prefix: StorageKey) => {
      const rangePrefix = `${joinKey(prefix)}/`;
      const chunks: StorageChunk[] = [];
      for (const [joined, data] of records) {
        if (joined.startsWith(rangePrefix)) {
          chunks.push({ key: joined.split("/"), data });
        }
      }
      return chunks;
    }),
    removeRange: vi.fn(async (prefix: StorageKey) => {
      const exact = joinKey(prefix);
      const rangePrefix = `${exact}/`;
      for (const key of [...records.keys()]) {
        if (key === exact || key.startsWith(rangePrefix)) {
          records.delete(key);
        }
      }
    }),
  };
  if (withSaveBatch) {
    adapter.saveBatch = vi.fn(async (entries: Array<[StorageKey, Uint8Array]>) => {
      ops.push({ op: "saveBatch", keys: entries.map(([key]) => key) });
      for (const [key, data] of entries) {
        records.set(joinKey(key), data);
      }
    });
  }
  return adapter;
}

/** Deterministic content "hash" for tests: the bytes themselves. */
const identityDigest = (bytes: Uint8Array) => bytes;

const bytesHex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const silentLogger = { warn: () => {} };

function storeMeta(
  overrides: Partial<NotebookDocPersistenceMeta> = {},
): NotebookDocPersistenceMeta {
  return {
    headsHex: ["seed"],
    savedAt: 1,
    principal: PRINCIPAL,
    schemaVersion: 1,
    ...overrides,
  };
}

describe("NotebookDocPersistence (chunked mode)", () => {
  let adapter: RecordingAdapter;
  let changes$: Subject<void>;
  let saveBytes: Uint8Array;
  let sinceBytes: Uint8Array;
  let sinceCalls: string[][];
  let headsHex: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    adapter = createRecordingAdapter();
    changes$ = new Subject<void>();
    saveBytes = new Uint8Array([1, 2, 3]);
    sinceBytes = new Uint8Array([9]);
    sinceCalls = [];
    headsHex = ["aa"];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createController(
    overrides: Partial<ConstructorParameters<typeof NotebookDocPersistence>[0]> = {},
    chunkedOverrides: { initialChunks?: NotebookDocChunkInfo[]; initialGeneration?: number } = {},
  ): NotebookDocPersistence {
    return new NotebookDocPersistence({
      adapter,
      notebookId: "nb-1",
      principal: PRINCIPAL,
      changes$,
      getSaveBytes: () => saveBytes,
      getHeadsHex: () => headsHex,
      logger: silentLogger,
      chunked: {
        getSaveBytesSince: (basis) => {
          sinceCalls.push([...basis]);
          return sinceBytes;
        },
        digest: identityDigest,
        ...chunkedOverrides,
      },
      ...overrides,
    });
  }

  /** A committed snapshot chunk large enough to keep compaction quiet. */
  function bigSnapshotInventory(size = 4096): NotebookDocChunkInfo[] {
    return [
      { key: notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["seed"]), size, kind: "snapshot" },
    ];
  }

  /** The live store meta record a chunk-seeded session would have loaded. */
  function seedStoreMetaRecord(generation: number): void {
    adapter.records.set(
      joinKey(notebookDocChunkMetaKey("nb-1", PRINCIPAL)),
      encodeNotebookDocChunkMeta(storeMeta({ generation })),
    );
  }

  it("first save with no inventory writes snapshot chunk + meta in ONE saveBatch", async () => {
    const controller = createController();

    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(adapter.ops).toEqual([
      {
        op: "saveBatch",
        keys: [
          notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["aa"]),
          notebookDocChunkMetaKey("nb-1", PRINCIPAL),
        ],
      },
    ]);
    expect(
      adapter.records.get(joinKey(notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["aa"]))),
    ).toEqual(saveBytes);
    const meta = decodeNotebookDocChunkMeta(
      adapter.records.get(joinKey(notebookDocChunkMetaKey("nb-1", PRINCIPAL)))!,
    );
    expect(meta?.principal).toBe(PRINCIPAL);
    expect(meta?.headsHex).toEqual(["aa"]);
    expect(meta?.schemaVersion).toBe(1);
    // A fresh store mints its epoch on the first snapshot commit.
    expect(typeof meta?.generation).toBe("number");
    controller.dispose();
  });

  it("rides the sequential fallback chunk-then-meta when the adapter lacks saveBatch", async () => {
    adapter = createRecordingAdapter({ withSaveBatch: false });
    const controller = createController();

    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    // Crash ordering: the data chunk lands before the meta record, so a
    // crash between the two leaves an invisible orphan, never a meta
    // record describing bytes that are not there.
    expect(adapter.ops).toEqual([
      { op: "save", key: notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["aa"]) },
      { op: "save", key: notebookDocChunkMetaKey("nb-1", PRINCIPAL) },
    ]);
    controller.dispose();
  });

  it("writes content-addressed incrementals from the committed basis once a big snapshot exists", async () => {
    seedStoreMetaRecord(7);
    const controller = createController(
      { initialSavedHeadsHex: ["seed"] },
      { initialChunks: bigSnapshotInventory(), initialGeneration: 7 },
    );

    headsHex = ["bb"];
    sinceBytes = new Uint8Array([7, 7]);
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sinceCalls).toEqual([["seed"]]);
    const expectedKey = notebookDocIncrementalChunkKey("nb-1", PRINCIPAL, bytesHex(sinceBytes));
    expect(adapter.ops).toEqual([
      { op: "saveBatch", keys: [expectedKey, notebookDocChunkMetaKey("nb-1", PRINCIPAL)] },
    ]);
    expect(adapter.records.get(joinKey(expectedKey))).toEqual(sinceBytes);

    // The next incremental cuts from the NEW committed basis, and the
    // rewritten meta keeps the store epoch.
    const meta = decodeNotebookDocChunkMeta(
      adapter.records.get(joinKey(notebookDocChunkMetaKey("nb-1", PRINCIPAL)))!,
    );
    expect(meta?.generation).toBe(7);
    headsHex = ["cc"];
    sinceBytes = new Uint8Array([8]);
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sinceCalls).toEqual([["seed"], ["bb"]]);
    controller.dispose();
  });

  it("never trusts an envelope-seeded basis: no chunk inventory means the snapshot arm", async () => {
    // initialSavedHeadsHex WITHOUT initialChunks is the envelope-migrated
    // seed: the heads are durable only in the envelope record, so an
    // incremental cut from them would orphan. The dedupe keys stay; the
    // basis does not.
    const controller = createController({ initialSavedHeadsHex: ["env-head"] });

    headsHex = ["bb"];
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sinceCalls).toEqual([]);
    expect(adapter.ops).toEqual([
      {
        op: "saveBatch",
        keys: [
          notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["bb"]),
          notebookDocChunkMetaKey("nb-1", PRINCIPAL),
        ],
      },
    ]);
    controller.dispose();
  });

  it("REGRESSION: envelope-seeded + held-then-failed first snapshot + racing flushNow never yields an incremental-only store", async () => {
    // The C[0] kill chain: envelope-migrated session (basis = envelope
    // heads, empty inventory), the first snapshot is in flight when a
    // pagehide flushNow captures — under the old single-flight rule that
    // capture cut an incremental from the ENVELOPE heads; if the large
    // snapshot then failed (quota) and the small incremental committed,
    // the chunk store held only an incremental whose dependencies lived
    // solely in the envelope: MissingDeps at the next load, misread as
    // corruption, whole-range clear, offline edits gone.
    const onError = vi.fn();
    const controller = createController({
      initialSavedHeadsHex: ["env-head"],
      onError,
    });

    // Hold the first write open, then FAIL it.
    let failBatch: () => void = () => {};
    const gate = new Promise<void>((_, reject) => {
      failBatch = () => reject(new Error("quota exceeded"));
    });
    const realBatch = adapter.saveBatch!.bind(adapter);
    let heldWrites = 0;
    adapter.saveBatch = vi.fn(async (entries: Array<[StorageKey, Uint8Array]>) => {
      heldWrites += 1;
      if (heldWrites === 1) {
        await gate; // first (snapshot) write: held, then rejects
        return;
      }
      await realBatch(entries);
    });

    headsHex = ["bb"];
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000); // capture 1: snapshot, in flight

    headsHex = ["cc"];
    const flush = controller.flushNow(); // capture 2 races the held snapshot
    failBatch();
    await flush;

    // Capture 2 MUST have been a self-contained snapshot, not an
    // incremental cut from the envelope heads.
    expect(sinceCalls).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    const incrementalKeys = [...adapter.records.keys()].filter((key) =>
      key.includes("/incremental/"),
    );
    expect(incrementalKeys).toEqual([]);
    // The surviving write re-established the store as a full snapshot.
    expect(
      adapter.records.has(joinKey(notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["cc"]))),
    ).toBe(true);
    controller.dispose();
  });

  it("skips entirely when save_since yields no bytes beyond the committed basis", async () => {
    seedStoreMetaRecord(7);
    const controller = createController(
      { initialSavedHeadsHex: ["seed"] },
      { initialChunks: bigSnapshotInventory(), initialGeneration: 7 },
    );

    headsHex = ["bb"];
    sinceBytes = new Uint8Array(0);
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(adapter.ops).toEqual([]);
    controller.dispose();
  });

  it("compacts when incrementals reach snapshot size: write-before-delete, known chunks only", async () => {
    const snapshotKey = notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["seed"]);
    const incrementalKey = notebookDocIncrementalChunkKey("nb-1", PRINCIPAL, "f0f0");
    // Sizes >= 1024 so ONLY the ratio rule (incrementalSize >=
    // snapshotSize) triggers, not the tiny-snapshot floor.
    const inventory: NotebookDocChunkInfo[] = [
      { key: snapshotKey, size: 2048, kind: "snapshot" },
      { key: incrementalKey, size: 2048, kind: "incremental" },
    ];
    // A chunk some other tab wrote that this controller never loaded:
    const foreignKey = notebookDocIncrementalChunkKey("nb-1", PRINCIPAL, "dead");
    adapter.records.set(joinKey(foreignKey), new Uint8Array([1]));
    adapter.records.set(joinKey(snapshotKey), new Uint8Array(2048));
    adapter.records.set(joinKey(incrementalKey), new Uint8Array(2048));
    seedStoreMetaRecord(7);
    adapter.ops.length = 0;

    const controller = createController(
      { initialSavedHeadsHex: ["seed"] },
      { initialChunks: inventory, initialGeneration: 7 },
    );

    headsHex = ["bb"];
    saveBytes = new Uint8Array([5, 5, 5]);
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    const newSnapshotKey = notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["bb"]);
    expect(adapter.ops).toEqual([
      // The new snapshot (with meta) commits FIRST...
      { op: "saveBatch", keys: [newSnapshotKey, notebookDocChunkMetaKey("nb-1", PRINCIPAL)] },
      // ...then the known old chunks are deleted. The foreign chunk is
      // not in the inventory and must survive.
      { op: "remove", key: snapshotKey },
      { op: "remove", key: incrementalKey },
    ]);
    expect(adapter.records.has(joinKey(foreignKey))).toBe(true);
    expect(adapter.records.get(joinKey(newSnapshotKey))).toEqual(saveBytes);
    controller.dispose();
  });

  it("compacts while the snapshot is tiny (< 1024 bytes)", async () => {
    const controller = createController(
      { initialSavedHeadsHex: ["seed"] },
      {
        initialChunks: [
          {
            key: notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["seed"]),
            size: 10,
            kind: "snapshot",
          },
        ],
        initialGeneration: 7,
      },
    );

    headsHex = ["bb"];
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(adapter.ops[0]).toEqual({
      op: "saveBatch",
      keys: [
        notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["bb"]),
        notebookDocChunkMetaKey("nb-1", PRINCIPAL),
      ],
    });
    controller.dispose();
  });

  it("single-flight compaction: a capture racing an in-flight snapshot goes incremental once the store is established", async () => {
    // Tiny seed snapshot → the first capture compacts. The inventory IS
    // chunk-covered (this is the safe variant of the race; the unsafe
    // envelope-seeded variant is pinned above).
    seedStoreMetaRecord(7);
    const controller = createController(
      { initialSavedHeadsHex: ["seed"] },
      {
        initialChunks: [
          {
            key: notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["seed"]),
            size: 10,
            kind: "snapshot",
          },
        ],
        initialGeneration: 7,
      },
    );

    // Hold the first write open.
    let releaseBatch: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    const realBatch = adapter.saveBatch!.bind(adapter);
    adapter.saveBatch = vi.fn(async (entries: Array<[StorageKey, Uint8Array]>) => {
      await gate;
      await realBatch(entries);
    });

    headsHex = ["bb"];
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000); // capture 1: snapshot, in flight

    headsHex = ["cc"];
    const flush = controller.flushNow(); // capture 2 while compaction is in flight
    releaseBatch();
    await flush;

    // Capture 2 cut an incremental from the last COMMITTED basis (the
    // seed) instead of queueing a second full snapshot.
    expect(sinceCalls).toEqual([["seed"]]);
    const batchOps = adapter.ops.filter((op) => op.op === "saveBatch");
    expect(batchOps).toHaveLength(2);
    expect(batchOps[1]!.keys[0]).toEqual(
      notebookDocIncrementalChunkKey("nb-1", PRINCIPAL, bytesHex(sinceBytes)),
    );
    controller.dispose();
  });

  it("a failed chunk write forgets its optimistic heads so the next signal retries", async () => {
    const onError = vi.fn();
    const controller = createController({ onError });
    adapter.saveBatch = vi.fn(async () => {
      throw new Error("quota exceeded");
    });

    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledTimes(1);

    // Same heads, next signal: the failed capture must not dedupe it away.
    adapter.saveBatch = vi.fn(async (entries: Array<[StorageKey, Uint8Array]>) => {
      adapter.ops.push({ op: "saveBatch", keys: entries.map(([key]) => key) });
      for (const [key, data] of entries) {
        adapter.records.set(joinKey(key), data);
      }
    });
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      adapter.records.has(joinKey(notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["aa"]))),
    ).toBe(true);
    controller.dispose();
  });

  it("keeps a chunk whose delete failed inventoried and retries at the next compaction", async () => {
    const staleKey = notebookDocIncrementalChunkKey("nb-1", PRINCIPAL, "0101");
    adapter.records.set(joinKey(staleKey), new Uint8Array([1]));
    seedStoreMetaRecord(7);
    const controller = createController(
      { initialSavedHeadsHex: ["seed"] },
      {
        initialChunks: [
          {
            key: notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["seed"]),
            size: 10,
            kind: "snapshot",
          },
          { key: staleKey, size: 1, kind: "incremental" },
        ],
        initialGeneration: 7,
      },
    );

    const realRemove = adapter.remove;
    adapter.remove = vi.fn(async (key: StorageKey) => {
      if (joinKey(key) === joinKey(staleKey)) {
        adapter.remove = realRemove; // fail once, then heal
        throw new Error("transient remove failure");
      }
      await realRemove(key);
    });

    headsHex = ["bb"];
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000); // compaction 1: stale delete fails
    expect(adapter.records.has(joinKey(staleKey))).toBe(true);

    headsHex = ["cc"];
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000); // tiny snapshot → compaction 2 retries
    expect(adapter.records.has(joinKey(staleKey))).toBe(false);
    controller.dispose();
  });

  it("two tabs writing identical incremental bytes collide on one record", async () => {
    seedStoreMetaRecord(7);
    const seed = {
      opts: { initialSavedHeadsHex: ["seed"] },
      chunked: { initialChunks: bigSnapshotInventory(), initialGeneration: 7 },
    };
    const tabA = createController(seed.opts, seed.chunked);

    const changesB$ = new Subject<void>();
    const tabB = createController({ ...seed.opts, changes$: changesB$ }, seed.chunked);

    headsHex = ["bb"];
    sinceBytes = new Uint8Array([42, 42]);
    changes$.next();
    changesB$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    const expectedKey = notebookDocIncrementalChunkKey("nb-1", PRINCIPAL, bytesHex(sinceBytes));
    const chunkRecords = [...adapter.records.keys()].filter((key) => key.includes("/incremental/"));
    expect(chunkRecords).toEqual([joinKey(expectedKey)]);
    tabA.dispose();
    tabB.dispose();
  });

  // ── Generation epoch: external store resets ──────────────────────

  it("drops an incremental when the store was cleared, then re-establishes with a snapshot", async () => {
    seedStoreMetaRecord(7);
    const controller = createController(
      { initialSavedHeadsHex: ["seed"] },
      { initialChunks: bigSnapshotInventory(), initialGeneration: 7 },
    );

    // Another session cleared the whole sub-range (poison-pill discard).
    adapter.records.clear();
    adapter.ops.length = 0;

    headsHex = ["bb"];
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    // The captured incremental was DROPPED (no write of it), and the
    // self-retriggered capture re-established the store via the snapshot
    // arm — never an incremental orphaned against deleted chunks.
    await vi.advanceTimersByTimeAsync(1_000);
    const incrementalKeys = [...adapter.records.keys()].filter((key) =>
      key.includes("/incremental/"),
    );
    expect(incrementalKeys).toEqual([]);
    expect(
      adapter.records.has(joinKey(notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["bb"]))),
    ).toBe(true);
    const meta = decodeNotebookDocChunkMeta(
      adapter.records.get(joinKey(notebookDocChunkMetaKey("nb-1", PRINCIPAL)))!,
    );
    expect(typeof meta?.generation).toBe("number");
    expect(meta?.generation).not.toBe(7);
    controller.dispose();
  });

  it("drops an incremental when another session re-established the store under a new generation, then joins it", async () => {
    seedStoreMetaRecord(7);
    const controller = createController(
      { initialSavedHeadsHex: ["seed"] },
      { initialChunks: bigSnapshotInventory(), initialGeneration: 7 },
    );

    // Cleared AND re-established by another (bootstrapped) session.
    adapter.records.clear();
    adapter.records.set(
      joinKey(notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["other"])),
      new Uint8Array([6]),
    );
    seedStoreMetaRecord(99);
    adapter.ops.length = 0;

    headsHex = ["bb"];
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000); // incremental dropped
    await vi.advanceTimersByTimeAsync(1_000); // re-capture: snapshot, joins epoch 99

    expect([...adapter.records.keys()].filter((key) => key.includes("/incremental/"))).toEqual([]);
    expect(
      adapter.records.has(joinKey(notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["bb"]))),
    ).toBe(true);
    // Joined the live epoch instead of clobbering it...
    const meta = decodeNotebookDocChunkMeta(
      adapter.records.get(joinKey(notebookDocChunkMetaKey("nb-1", PRINCIPAL)))!,
    );
    expect(meta?.generation).toBe(99);
    // ...and never deleted the other session's chunks (stale inventory
    // was abandoned, not acted on).
    expect(
      adapter.records.has(joinKey(notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["other"]))),
    ).toBe(true);
    controller.dispose();
  });

  it("a snapshot commit that detects a reset abandons its stale inventory instead of deleting blind", async () => {
    // Inventory says compaction should delete the seed chunks; the store
    // was re-established meanwhile. The snapshot must commit (it is
    // self-contained) but delete NOTHING from the foreign epoch.
    seedStoreMetaRecord(7);
    const controller = createController(
      { initialSavedHeadsHex: ["seed"] },
      {
        initialChunks: [
          {
            key: notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["seed"]),
            size: 10, // tiny → compaction floor fires → snapshot arm
            kind: "snapshot",
          },
        ],
        initialGeneration: 7,
      },
    );

    adapter.records.clear();
    adapter.records.set(
      joinKey(notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["other"])),
      new Uint8Array([6]),
    );
    seedStoreMetaRecord(99);
    adapter.ops.length = 0;

    headsHex = ["bb"];
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(adapter.ops).toEqual([
      {
        op: "saveBatch",
        keys: [
          notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["bb"]),
          notebookDocChunkMetaKey("nb-1", PRINCIPAL),
        ],
      },
      // No removes: the stale inventory was abandoned.
    ]);
    expect(
      adapter.records.has(joinKey(notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["other"]))),
    ).toBe(true);
    controller.dispose();
  });
});

describe("loadPersistedNotebookDocChunks", () => {
  const meta: NotebookDocPersistenceMeta = {
    headsHex: ["aa"],
    savedAt: 123,
    principal: PRINCIPAL,
    schemaVersion: 1,
    generation: 7,
  };

  it("returns undefined when no data chunks exist", async () => {
    const adapter = createRecordingAdapter();
    expect(await loadPersistedNotebookDocChunks(adapter, "nb-1", PRINCIPAL)).toBeUndefined();
    // A meta record alone is not a loadable store either.
    adapter.records.set(
      joinKey(notebookDocChunkMetaKey("nb-1", PRINCIPAL)),
      encodeNotebookDocChunkMeta(meta),
    );
    expect(await loadPersistedNotebookDocChunks(adapter, "nb-1", PRINCIPAL)).toBeUndefined();
  });

  it("concatenates snapshots before incrementals and inventories the data chunks", async () => {
    const adapter = createRecordingAdapter();
    // Inserted in unsorted-on-kind order; the loader must reorder.
    adapter.records.set(
      joinKey(notebookDocIncrementalChunkKey("nb-1", PRINCIPAL, "aaaa")),
      new Uint8Array([4, 5]),
    );
    adapter.records.set(
      joinKey(notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["h1"])),
      new Uint8Array([1, 2, 3]),
    );
    adapter.records.set(
      joinKey(notebookDocChunkMetaKey("nb-1", PRINCIPAL)),
      encodeNotebookDocChunkMeta(meta),
    );

    const loaded = await loadPersistedNotebookDocChunks(adapter, "nb-1", PRINCIPAL);
    expect(loaded?.bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(loaded?.meta).toEqual(meta);
    expect(loaded?.chunks).toEqual([
      { key: notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["h1"]), size: 3, kind: "snapshot" },
      {
        key: notebookDocIncrementalChunkKey("nb-1", PRINCIPAL, "aaaa"),
        size: 2,
        kind: "incremental",
      },
    ]);
  });

  it("is scoped to one principal's sub-range — foreign chunks are invisible", async () => {
    const adapter = createRecordingAdapter();
    adapter.records.set(
      joinKey(notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["h1"])),
      new Uint8Array([1]),
    );
    adapter.records.set(
      joinKey(notebookDocChunkMetaKey("nb-1", PRINCIPAL)),
      encodeNotebookDocChunkMeta(meta),
    );
    adapter.records.set(
      joinKey(notebookDocSnapshotChunkKey("nb-1", "user:test:mallory", ["h9"])),
      new Uint8Array([9, 9]),
    );
    adapter.records.set(
      joinKey(notebookDocChunkMetaKey("nb-1", "user:test:mallory")),
      encodeNotebookDocChunkMeta(storeMeta({ principal: "user:test:mallory" })),
    );

    const loaded = await loadPersistedNotebookDocChunks(adapter, "nb-1", PRINCIPAL);
    // One meta record can never vouch for another principal's bytes —
    // the union is single-principal by key construction.
    expect(loaded?.bytes).toEqual(new Uint8Array([1]));
    expect(loaded?.chunks).toHaveLength(1);
    expect(loaded?.meta?.principal).toBe(PRINCIPAL);

    const stores = await loadAllPersistedNotebookDocChunkStores(adapter, "nb-1");
    expect(stores.map((store) => store.principal).sort()).toEqual([PRINCIPAL, "user:test:mallory"]);
  });

  it("degrades a corrupt meta record to null without dropping the bytes", async () => {
    const adapter = createRecordingAdapter();
    adapter.records.set(
      joinKey(notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["h1"])),
      new Uint8Array([1]),
    );
    adapter.records.set(
      joinKey(notebookDocChunkMetaKey("nb-1", PRINCIPAL)),
      new TextEncoder().encode("{not json"),
    );

    const loaded = await loadPersistedNotebookDocChunks(adapter, "nb-1", PRINCIPAL);
    expect(loaded?.meta).toBeNull();
    expect(loaded?.bytes).toEqual(new Uint8Array([1]));
  });

  it("ignores records under unknown sub-keys (forward compatibility)", async () => {
    const adapter = createRecordingAdapter();
    adapter.records.set(
      joinKey(notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["h1"])),
      new Uint8Array([1]),
    );
    adapter.records.set(`nb-1/chunks/${PRINCIPAL}/fragment/zzzz`, new Uint8Array([9, 9]));
    adapter.records.set(`nb-1/chunks/${PRINCIPAL}/snapshot/extra/deep`, new Uint8Array([9]));

    const loaded = await loadPersistedNotebookDocChunks(adapter, "nb-1", PRINCIPAL);
    expect(loaded?.bytes).toEqual(new Uint8Array([1]));
    expect(loaded?.chunks).toHaveLength(1);
    // Read paths never delete what they do not understand.
    expect(adapter.records.has(`nb-1/chunks/${PRINCIPAL}/fragment/zzzz`)).toBe(true);
  });
});

describe("clearPersistedNotebookDocChunks", () => {
  it("removes only the given principal's chunk sub-range", async () => {
    const adapter = createRecordingAdapter();
    adapter.records.set("nb-1/snapshot", new Uint8Array([1]));
    adapter.records.set("nb-1/runtime-state-cache", new Uint8Array([2]));
    adapter.records.set(
      joinKey(notebookDocSnapshotChunkKey("nb-1", PRINCIPAL, ["h1"])),
      new Uint8Array([3]),
    );
    adapter.records.set(joinKey(notebookDocChunkMetaKey("nb-1", PRINCIPAL)), new Uint8Array([4]));
    adapter.records.set(
      joinKey(notebookDocChunkMetaKey("nb-1", "user:test:mallory")),
      new Uint8Array([5]),
    );
    adapter.records.set(joinKey(notebookDocChunkMetaKey("nb-2", PRINCIPAL)), new Uint8Array([6]));

    await clearPersistedNotebookDocChunks(adapter, "nb-1", PRINCIPAL);

    expect([...adapter.records.keys()].sort()).toEqual(
      [
        joinKey(notebookDocChunkMetaKey("nb-1", "user:test:mallory")),
        "nb-1/runtime-state-cache",
        "nb-1/snapshot",
        joinKey(notebookDocChunkMetaKey("nb-2", PRINCIPAL)),
      ].sort(),
    );
  });
});

describe("chunked store end-to-end with real WASM", () => {
  it("save_since_heads chunks → loader concat → NotebookHandle.load round-trips", async () => {
    const { initWasm } = await import("./wasm-harness");
    const Handle = await initWasm();
    const handle = new Handle("nb-wasm");
    handle.set_actor("user:test:alice/browser:a");
    try {
      const adapter = createRecordingAdapter();
      const changes$ = new Subject<void>();
      const controller = new NotebookDocPersistence({
        adapter,
        notebookId: "nb-wasm",
        principal: PRINCIPAL,
        changes$,
        getSaveBytes: () => handle.save(),
        getHeadsHex: () => handle.get_heads_hex(),
        logger: silentLogger,
        chunked: {
          getSaveBytesSince: (basis) => handle.save_since_heads(basis),
        },
      });

      // First save: compaction floor → snapshot chunk.
      handle.add_cell(0, "cell-1", "code");
      handle.update_source("cell-1", "x = 1");
      await controller.flushNow();

      // Pad the doc past the 1024-byte compaction floor with
      // incompressible content (automerge snapshots are DEFLATEd, so
      // repeated text would compress right back under the floor).
      const padding = bytesHex(crypto.getRandomValues(new Uint8Array(2048)));
      handle.update_source("cell-1", `x = 1  # ${padding}`);
      await controller.flushNow();

      handle.add_cell(1, "cell-2", "markdown");
      handle.update_source("cell-2", "# from the incremental chunk");
      await controller.flushNow();

      const kinds = [...adapter.records.keys()]
        .filter((key) => key.startsWith(`nb-wasm/chunks/${PRINCIPAL}/`) && !key.endsWith("/meta"))
        .map((key) => key.split("/")[3]);
      expect(kinds).toContain("snapshot");
      expect(kinds).toContain("incremental");

      const loaded = await loadPersistedNotebookDocChunks(adapter, "nb-wasm", PRINCIPAL);
      expect(loaded?.meta?.principal).toBe(PRINCIPAL);
      expect(typeof loaded?.meta?.generation).toBe("number");
      const revived = Handle.load(loaded!.bytes);
      try {
        expect(revived.cell_count()).toBe(2);
        expect(revived.get_cell_source("cell-2")).toBe("# from the incremental chunk");
        expect(revived.get_heads_hex()).toEqual(handle.get_heads_hex());
      } finally {
        revived.free();
      }
      controller.dispose();
    } finally {
      handle.free();
    }
  });
});
