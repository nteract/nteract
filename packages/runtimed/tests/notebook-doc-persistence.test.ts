/**
 * NotebookDocPersistence controller tests with a mock StorageAdapter.
 *
 * Time-dependent behavior (the trailing-edge throttle) uses vi fake
 * timers; write serialization uses manually-resolved deferred saves.
 */

import { Subject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  NotebookDocPersistence,
  RUNTIME_STATE_CACHE_KEY_SEGMENT,
  clearPersistedNotebookDoc,
  clearPersistedNotebookRecord,
  decodePersistedNotebookDoc,
  encodePersistedNotebookDoc,
  loadPersistedNotebookDoc,
  loadPersistedNotebookRecord,
  type NotebookDocPersistenceMeta,
} from "../src/persistence/notebook-doc-persistence";
import type { StorageAdapter, StorageKey } from "../src/persistence/storage-adapter";

interface RecordingAdapter extends StorageAdapter {
  saves: Array<{ key: StorageKey; data: Uint8Array }>;
  records: Map<string, Uint8Array>;
}

function createRecordingAdapter(): RecordingAdapter {
  const records = new Map<string, Uint8Array>();
  const saves: RecordingAdapter["saves"] = [];
  return {
    records,
    saves,
    load: vi.fn(async (key: StorageKey) => records.get(key.join("\u0000"))),
    save: vi.fn(async (key: StorageKey, data: Uint8Array) => {
      saves.push({ key, data });
      records.set(key.join("\u0000"), data);
    }),
    remove: vi.fn(async (key: StorageKey) => {
      records.delete(key.join("\u0000"));
    }),
    loadRange: vi.fn(async () => []),
    removeRange: vi.fn(async (prefix: StorageKey) => {
      const rangePrefix = `${prefix.join("\u0000")}\u0000`;
      for (const key of [...records.keys()]) {
        if (key.startsWith(rangePrefix) || key === prefix.join("\u0000")) {
          records.delete(key);
        }
      }
    }),
  };
}

function testMeta(overrides: Partial<NotebookDocPersistenceMeta> = {}): NotebookDocPersistenceMeta {
  return {
    headsHex: ["aa"],
    savedAt: 123,
    principal: "user:test:alice",
    schemaVersion: 1,
    ...overrides,
  };
}

const silentLogger = { warn: () => {} };

