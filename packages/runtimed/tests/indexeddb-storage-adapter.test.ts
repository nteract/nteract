/**
 * IndexedDbStorageAdapter tests against fake-indexeddb.
 *
 * Each test gets an isolated IDBFactory so databases never leak between
 * tests; `fake-indexeddb/auto` installs the IDB* globals (IDBKeyRange,
 * IDBObjectStore, ...) the adapter relies on at runtime.
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { IndexedDbStorageAdapter } from "../src/persistence/indexeddb-storage-adapter";

function createAdapter(
  options: { onError?: (error: unknown) => void } = {},
): IndexedDbStorageAdapter {
  const adapter = IndexedDbStorageAdapter.create({ indexedDB: new IDBFactory(), ...options });
  if (!adapter) throw new Error("expected adapter for injected factory");
  return adapter;
}

describe("IndexedDbStorageAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("round-trips bytes under array keys", async () => {
    const adapter = createAdapter();
    const bytes = new Uint8Array([1, 2, 3, 255]);

    await adapter.save(["nb-1", "snapshot"], bytes);
    const loaded = await adapter.load(["nb-1", "snapshot"]);

    expect(loaded).toEqual(bytes);
  });

  it("returns undefined for missing keys", async () => {
    const adapter = createAdapter();
    expect(await adapter.load(["nb-1", "snapshot"])).toBeUndefined();
  });

  it("overwrites an existing record at the same key", async () => {
    const adapter = createAdapter();
    await adapter.save(["nb-1", "snapshot"], new Uint8Array([1]));
    await adapter.save(["nb-1", "snapshot"], new Uint8Array([2, 3]));

    expect(await adapter.load(["nb-1", "snapshot"])).toEqual(new Uint8Array([2, 3]));
  });

  it("remove deletes a single record", async () => {
    const adapter = createAdapter();
    await adapter.save(["nb-1", "snapshot"], new Uint8Array([1]));
    await adapter.save(["nb-1", "meta"], new Uint8Array([2]));

    await adapter.remove(["nb-1", "snapshot"]);

    expect(await adapter.load(["nb-1", "snapshot"])).toBeUndefined();
    expect(await adapter.load(["nb-1", "meta"])).toEqual(new Uint8Array([2]));
  });

  it("loadRange returns only chunks under the prefix", async () => {
    const adapter = createAdapter();
    await adapter.save(["nb-1", "snapshot"], new Uint8Array([1]));
    await adapter.save(["nb-1", "meta"], new Uint8Array([2]));
    await adapter.save(["nb-2", "snapshot"], new Uint8Array([3]));

    const chunks = await adapter.loadRange(["nb-1"]);

    expect(chunks).toEqual([
      { key: ["nb-1", "meta"], data: new Uint8Array([2]) },
      { key: ["nb-1", "snapshot"], data: new Uint8Array([1]) },
    ]);
  });

  it("prefix ranges are segment-exact, not string-prefix (nb-1 vs nb-10)", async () => {
    // The classic string-prefix bug the array-key IDBKeyRange.bound design
    // exists to avoid: "nb-10" starts with "nb-1" as a string but is a
    // different key segment.
    const adapter = createAdapter();
    await adapter.save(["nb-1", "snapshot"], new Uint8Array([1]));
    await adapter.save(["nb-10", "snapshot"], new Uint8Array([10]));

    expect(await adapter.loadRange(["nb-1"])).toEqual([
      { key: ["nb-1", "snapshot"], data: new Uint8Array([1]) },
    ]);

    await adapter.removeRange(["nb-1"]);
    expect(await adapter.load(["nb-1", "snapshot"])).toBeUndefined();
    expect(await adapter.load(["nb-10", "snapshot"])).toEqual(new Uint8Array([10]));
  });

  it("loadRange of an empty prefix range returns no chunks", async () => {
    const adapter = createAdapter();
    await adapter.save(["nb-2", "snapshot"], new Uint8Array([3]));

    expect(await adapter.loadRange(["nb-1"])).toEqual([]);
  });

  it("removeRange removes only records under the prefix", async () => {
    const adapter = createAdapter();
    await adapter.save(["nb-1", "snapshot"], new Uint8Array([1]));
    await adapter.save(["nb-1", "meta"], new Uint8Array([2]));
    await adapter.save(["nb-2", "snapshot"], new Uint8Array([3]));

    await adapter.removeRange(["nb-1"]);

    expect(await adapter.loadRange(["nb-1"])).toEqual([]);
    expect(await adapter.load(["nb-2", "snapshot"])).toEqual(new Uint8Array([3]));
  });

  it("saveBatch commits all entries in one transaction", async () => {
    const adapter = createAdapter();

    await adapter.saveBatch([
      [["nb-1", "snapshot"], new Uint8Array([1])],
      [["nb-1", "meta"], new Uint8Array([2])],
    ]);

    expect(await adapter.load(["nb-1", "snapshot"])).toEqual(new Uint8Array([1]));
    expect(await adapter.load(["nb-1", "meta"])).toEqual(new Uint8Array([2]));
  });

  it("saveBatch of no entries resolves without opening a transaction", async () => {
    const factory = new IDBFactory();
    const opens = vi.spyOn(factory, "open");
    const adapter = IndexedDbStorageAdapter.create({ indexedDB: factory });
    if (!adapter) throw new Error("expected adapter for injected factory");

    await adapter.saveBatch([]);

    expect(opens).not.toHaveBeenCalled();
  });

  it("saveBatch is all-or-nothing when a put fails mid-batch", async () => {
    const onError = vi.fn();
    const adapter = createAdapter({ onError });
    const quotaError = new DOMException("quota exceeded", "QuotaExceededError");
    const realPut = IDBObjectStore.prototype.put;
    let puts = 0;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<typeof realPut>
    ) {
      puts += 1;
      if (puts === 2) throw quotaError;
      return realPut.apply(this, args);
    });

    await expect(
      adapter.saveBatch([
        [["nb-1", "snapshot"], new Uint8Array([1])],
        [["nb-1", "meta"], new Uint8Array([2])],
      ]),
    ).rejects.toBe(quotaError);
    expect(onError).toHaveBeenCalledWith(quotaError);

    // The first entry's put was issued on the same aborted transaction, so
    // nothing from the batch is observable.
    vi.restoreAllMocks();
    expect(await adapter.load(["nb-1", "snapshot"])).toBeUndefined();
    expect(await adapter.load(["nb-1", "meta"])).toBeUndefined();
  });

  it("create returns null when indexedDB is unavailable", () => {
    vi.stubGlobal("indexedDB", undefined);
    expect(IndexedDbStorageAdapter.create()).toBeNull();
  });

  it("create uses the global indexedDB when available", () => {
    expect(IndexedDbStorageAdapter.create()).not.toBeNull();
  });

  it("surfaces write failures through rejection and onError", async () => {
    const onError = vi.fn();
    const adapter = createAdapter({ onError });
    const quotaError = new DOMException("quota exceeded", "QuotaExceededError");
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw quotaError;
    });

    await expect(adapter.save(["nb-1", "snapshot"], new Uint8Array([1]))).rejects.toBe(quotaError);
    expect(onError).toHaveBeenCalledWith(quotaError);
  });

  it("retries on a fresh connection when the cached one is stale", async () => {
    const factory = new IDBFactory();
    const opens = vi.spyOn(factory, "open");
    const adapter = IndexedDbStorageAdapter.create({ indexedDB: factory });
    if (!adapter) throw new Error("expected adapter for injected factory");
    // Warm the connection so the stale-connection throw hits a cached db.
    await adapter.save(["nb-1", "snapshot"], new Uint8Array([1]));
    expect(opens).toHaveBeenCalledTimes(1);

    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementationOnce(() => {
      throw new DOMException("connection is closing", "InvalidStateError");
    });

    await adapter.save(["nb-1", "snapshot"], new Uint8Array([2]));
    // The load-bearing hardening: the stale connection was dropped and the
    // retry REOPENED rather than reusing the cached db.
    expect(opens).toHaveBeenCalledTimes(2);
    expect(await adapter.load(["nb-1", "snapshot"])).toEqual(new Uint8Array([2]));
  });

  it("recovers after a synchronous open failure instead of caching the rejection", async () => {
    const factory = new IDBFactory();
    const failure = new DOMException("storage disabled", "SecurityError");
    vi.spyOn(factory, "open").mockImplementationOnce(() => {
      throw failure;
    });
    const onError = vi.fn();
    const adapter = IndexedDbStorageAdapter.create({ indexedDB: factory, onError });
    if (!adapter) throw new Error("expected adapter for injected factory");

    await expect(adapter.save(["nb-1", "snapshot"], new Uint8Array([1]))).rejects.toBe(failure);
    expect(onError).toHaveBeenCalledWith(failure);

    // The rejected open must not stay cached: the next operation reopens.
    await adapter.save(["nb-1", "snapshot"], new Uint8Array([2]));
    expect(await adapter.load(["nb-1", "snapshot"])).toEqual(new Uint8Array([2]));
  });

  it("close() drops the connection and later operations reopen", async () => {
    const factory = new IDBFactory();
    const opens = vi.spyOn(factory, "open");
    const adapter = IndexedDbStorageAdapter.create({ indexedDB: factory });
    if (!adapter) throw new Error("expected adapter for injected factory");

    adapter.close(); // close before any op is a no-op
    await adapter.save(["nb-1", "snapshot"], new Uint8Array([1]));
    expect(opens).toHaveBeenCalledTimes(1);

    adapter.close();
    expect(await adapter.load(["nb-1", "snapshot"])).toEqual(new Uint8Array([1]));
    expect(opens).toHaveBeenCalledTimes(2);
  });
});
