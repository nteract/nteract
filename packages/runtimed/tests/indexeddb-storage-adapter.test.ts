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

  it("retries once on a stale connection when starting a transaction", async () => {
    const adapter = createAdapter();
    // Warm the connection so the stale-connection throw hits a cached db.
    await adapter.save(["nb-1", "snapshot"], new Uint8Array([1]));

    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementationOnce(() => {
      throw new DOMException("connection is closing", "InvalidStateError");
    });

    await adapter.save(["nb-1", "snapshot"], new Uint8Array([2]));
    expect(await adapter.load(["nb-1", "snapshot"])).toEqual(new Uint8Array([2]));
  });
});