describe("NotebookDocPersistence", () => {
  let adapter: RecordingAdapter;
  let changes$: Subject<void>;
  let saveBytes: Uint8Array;
  let headsHex: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    adapter = createRecordingAdapter();
    changes$ = new Subject<void>();
    saveBytes = new Uint8Array([1]);
    headsHex = ["aa"];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createController(
    overrides: Partial<ConstructorParameters<typeof NotebookDocPersistence>[0]> = {},
  ): NotebookDocPersistence {
    return new NotebookDocPersistence({
      adapter,
      notebookId: "nb-1",
      principal: "user:test:alice",
      changes$,
      getSaveBytes: () => saveBytes,
      getHeadsHex: () => headsHex,
      logger: silentLogger,
      ...overrides,
    });
  }

  it("batches rapid changes into one trailing-edge envelope save", async () => {
    const controller = createController();

    changes$.next();
    changes$.next();
    changes$.next();
    await vi.advanceTimersByTimeAsync(999);
    expect(adapter.saves).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.saves.map((s) => s.key)).toEqual([["nb-1", "snapshot"]]);
    controller.dispose();
  });

  it("captures the latest bytes at save time (latest wins)", async () => {
    const controller = createController();

    saveBytes = new Uint8Array([1]);
    changes$.next();
    saveBytes = new Uint8Array([2, 2]);
    changes$.next();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(decodePersistedNotebookDoc(adapter.saves[0]!.data).bytes).toEqual(
      new Uint8Array([2, 2]),
    );
    controller.dispose();
  });

  it("never runs two saves concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers: Array<() => void> = [];
    adapter.save = vi.fn((key: StorageKey, data: Uint8Array) => {
      adapter.saves.push({ key, data });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<void>((resolve) => {
        resolvers.push(() => {
          inFlight--;
          resolve();
        });
      });
    });
    const controller = createController();

    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapter.saves).toHaveLength(1); // first envelope write in flight

    // A second change while the first write is stuck queues a second save.
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapter.saves).toHaveLength(1); // still queued behind write one

    while (resolvers.length > 0) {
      resolvers.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
    }

    // One envelope per save cycle, strictly serialized.
    expect(adapter.saves).toHaveLength(2);
    expect(maxInFlight).toBe(1);
    controller.dispose();
  });

  it("flushNow commits immediately without waiting for the throttle", async () => {
    const controller = createController();

    changes$.next();
    expect(adapter.saves).toHaveLength(0);

    const flushed = controller.flushNow();
    await vi.advanceTimersByTimeAsync(0);
    await flushed;
    expect(adapter.saves.map((s) => s.key)).toEqual([["nb-1", "snapshot"]]);

    // The cancelled throttle timer must not produce a duplicate save.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(adapter.saves).toHaveLength(1);
    controller.dispose();
  });

  it("flushNow captures unconditionally, even without a change signal", async () => {
    // Local edits inside the engine's 20ms flush debounce have not emitted
    // yet at pagehide/teardown time — handle.save() still sees them, so
    // flushNow must not gate on the dirty flag.
    const controller = createController();
    saveBytes = new Uint8Array([7, 7]);

    await controller.flushNow();

    expect(adapter.saves.map((s) => s.key)).toEqual([["nb-1", "snapshot"]]);
    expect(decodePersistedNotebookDoc(adapter.saves[0]!.data).bytes).toEqual(
      new Uint8Array([7, 7]),
    );
    controller.dispose();
  });

  it("flushNow followed immediately by dispose still commits", async () => {
    // The production teardown runs flushNow(); dispose(); handle.free()
    // back to back — capture must be synchronous and dispose must not
    // cancel the already-chained write.
    const resolvers: Array<() => void> = [];
    adapter.save = vi.fn((key: StorageKey, data: Uint8Array) => {
      adapter.saves.push({ key, data });
      return new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
    });
    const controller = createController();

    changes$.next();
    const flushed = controller.flushNow();
    controller.dispose();

    // Capture already happened synchronously before dispose; the queued
    // write starts on the next microtask and must still commit.
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.saves).toHaveLength(1);
    resolvers.shift()?.();
    await flushed;
    expect(decodePersistedNotebookDoc(adapter.saves[0]!.data).bytes).toEqual(new Uint8Array([1]));
  });

  it("is a no-op after dispose", async () => {
    const getSaveBytes = vi.fn(() => saveBytes);
    const controller = createController({ getSaveBytes });

    changes$.next();
    controller.dispose();

    await vi.advanceTimersByTimeAsync(5_000);
    await controller.flushNow();
    changes$.next();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(getSaveBytes).not.toHaveBeenCalled();
    expect(adapter.saves).toHaveLength(0);
  });

  it("writes envelope meta with heads, principal, savedAt, and schemaVersion", async () => {
    vi.setSystemTime(1_750_000_000_000);
    headsHex = ["abc123", "def456"];
    const controller = createController();

    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(adapter.saves).toHaveLength(1);
    expect(decodePersistedNotebookDoc(adapter.saves[0]!.data).meta).toEqual({
      headsHex: ["abc123", "def456"],
      // The fake clock advanced by the 1s throttle before capture.
      savedAt: 1_750_000_001_000,
      principal: "user:test:alice",
      schemaVersion: 1,
    });
    controller.dispose();
  });

  it("writes the runtime-state render cache under its own record key", async () => {
    // The cache record shares the envelope codec end to end: a throttled
    // save under [id, "runtime-state-cache"] round-trips through the
    // segment-aware loader with meta intact and the snapshot key untouched.
    saveBytes = new Uint8Array([42, 43]);
    headsHex = ["state-head"];
    const controller = createController({ keySegment: RUNTIME_STATE_CACHE_KEY_SEGMENT });

    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(adapter.saves.map((s) => s.key)).toEqual([["nb-1", "runtime-state-cache"]]);
    const record = await loadPersistedNotebookRecord(
      adapter,
      "nb-1",
      RUNTIME_STATE_CACHE_KEY_SEGMENT,
    );
    expect(record?.bytes).toEqual(new Uint8Array([42, 43]));
    expect(record?.meta?.headsHex).toEqual(["state-head"]);
    expect(record?.meta?.principal).toBe("user:test:alice");
    expect(await loadPersistedNotebookDoc(adapter, "nb-1")).toBeUndefined();
    controller.dispose();
  });

  it("routes adapter save failures to onError without throwing", async () => {
    const onError = vi.fn();
    const failure = new Error("quota exceeded");
    adapter.save = vi.fn(async () => {
      throw failure;
    });
    const warn = vi.fn();
    const controller = createController({ onError, logger: { warn } });

    changes$.next();
    await controller.flushNow();

    expect(onError).toHaveBeenCalledWith(failure);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[notebook-persistence]"), failure);
    controller.dispose();
  });

  it("routes getSaveBytes failures to onError and skips the write", async () => {
    const onError = vi.fn();
    const failure = new Error("handle freed");
    const controller = createController({
      onError,
      getSaveBytes: () => {
        throw failure;
      },
    });

    changes$.next();
    await controller.flushNow();

    expect(onError).toHaveBeenCalledWith(failure);
    expect(adapter.saves).toHaveLength(0);
    controller.dispose();
  });

  it("self-disposes after three consecutive save failures", async () => {
    const getSaveBytes = vi.fn(() => saveBytes);
    adapter.save = vi.fn(async () => {
      throw new Error("quota exceeded");
    });
    const warn = vi.fn();
    const controller = createController({ getSaveBytes, logger: { warn } });

    for (let i = 0; i < 3; i++) {
      changes$.next();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(getSaveBytes).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      "[notebook-persistence] disabled after repeated save failures",
    );

    // Disabled: further changes and flushNow capture nothing.
    changes$.next();
    await vi.advanceTimersByTimeAsync(5_000);
    await controller.flushNow();
    expect(getSaveBytes).toHaveBeenCalledTimes(3);
  });

  it("a successful save resets the consecutive-failure count", async () => {
    const getSaveBytes = vi.fn(() => saveBytes);
    let failNext = true;
    adapter.save = vi.fn(async (key: StorageKey, data: Uint8Array) => {
      if (failNext) throw new Error("quota exceeded");
      adapter.saves.push({ key, data });
    });
    const controller = createController({ getSaveBytes });

    // Two failures, then a success, then two more failures: never three
    // consecutive, so persistence stays alive.
    for (const fail of [true, true, false, true, true]) {
      failNext = fail;
      changes$.next();
      await vi.advanceTimersByTimeAsync(1_000);
    }

    failNext = false;
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getSaveBytes).toHaveBeenCalledTimes(6);
    controller.dispose();
  });
});

