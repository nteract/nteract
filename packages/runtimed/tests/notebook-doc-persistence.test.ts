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
import {
  saveBatch,
  type StorageAdapter,
  type StorageKey,
} from "../src/persistence/storage-adapter";

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

    // A second change (heads moved) while the first write is stuck queues
    // a second save.
    headsHex = ["bb"];
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

    // The sequential fallback wraps the failure with the entry's key and
    // index; the original error rides along as `cause`.
    expect(onError).toHaveBeenCalledTimes(1);
    const reported = onError.mock.calls[0]![0] as Error;
    expect(reported.cause).toBe(failure);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[notebook-persistence]"), reported);
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

  it("skips the save when heads are unchanged since the last save", async () => {
    // notebookDocChanged$ over-fires for protocol-only flushes; identical
    // heads mean identical doc state, so the snapshot would be a no-op.
    const getSaveBytes = vi.fn(() => saveBytes);
    const controller = createController({ getSaveBytes });

    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapter.saves).toHaveLength(1);

    // Same heads: the signal was protocol-only churn.
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapter.saves).toHaveLength(1);
    expect(getSaveBytes).toHaveBeenCalledTimes(1); // no doomed serialization either

    // Heads moved: a real doc change saves again.
    headsHex = ["bb"];
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapter.saves).toHaveLength(2);
    controller.dispose();
  });

  it("dedupes against in-flight writes, not just committed ones", async () => {
    const resolvers: Array<() => void> = [];
    adapter.save = vi.fn((key: StorageKey, data: Uint8Array) => {
      adapter.saves.push({ key, data });
      return new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
    });
    const controller = createController();

    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapter.saves).toHaveLength(1); // write one stuck in flight

    // A protocol-only signal while write one is still pending must not
    // queue an identical envelope behind it.
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    while (resolvers.length > 0) {
      resolvers.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(adapter.saves).toHaveLength(1);
    controller.dispose();
  });

  it("distinguishes heads sets, not just lengths or prefixes", async () => {
    const controller = createController();

    headsHex = ["aa", "bb"];
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    headsHex = ["aa"];
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(adapter.saves).toHaveLength(2);
    controller.dispose();
  });

  it("a failed save forgets its heads so the next signal retries", async () => {
    let failNext = true;
    adapter.save = vi.fn(async (key: StorageKey, data: Uint8Array) => {
      if (failNext) throw new Error("quota exceeded");
      adapter.saves.push({ key, data });
    });
    const controller = createController();

    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapter.saves).toHaveLength(0); // write failed

    // Same heads, but the failed write must not count as saved.
    failNext = false;
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapter.saves).toHaveLength(1);
    controller.dispose();
  });

  it("a failed write does not clobber a newer capture's recorded heads", async () => {
    // Write one (heads aa) fails AFTER write two (heads bb) was captured:
    // the failure must not reset the dedupe to null and reopen writes for
    // heads bb state that write two already covers.
    const outcomes: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
    adapter.save = vi.fn((key: StorageKey, data: Uint8Array) => {
      adapter.saves.push({ key, data });
      return new Promise<void>((resolve, reject) => {
        outcomes.push({ resolve, reject: (e) => reject(e) });
      });
    });
    const controller = createController();

    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000); // capture aa, write one in flight

    headsHex = ["bb"];
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000); // capture bb, queued behind one

    outcomes.shift()?.reject(new Error("disk full")); // write one fails late
    await vi.advanceTimersByTimeAsync(0);
    outcomes.shift()?.resolve(); // write two commits
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.saves).toHaveLength(2);

    // Protocol-only signal at heads bb: still deduped.
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapter.saves).toHaveLength(2);
    controller.dispose();
  });

  it("flushNow skips the write when heads are unchanged", async () => {
    const getSaveBytes = vi.fn(() => saveBytes);
    const controller = createController({ getSaveBytes });

    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapter.saves).toHaveLength(1);

    await controller.flushNow(); // pagehide with nothing new
    expect(adapter.saves).toHaveLength(1);
    expect(getSaveBytes).toHaveBeenCalledTimes(1);

    headsHex = ["bb"]; // committed edit inside the engine's flush debounce
    await controller.flushNow();
    expect(adapter.saves).toHaveLength(2);
    controller.dispose();
  });

  it("flushNow does not trust an in-flight write that then fails", async () => {
    // Teardown sequence: capture H1, write W1 in flight, flushNow() at H1.
    // If the flush deduped against the OPTIMISTIC key it would skip — and
    // when W1 then fails (errors are swallowed, handle freed) the H1 state,
    // possibly the only copy of offline edits, would never be persisted.
    // The flush must dedupe only against COMMITTED writes.
    const outcomes: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
    adapter.save = vi.fn((key: StorageKey, data: Uint8Array) => {
      return new Promise<void>((resolve, reject) => {
        outcomes.push({
          resolve: () => {
            adapter.saves.push({ key, data });
            resolve();
          },
          reject,
        });
      });
    });
    const controller = createController();

    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000); // capture H1, W1 in flight

    const flushed = controller.flushNow(); // H1 again — must NOT skip
    controller.dispose();

    outcomes.shift()?.reject(new Error("quota exceeded")); // W1 fails late
    await vi.advanceTimersByTimeAsync(0);
    outcomes.shift()?.resolve(); // the flush's write commits
    await flushed;

    expect(adapter.saves).toHaveLength(1);
    expect(decodePersistedNotebookDoc(adapter.saves[0]!.data).meta?.headsHex).toEqual(["aa"]);
  });

  it("flushNow dedupes against a write that has committed", async () => {
    const controller = createController();

    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000); // W1 committed
    expect(adapter.saves).toHaveLength(1);

    await controller.flushNow(); // same heads, durably saved — skip
    expect(adapter.saves).toHaveLength(1);
    controller.dispose();
  });

  it("initialSavedHeadsHex dedupes the first save against the seeded record", async () => {
    const getSaveBytes = vi.fn(() => saveBytes);
    const controller = createController({
      getSaveBytes,
      initialSavedHeadsHex: ["aa"],
    });

    // The handshake's protocol-only change signal at the seeded heads.
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapter.saves).toHaveLength(0);
    expect(getSaveBytes).not.toHaveBeenCalled();

    headsHex = ["bb"];
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapter.saves).toHaveLength(1);
    controller.dispose();
  });

  it("treats empty initialSavedHeadsHex as unknown, never an identity", async () => {
    // decodeMeta accepts headsHex: [] and a freshly-bootstrapped doc
    // (RuntimeStateDoc starts empty by design) also reports empty heads —
    // matching the two would skip the first save over a stale record.
    headsHex = [];
    const controller = createController({ initialSavedHeadsHex: [] });

    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(adapter.saves).toHaveLength(1);
    controller.dispose();
  });

  it("a deduped skip neither increments nor resets the failure counter", async () => {
    // Three consecutive failures self-dispose; a skip is not a save and
    // must count for nothing. Observed through the threshold: with the
    // counter at 2, a skip must not dispose (no increment) and the NEXT
    // failure must (no reset).
    const disposedMsg = "[notebook-persistence] disabled after repeated save failures";
    adapter.save = vi.fn(async () => {
      throw new Error("quota exceeded");
    });
    const warn = vi.fn();
    const controller = createController({
      logger: { warn },
      initialSavedHeadsHex: ["aa"], // committed key for the flush skip below
    });

    // Two failures bring the counter to 2.
    for (const head of ["h1", "h2"]) {
      headsHex = [head];
      changes$.next();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(warn).not.toHaveBeenCalledWith(disposedMsg);

    // A flush at the seeded (committed) heads skips. An incrementing skip
    // would hit 3 and dispose here.
    headsHex = ["aa"];
    await controller.flushNow();
    expect(warn).not.toHaveBeenCalledWith(disposedMsg);

    // The next failure must be the third — a resetting skip would leave
    // the counter at 1 and keep the controller alive.
    headsHex = ["h3"];
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(warn).toHaveBeenCalledWith(disposedMsg);
  });

  it("prefers the adapter's saveBatch over plain save when available", async () => {
    const batches: Array<Array<[StorageKey, Uint8Array]>> = [];
    adapter.saveBatch = vi.fn(async (entries: Array<[StorageKey, Uint8Array]>) => {
      batches.push(entries);
      for (const [key, data] of entries) {
        adapter.records.set(key.join("\u0000"), data);
      }
    });
    const controller = createController();

    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(adapter.save).not.toHaveBeenCalled();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map(([key]) => key)).toEqual([["nb-1", "snapshot"]]);
    controller.dispose();
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
    // consecutive, so persistence stays alive. Heads move on every change
    // so the dedupe never absorbs a capture.
    let head = 0;
    for (const fail of [true, true, false, true, true]) {
      failNext = fail;
      headsHex = [`head-${head++}`];
      changes$.next();
      await vi.advanceTimersByTimeAsync(1_000);
    }

    failNext = false;
    headsHex = [`head-${head++}`];
    changes$.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getSaveBytes).toHaveBeenCalledTimes(6);
    controller.dispose();
  });
});

