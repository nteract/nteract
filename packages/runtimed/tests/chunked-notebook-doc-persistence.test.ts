/**
 * Chunked NotebookDoc store tests: capture/compaction discipline in
 * NotebookDocPersistence's chunked mode, the chunk loader, and the
 * range-scoped clear. Mock adapter with an operation log so ordering
 * claims (write-before-delete, chunk-then-meta crash ordering, saveBatch
 * atomicity ride-through) are pinned, not assumed.
 */

import { Subject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  NotebookDocPersistence,
  clearPersistedNotebookDocChunks,
  decodeNotebookDocChunkMeta,
  encodeNotebookDocChunkMeta,
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
    chunkedOverrides: { initialChunks?: NotebookDocChunkInfo[] } = {},
  ): NotebookDocPersistence {
    return new NotebookDocPersistence({
      adapter,
      notebookId: "nb-1",
      principal: "user:test:alice",
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
    return [{ key: notebookDocSnapshotChunkKey("nb-1", ["seed"]), size, kind: "snapshot" }];
  }

  it("first save with no inventory writes snapshot chunk + meta in ONE saveBatch", async () => {
    const controller = createController();

    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(adapter.ops).toEqual([
      {
        op: "saveBatch",
        keys: [notebookDocSnapshotChunkKey("nb-1", ["aa"]), notebookDocChunkMetaKey("nb-1")],
      },
    ]);
    expect(adapter.records.get(joinKey(notebookDocSnapshotChunkKey("nb-1", ["aa"])))).toEqual(
      saveBytes,
    );
    const meta = decodeNotebookDocChunkMeta(
      adapter.records.get(joinKey(notebookDocChunkMetaKey("nb-1")))!,
    );
    expect(meta?.principal).toBe("user:test:alice");
    expect(meta?.headsHex).toEqual(["aa"]);
    expect(meta?.schemaVersion).toBe(1);
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
      { op: "save", key: notebookDocSnapshotChunkKey("nb-1", ["aa"]) },
      { op: "save", key: notebookDocChunkMetaKey("nb-1") },
    ]);
    controller.dispose();
  });

  it("writes content-addressed incrementals from the committed basis once a big snapshot exists", async () => {
    const controller = createController(
      { initialSavedHeadsHex: ["seed"] },
      { initialChunks: bigSnapshotInventory() },
    );

    headsHex = ["bb"];
    sinceBytes = new Uint8Array([7, 7]);
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sinceCalls).toEqual([["seed"]]);
    const expectedKey = notebookDocIncrementalChunkKey("nb-1", bytesHex(sinceBytes));
    expect(adapter.ops).toEqual([
      { op: "saveBatch", keys: [expectedKey, notebookDocChunkMetaKey("nb-1")] },
    ]);
    expect(adapter.records.get(joinKey(expectedKey))).toEqual(sinceBytes);

    // The next incremental cuts from the NEW committed basis.
    headsHex = ["cc"];
    sinceBytes = new Uint8Array([8]);
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sinceCalls).toEqual([["seed"], ["bb"]]);
    controller.dispose();
  });

  it("skips entirely when save_since yields no bytes beyond the committed basis", async () => {
    const controller = createController(
      { initialSavedHeadsHex: ["seed"] },
      { initialChunks: bigSnapshotInventory() },
    );

    headsHex = ["bb"];
    sinceBytes = new Uint8Array(0);
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(adapter.ops).toEqual([]);
    controller.dispose();
  });

  it("compacts when incrementals reach snapshot size: write-before-delete, known chunks only", async () => {
    const snapshotKey = notebookDocSnapshotChunkKey("nb-1", ["seed"]);
    const incrementalKey = notebookDocIncrementalChunkKey("nb-1", "f0f0");
    // Inventory: a 100-byte snapshot and a 100-byte incremental — the
    // sizes rule (incrementalSize >= snapshotSize) fires, but the
    // snapshot also sits above nothing: use sizes >= 1024 so ONLY the
    // ratio rule triggers.
    const inventory: NotebookDocChunkInfo[] = [
      { key: snapshotKey, size: 2048, kind: "snapshot" },
      { key: incrementalKey, size: 2048, kind: "incremental" },
    ];
    // A chunk some other tab wrote that this controller never loaded:
    const foreignKey = notebookDocIncrementalChunkKey("nb-1", "dead");
    adapter.records.set(joinKey(foreignKey), new Uint8Array([1]));
    adapter.records.set(joinKey(snapshotKey), new Uint8Array(2048));
    adapter.records.set(joinKey(incrementalKey), new Uint8Array(2048));

    const controller = createController(
      { initialSavedHeadsHex: ["seed"] },
      { initialChunks: inventory },
    );

    headsHex = ["bb"];
    saveBytes = new Uint8Array([5, 5, 5]);
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    const newSnapshotKey = notebookDocSnapshotChunkKey("nb-1", ["bb"]);
    expect(adapter.ops).toEqual([
      // The new snapshot (with meta) commits FIRST...
      { op: "saveBatch", keys: [newSnapshotKey, notebookDocChunkMetaKey("nb-1")] },
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
          { key: notebookDocSnapshotChunkKey("nb-1", ["seed"]), size: 10, kind: "snapshot" },
        ],
      },
    );

    headsHex = ["bb"];
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(adapter.ops[0]).toEqual({
      op: "saveBatch",
      keys: [notebookDocSnapshotChunkKey("nb-1", ["bb"]), notebookDocChunkMetaKey("nb-1")],
    });
    controller.dispose();
  });

  it("single-flight compaction: a capture racing an in-flight snapshot goes incremental", async () => {
    // Tiny seed snapshot → the first capture compacts.
    const controller = createController(
      { initialSavedHeadsHex: ["seed"] },
      {
        initialChunks: [
          { key: notebookDocSnapshotChunkKey("nb-1", ["seed"]), size: 10, kind: "snapshot" },
        ],
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
      notebookDocIncrementalChunkKey("nb-1", bytesHex(sinceBytes)),
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
    expect(adapter.records.has(joinKey(notebookDocSnapshotChunkKey("nb-1", ["aa"])))).toBe(true);
    controller.dispose();
  });

  it("keeps a chunk whose delete failed inventoried and retries at the next compaction", async () => {
    const staleKey = notebookDocIncrementalChunkKey("nb-1", "0101");
    adapter.records.set(joinKey(staleKey), new Uint8Array([1]));
    const controller = createController(
      { initialSavedHeadsHex: ["seed"] },
      {
        initialChunks: [
          { key: notebookDocSnapshotChunkKey("nb-1", ["seed"]), size: 10, kind: "snapshot" },
          { key: staleKey, size: 1, kind: "incremental" },
        ],
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
    const seed = {
      opts: { initialSavedHeadsHex: ["seed"] },
      chunked: { initialChunks: bigSnapshotInventory() },
    };
    const tabA = createController(seed.opts, seed.chunked);

    const changesB$ = new Subject<void>();
    const tabB = createController({ ...seed.opts, changes$: changesB$ }, seed.chunked);

    headsHex = ["bb"];
    sinceBytes = new Uint8Array([42, 42]);
    changes$.next();
    changesB$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    const expectedKey = notebookDocIncrementalChunkKey("nb-1", bytesHex(sinceBytes));
    const chunkRecords = [...adapter.records.keys()].filter((key) =>
      key.startsWith("nb-1/chunks/incremental/"),
    );
    expect(chunkRecords).toEqual([joinKey(expectedKey)]);
    tabA.dispose();
    tabB.dispose();
  });
});

describe("loadPersistedNotebookDocChunks", () => {
  const meta: NotebookDocPersistenceMeta = {
    headsHex: ["aa"],
    savedAt: 123,
    principal: "user:test:alice",
    schemaVersion: 1,
  };

  it("returns undefined when no data chunks exist", async () => {
    const adapter = createRecordingAdapter();
    expect(await loadPersistedNotebookDocChunks(adapter, "nb-1")).toBeUndefined();
    // A meta record alone is not a loadable store either.
    adapter.records.set(joinKey(notebookDocChunkMetaKey("nb-1")), encodeNotebookDocChunkMeta(meta));
    expect(await loadPersistedNotebookDocChunks(adapter, "nb-1")).toBeUndefined();
  });

  it("concatenates snapshots before incrementals and inventories the data chunks", async () => {
    const adapter = createRecordingAdapter();
    // Inserted in unsorted-on-kind order; the loader must reorder.
    adapter.records.set(
      joinKey(notebookDocIncrementalChunkKey("nb-1", "aaaa")),
      new Uint8Array([4, 5]),
    );
    adapter.records.set(
      joinKey(notebookDocSnapshotChunkKey("nb-1", ["h1"])),
      new Uint8Array([1, 2, 3]),
    );
    adapter.records.set(joinKey(notebookDocChunkMetaKey("nb-1")), encodeNotebookDocChunkMeta(meta));

    const loaded = await loadPersistedNotebookDocChunks(adapter, "nb-1");
    expect(loaded?.bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(loaded?.meta).toEqual(meta);
    expect(loaded?.chunks).toEqual([
      { key: notebookDocSnapshotChunkKey("nb-1", ["h1"]), size: 3, kind: "snapshot" },
      { key: notebookDocIncrementalChunkKey("nb-1", "aaaa"), size: 2, kind: "incremental" },
    ]);
  });

  it("degrades a corrupt meta record to null without dropping the bytes", async () => {
    const adapter = createRecordingAdapter();
    adapter.records.set(joinKey(notebookDocSnapshotChunkKey("nb-1", ["h1"])), new Uint8Array([1]));
    adapter.records.set(
      joinKey(notebookDocChunkMetaKey("nb-1")),
      new TextEncoder().encode("{not json"),
    );

    const loaded = await loadPersistedNotebookDocChunks(adapter, "nb-1");
    expect(loaded?.meta).toBeNull();
    expect(loaded?.bytes).toEqual(new Uint8Array([1]));
  });

  it("ignores records under unknown sub-keys (forward compatibility)", async () => {
    const adapter = createRecordingAdapter();
    adapter.records.set(joinKey(notebookDocSnapshotChunkKey("nb-1", ["h1"])), new Uint8Array([1]));
    adapter.records.set("nb-1/chunks/fragment/zzzz", new Uint8Array([9, 9]));
    adapter.records.set("nb-1/chunks/snapshot/extra/deep", new Uint8Array([9]));

    const loaded = await loadPersistedNotebookDocChunks(adapter, "nb-1");
    expect(loaded?.bytes).toEqual(new Uint8Array([1]));
    expect(loaded?.chunks).toHaveLength(1);
    // Read paths never delete what they do not understand.
    expect(adapter.records.has("nb-1/chunks/fragment/zzzz")).toBe(true);
  });
});

describe("clearPersistedNotebookDocChunks", () => {
  it("removes only the chunks range", async () => {
    const adapter = createRecordingAdapter();
    adapter.records.set("nb-1/snapshot", new Uint8Array([1]));
    adapter.records.set("nb-1/runtime-state-cache", new Uint8Array([2]));
    adapter.records.set(joinKey(notebookDocSnapshotChunkKey("nb-1", ["h1"])), new Uint8Array([3]));
    adapter.records.set(joinKey(notebookDocChunkMetaKey("nb-1")), new Uint8Array([4]));
    adapter.records.set("nb-2/chunks/meta", new Uint8Array([5]));

    await clearPersistedNotebookDocChunks(adapter, "nb-1");

    expect([...adapter.records.keys()].sort()).toEqual([
      "nb-1/runtime-state-cache",
      "nb-1/snapshot",
      "nb-2/chunks/meta",
    ]);
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
        principal: "user:test:alice",
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
        .filter((key) => key.startsWith("nb-wasm/chunks/") && !key.endsWith("/meta"))
        .map((key) => key.split("/")[2]);
      expect(kinds).toContain("snapshot");
      expect(kinds).toContain("incremental");

      const loaded = await loadPersistedNotebookDocChunks(adapter, "nb-wasm");
      expect(loaded?.meta?.principal).toBe("user:test:alice");
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