describe("persisted envelope codec", () => {
  it("round-trips meta and bytes through one record", () => {
    const meta = testMeta();
    const bytes = new Uint8Array([9, 8, 7]);

    expect(decodePersistedNotebookDoc(encodePersistedNotebookDoc(meta, bytes))).toEqual({
      bytes,
      meta,
    });
  });

  it("decodes corrupt meta JSON as meta: null while preserving bytes", () => {
    const metaBytes = new TextEncoder().encode("{nope");
    const envelope = new Uint8Array(4 + metaBytes.byteLength + 2);
    new DataView(envelope.buffer).setUint32(0, metaBytes.byteLength, true);
    envelope.set(metaBytes, 4);
    envelope.set([9, 9], 4 + metaBytes.byteLength);

    expect(decodePersistedNotebookDoc(envelope)).toEqual({
      bytes: new Uint8Array([9, 9]),
      meta: null,
    });
  });

  it.each([
    ["wrong schema version", JSON.stringify({ ...testMeta(), schemaVersion: 2 })],
    ["missing principal", JSON.stringify({ headsHex: [], savedAt: 1, schemaVersion: 1 })],
  ])("decodes invalid meta (%s) as meta: null", (_label, metaJson) => {
    const metaBytes = new TextEncoder().encode(metaJson);
    const envelope = new Uint8Array(4 + metaBytes.byteLength + 1);
    new DataView(envelope.buffer).setUint32(0, metaBytes.byteLength, true);
    envelope.set(metaBytes, 4);
    envelope.set([9], 4 + metaBytes.byteLength);

    expect(decodePersistedNotebookDoc(envelope).meta).toBeNull();
    expect(decodePersistedNotebookDoc(envelope).bytes).toEqual(new Uint8Array([9]));
  });

  it("treats a truncated record (meta length past the end) as unverifiable", () => {
    const intact = encodePersistedNotebookDoc(testMeta(), new Uint8Array([1, 2, 3]));
    const torn = intact.slice(0, intact.byteLength - 4);

    expect(decodePersistedNotebookDoc(torn)).toEqual({ meta: null });
  });

  it("cannot detect a tear inside the doc bytes — NotebookHandle.load() is the backstop", () => {
    const intact = encodePersistedNotebookDoc(testMeta(), new Uint8Array([1, 2, 3]));
    const decoded = decodePersistedNotebookDoc(intact.slice(0, intact.byteLength - 1));

    // Meta still parses; the shortened bytes fail NotebookHandle.load() at
    // seed time, which clears the record and bootstraps.
    expect(decoded.meta).toEqual(testMeta());
    expect(decoded.bytes).toEqual(new Uint8Array([1, 2]));
  });

  it("treats records shorter than the length prefix as unverifiable", () => {
    expect(decodePersistedNotebookDoc(new Uint8Array([1, 2]))).toEqual({ meta: null });
    expect(decodePersistedNotebookDoc(new Uint8Array(0))).toEqual({ meta: null });
  });

  it("treats an envelope with zero doc bytes as unverifiable", () => {
    const metaBytes = new TextEncoder().encode(JSON.stringify(testMeta()));
    const envelope = new Uint8Array(4 + metaBytes.byteLength);
    new DataView(envelope.buffer).setUint32(0, metaBytes.byteLength, true);
    envelope.set(metaBytes, 4);

    expect(decodePersistedNotebookDoc(envelope)).toEqual({ meta: null });
  });
});