describe("saveBatch helper", () => {
  it("falls back to sequential saves when the adapter lacks saveBatch", async () => {
    const adapter = createRecordingAdapter();

    await saveBatch(adapter, [
      [["nb-1", "a"], new Uint8Array([1])],
      [["nb-1", "b"], new Uint8Array([2])],
    ]);

    expect(adapter.saves.map((s) => s.key)).toEqual([
      ["nb-1", "a"],
      ["nb-1", "b"],
    ]);
  });

  it("preserves entry order in the sequential fallback", async () => {
    // Crash-ordering proper lives ACROSS batches (callers sequence
    // dependent record kinds as separate saveBatch calls; a native batch
    // is atomic, so within-batch order is moot there). The fallback is
    // per-entry, where order is the only structure left: keeping it means
    // a crash mid-fallback leaves a clean prefix, never an arbitrary
    // subset.
    const adapter = createRecordingAdapter();
    const order: string[] = [];
    let release: (() => void) | null = null;
    adapter.save = vi.fn(async (key: StorageKey) => {
      order.push(key.join("/"));
      if (!release) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });

    const done = saveBatch(adapter, [
      [["nb-1", "blob"], new Uint8Array([1])],
      [["nb-1", "marker"], new Uint8Array([2])],
    ]);
    await Promise.resolve();
    expect(order).toEqual(["nb-1/blob"]); // marker not started while blob pends
    release!();
    await done;
    expect(order).toEqual(["nb-1/blob", "nb-1/marker"]);
  });

  it("uses the adapter's saveBatch when present", async () => {
    const adapter = createRecordingAdapter();
    const entries: Array<[StorageKey, Uint8Array]> = [[["nb-1", "a"], new Uint8Array([1])]];
    adapter.saveBatch = vi.fn(async () => {});

    await saveBatch(adapter, entries);

    expect(adapter.saveBatch).toHaveBeenCalledWith(entries);
    expect(adapter.save).not.toHaveBeenCalled();
  });

  it("fallback failure names the failed entry and leaves a clean prefix", async () => {
    const adapter = createRecordingAdapter();
    const failure = new Error("disk full");
    let saves = 0;
    adapter.save = vi.fn(async (key: StorageKey, data: Uint8Array) => {
      if (++saves === 2) throw failure;
      adapter.records.set(key.join("/"), data);
    });

    const attempt = saveBatch(adapter, [
      [["nb-1", "a"], new Uint8Array([1])],
      [["nb-1", "b"], new Uint8Array([2])],
      [["nb-1", "c"], new Uint8Array([3])],
    ]);

    await expect(attempt).rejects.toMatchObject({
      name: "SaveBatchEntryError",
      key: ["nb-1", "b"],
      index: 1,
      cause: failure,
    });
    // Entries before the failure are durable; the failed entry and
    // everything after were never written.
    expect([...adapter.records.keys()]).toEqual(["nb-1/a"]);
    expect(adapter.save).toHaveBeenCalledTimes(2);
  });

  it("is a no-op for an empty batch", async () => {
    const adapter = createRecordingAdapter();
    adapter.saveBatch = vi.fn(async () => {});

    await saveBatch(adapter, []);

    expect(adapter.saveBatch).not.toHaveBeenCalled();
    expect(adapter.save).not.toHaveBeenCalled();
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
  it("removes the whole notebook prefix — seed AND render cache, neighbors untouched", async () => {
    // The poison-pill discard rides this: a discarded seed must not leave
    // its cached pixels behind to repaint rejected content on the next
    // load, and another notebook's records must survive.
    const adapter = createRecordingAdapter();
    await adapter.save(
      ["nb-1", "snapshot"],
      encodePersistedNotebookDoc(testMeta(), new Uint8Array([9])),
    );
    await adapter.save(
      ["nb-1", RUNTIME_STATE_CACHE_KEY_SEGMENT],
      encodePersistedNotebookDoc(testMeta(), new Uint8Array([10])),
    );
    await adapter.save(
      ["nb-2", "snapshot"],
      encodePersistedNotebookDoc(testMeta(), new Uint8Array([11])),
    );

    await clearPersistedNotebookDoc(adapter, "nb-1");

    expect(adapter.removeRange).toHaveBeenCalledWith(["nb-1"]);
    expect(await loadPersistedNotebookDoc(adapter, "nb-1")).toBeUndefined();
    expect(
      await loadPersistedNotebookRecord(adapter, "nb-1", RUNTIME_STATE_CACHE_KEY_SEGMENT),
    ).toBeUndefined();
    expect((await loadPersistedNotebookDoc(adapter, "nb-2"))?.bytes).toEqual(new Uint8Array([11]));
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
