/**
 * createCloudNotebookPersistence — the per-runtime controller pair: the
 * NotebookDoc seed record plus the render-only RuntimeStateDoc paint
 * cache. The cache is written from `save_state_doc()` under its own key
 * and never touches the seed record's key (a paint source, not a seed).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Subject } from "rxjs";
import {
  RUNTIME_STATE_CACHE_KEY_SEGMENT,
  decodePersistedNotebookDoc,
  type StorageAdapter,
  type StorageKey,
} from "runtimed";
import { createCloudNotebookPersistence } from "../viewer/notebook-persistence.ts";

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
    loadRange: async () => [],
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

  it("writes the seed record from notebookDocChanged$ without touching the cache", async () => {
    const harness = createHarness();
    const controller = harness.arm();
    assert.ok(controller);

    harness.notebookDocChanged$.next();
    await sleep(30);

    assert.deepEqual([...harness.adapter.records.keys()], ["nb-1/snapshot"]);
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
    harness.handle.save_state_doc = () => {
      throw new Error("handle freed");
    };
    await flush;

    assert.deepEqual([...harness.adapter.records.keys()].sort(), [
      "nb-1/runtime-state-cache",
      "nb-1/snapshot",
    ]);
    controller.dispose();
  });
});