describe("loadPersistedNotebookDoc", () => {
  it("returns undefined when no record exists", async () => {
    const adapter = createRecordingAdapter();
    expect(await loadPersistedNotebookDoc(adapter, "nb-1")).toBeUndefined();
  });

  it("returns bytes with parsed meta from the envelope", async () => {
    const adapter = createRecordingAdapter();
    const meta = testMeta();
    await adapter.save(["nb-1", "snapshot"], encodePersistedNotebookDoc(meta, new Uint8Array([9])));

    expect(await loadPersistedNotebookDoc(adapter, "nb-1")).toEqual({
      bytes: new Uint8Array([9]),
      meta,
    });
  });

  it("returns meta: null for a torn record", async () => {
    const adapter = createRecordingAdapter();
    const intact = encodePersistedNotebookDoc(testMeta(), new Uint8Array([9, 9, 9]));
    // Cut into the meta region so the length prefix points past the end.
    await adapter.save(["nb-1", "snapshot"], intact.slice(0, 10));

    expect(await loadPersistedNotebookDoc(adapter, "nb-1")).toEqual({ meta: null });
  });
});

describe("clearPersistedNotebookDoc", () => {
  it("removes the whole notebook prefix", async () => {
    const adapter = createRecordingAdapter();
    await adapter.save(
      ["nb-1", "snapshot"],
      encodePersistedNotebookDoc(testMeta(), new Uint8Array([9])),
    );

    await clearPersistedNotebookDoc(adapter, "nb-1");

    expect(adapter.removeRange).toHaveBeenCalledWith(["nb-1"]);
    expect(await loadPersistedNotebookDoc(adapter, "nb-1")).toBeUndefined();
  });
});

describe("clearPersistedNotebookRecord", () => {
  it("removes only the targeted record — the snapshot seed survives", async () => {
    const adapter = createRecordingAdapter();
    await adapter.save(
      ["nb-1", "snapshot"],
      encodePersistedNotebookDoc(testMeta(), new Uint8Array([9])),
    );
    await adapter.save(
      ["nb-1", RUNTIME_STATE_CACHE_KEY_SEGMENT],
      encodePersistedNotebookDoc(testMeta(), new Uint8Array([10])),
    );

    await clearPersistedNotebookRecord(adapter, "nb-1", RUNTIME_STATE_CACHE_KEY_SEGMENT);

    expect(
      await loadPersistedNotebookRecord(adapter, "nb-1", RUNTIME_STATE_CACHE_KEY_SEGMENT),
    ).toBeUndefined();
    expect((await loadPersistedNotebookDoc(adapter, "nb-1"))?.bytes).toEqual(new Uint8Array([9]));
  });
});
