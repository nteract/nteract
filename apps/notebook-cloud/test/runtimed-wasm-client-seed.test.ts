/**
 * loadNotebookHandleFromBytes against a stub WASM module.
 *
 * The persisted-seed resolution tests in live-sync.test.ts inject mock
 * loadFromBytes functions; this file covers the real binding wired in
 * production — load() + mandatory set_actor() + free-on-error — which
 * carries the "never reuse an actor label across doc instances" invariant.
 *
 * Runs in its own file: the runtimed-wasm-client module caches the loaded
 * module singleton per process, so these tests must not share a process
 * with anything that initializes the real WASM module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadNotebookHandleFromBytes,
  loadRenderSnapshotHandle,
} from "../viewer/runtimed-wasm-client.ts";
import { stubCalls, type StubNotebookHandle } from "./fixtures/stub-runtimed-wasm-module.mts";

const STUB_MODULE_URL = new URL("./fixtures/stub-runtimed-wasm-module.mts", import.meta.url);

describe("loadNotebookHandleFromBytes", () => {
  it("loads the bytes and sets the connection actor before returning", async () => {
    const handle = (await loadNotebookHandleFromBytes(
      new Uint8Array([1, 2, 3]),
      "user:dev:alice/browser:fresh-session",
      STUB_MODULE_URL,
      STUB_MODULE_URL,
    )) as unknown as StubNotebookHandle;

    assert.deepEqual(handle.loadedBytes, new Uint8Array([1, 2, 3]));
    assert.deepEqual(handle.actors, ["user:dev:alice/browser:fresh-session"]);
    assert.equal(handle.freed, 0);
  });

  it("frees the handle and rethrows when set_actor fails", async () => {
    stubCalls.freedHandles.length = 0;

    await assert.rejects(
      loadNotebookHandleFromBytes(
        new Uint8Array([4, 5]),
        "throw:bad-actor",
        STUB_MODULE_URL,
        STUB_MODULE_URL,
      ),
      /synthetic set_actor failure/,
    );

    assert.equal(stubCalls.freedHandles.length, 1);
    assert.equal(stubCalls.freedHandles[0].freed, 1);
  });
});

describe("loadRenderSnapshotHandle", () => {
  it("loads the notebook/runtime-state pair without ever setting an actor", async () => {
    const handle = (await loadRenderSnapshotHandle(
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
      STUB_MODULE_URL,
      STUB_MODULE_URL,
    )) as unknown as StubNotebookHandle;

    assert.deepEqual(handle.loadedBytes, new Uint8Array([1, 2]));
    assert.deepEqual(handle.loadedRuntimeStateBytes, new Uint8Array([3, 4]));
    // Render-only: painting needs no actor, and the handle must never
    // author or sync.
    assert.deepEqual(handle.actors, []);
  });

  it("degrades to a cells-only load when no runtime-state cache bytes exist", async () => {
    const handle = (await loadRenderSnapshotHandle(
      new Uint8Array([5]),
      undefined,
      STUB_MODULE_URL,
      STUB_MODULE_URL,
    )) as unknown as StubNotebookHandle;

    assert.deepEqual(handle.loadedBytes, new Uint8Array([5]));
    assert.equal(handle.loadedRuntimeStateBytes, null);
    assert.deepEqual(handle.actors, []);
  });
});
