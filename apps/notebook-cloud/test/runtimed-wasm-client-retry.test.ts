/**
 * Retry/caching behavior of the runtimed WASM client.
 *
 * Three layers under test:
 *  1. Cached-rejection recovery — the dynamic import() promise is cached
 *     for the life of the page; a failed connect attempt must clear it so
 *     the next attempt (retryLiveConnection) really re-imports instead of
 *     re-awaiting a pinned rejection.
 *  2. The retry ladder ([150, 500, 1500] ms) for both the module import
 *     and the .wasm binary fetch — thrown fetch errors and 404/409/425/
 *     429/5xx statuses retry (404 deliberately, for deploy propagation);
 *     other statuses bail immediately.
 *  3. The hashed→stable filename fallback — runtimed_wasm.<hash>.js /
 *     runtimed_wasm_bg.<hash>.wasm fall back to their stable-name copies
 *     after the ladder exhausts, absorbing deploy-window skew.
 *
 * Runs in its own file: the runtimed-wasm-client module caches the loaded
 * module singleton per process, so these tests must not share a process
 * with anything that initializes the real WASM module.
 */

import { afterEach, beforeEach, describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  _resetRuntimedWasmClientForTests,
  _setRuntimedWasmFetchForTests,
  _setRuntimedWasmModuleImporterForTests,
  initializeRuntimedWasmClient,
} from "../viewer/runtimed-wasm-client.ts";

const HASHED_MODULE = "/assets/runtimed_wasm.0123456789abcdef.js";
const STABLE_MODULE = "/assets/runtimed_wasm.js";
const HASHED_WASM = "/assets/runtimed_wasm_bg.fedcba9876543210.wasm";
const STABLE_WASM = "/assets/runtimed_wasm_bg.wasm";

function stubModule(initCalls: unknown[] = []) {
  return {
    default: async (options: { module_or_path: unknown }) => {
      initCalls.push(options.module_or_path);
    },
    project_markdown_json: () => null,
  };
}

function okFetch(): { calls: string[]; fetch: typeof fetch } {
  const calls: string[] = [];
  return {
    calls,
    fetch: (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("wasm-bytes");
    }) as typeof fetch,
  };
}

/** Settle the promise chains between mocked-timer ticks. */
async function drain(): Promise<void> {
  for (let i = 0; i < 25; i += 1) {
    await Promise.resolve();
  }
}

function trackSettled<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let isSettled = false;
  const tracked = promise.finally(() => {
    isSettled = true;
  });
  // The caller asserts/awaits `tracked`; rejections are observed there.
  return { promise: tracked, settled: () => isSettled };
}

describe("runtimed WASM client retry ladder", () => {
  beforeEach(() => {
    _resetRuntimedWasmClientForTests();
  });

  afterEach(() => {
    _setRuntimedWasmModuleImporterForTests(null);
    _setRuntimedWasmFetchForTests(null);
    _resetRuntimedWasmClientForTests();
  });

  it("retries the module import on the exact ladder delays", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const importedHrefs: string[] = [];
    let failuresRemaining = 2;
    _setRuntimedWasmModuleImporterForTests(async (href) => {
      importedHrefs.push(href);
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new TypeError("Failed to fetch dynamically imported module");
      }
      return stubModule();
    });
    const wasmFetch = okFetch();
    _setRuntimedWasmFetchForTests(wasmFetch.fetch);

    const pending = initializeRuntimedWasmClient(STABLE_MODULE, STABLE_WASM);
    await drain();
    assert.equal(importedHrefs.length, 1);

    // First rung is exactly 150ms.
    t.mock.timers.tick(149);
    await drain();
    assert.equal(importedHrefs.length, 1);
    t.mock.timers.tick(1);
    await drain();
    assert.equal(importedHrefs.length, 2);

    // Second rung is exactly 500ms.
    t.mock.timers.tick(499);
    await drain();
    assert.equal(importedHrefs.length, 2);
    t.mock.timers.tick(1);
    await drain();
    assert.equal(importedHrefs.length, 3);

    const module = await pending;
    assert.equal(typeof module.project_markdown_json, "function");
    assert.deepEqual(importedHrefs, [STABLE_MODULE, STABLE_MODULE, STABLE_MODULE]);
    assert.deepEqual(wasmFetch.calls, [STABLE_WASM]);
  });

  it("falls back from the hashed module name to the stable copy after the ladder exhausts", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const importedHrefs: string[] = [];
    _setRuntimedWasmModuleImporterForTests(async (href) => {
      importedHrefs.push(href);
      if (href === HASHED_MODULE) {
        throw new TypeError("Failed to fetch dynamically imported module");
      }
      return stubModule();
    });
    const wasmFetch = okFetch();
    _setRuntimedWasmFetchForTests(wasmFetch.fetch);

    const pending = initializeRuntimedWasmClient(HASHED_MODULE, STABLE_WASM);
    for (const delay of [150, 500, 1500]) {
      await drain();
      t.mock.timers.tick(delay);
    }
    await pending;

    assert.deepEqual(importedHrefs, [
      HASHED_MODULE,
      HASHED_MODULE,
      HASHED_MODULE,
      HASHED_MODULE,
      STABLE_MODULE,
    ]);
  });

  it("has no fallback for stable module names: the failure is terminal", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const importedHrefs: string[] = [];
    _setRuntimedWasmModuleImporterForTests(async (href) => {
      importedHrefs.push(href);
      throw new TypeError("Failed to fetch dynamically imported module");
    });
    _setRuntimedWasmFetchForTests(okFetch().fetch);

    const { promise, settled } = trackSettled(
      initializeRuntimedWasmClient(STABLE_MODULE, STABLE_WASM),
    );
    for (const delay of [150, 500, 1500]) {
      await drain();
      t.mock.timers.tick(delay);
    }
    await drain();
    // Exactly one ladder; no further timers pending, the rejection is final.
    assert.equal(settled(), true);
    await assert.rejects(promise, /Failed to fetch dynamically imported module/);
    assert.equal(importedHrefs.length, 4);
    assert.ok(importedHrefs.every((href) => href === STABLE_MODULE));
  });

  it("retries the wasm binary on retryable statuses and resolves with the good response", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const initCalls: unknown[] = [];
    _setRuntimedWasmModuleImporterForTests(async () => stubModule(initCalls));
    const statuses = [404, 503, 429];
    const fetchedHrefs: string[] = [];
    _setRuntimedWasmFetchForTests((async (input: RequestInfo | URL) => {
      fetchedHrefs.push(String(input));
      const status = statuses.shift();
      return status === undefined ? new Response("wasm-bytes") : new Response("nope", { status });
    }) as typeof fetch);

    const pending = initializeRuntimedWasmClient(STABLE_MODULE, STABLE_WASM);
    for (const delay of [150, 500, 1500]) {
      await drain();
      t.mock.timers.tick(delay);
    }
    await pending;

    assert.equal(fetchedHrefs.length, 4);
    assert.ok(fetchedHrefs.every((href) => href === STABLE_WASM));
    assert.equal(initCalls.length, 1);
    assert.ok(initCalls[0] instanceof Response);
    assert.equal(await (initCalls[0] as Response).text(), "wasm-bytes");
  });

  it("bails immediately on non-retryable wasm statuses (still trying the stable copy once)", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    _setRuntimedWasmModuleImporterForTests(async () => stubModule());
    const fetchedHrefs: string[] = [];
    _setRuntimedWasmFetchForTests((async (input: RequestInfo | URL) => {
      fetchedHrefs.push(String(input));
      return new Response("forbidden", { status: 403 });
    }) as typeof fetch);

    const { promise, settled } = trackSettled(
      initializeRuntimedWasmClient(STABLE_MODULE, HASHED_WASM),
    );
    await drain();
    // 403 is not in the retryable set: no ladder sleeps for either name.
    assert.equal(settled(), true);
    await assert.rejects(promise, /Failed to fetch runtimed WASM \(403\)/);
    assert.deepEqual(fetchedHrefs, [HASHED_WASM, STABLE_WASM]);
  });

  it("falls back from the hashed wasm name to the stable copy after the ladder exhausts", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const initCalls: unknown[] = [];
    _setRuntimedWasmModuleImporterForTests(async () => stubModule(initCalls));
    const fetchedHrefs: string[] = [];
    _setRuntimedWasmFetchForTests((async (input: RequestInfo | URL) => {
      const href = String(input);
      fetchedHrefs.push(href);
      return href === HASHED_WASM
        ? new Response("gone", { status: 404 })
        : new Response("wasm-bytes");
    }) as typeof fetch);

    const pending = initializeRuntimedWasmClient(STABLE_MODULE, HASHED_WASM);
    for (const delay of [150, 500, 1500]) {
      await drain();
      t.mock.timers.tick(delay);
    }
    await pending;

    assert.deepEqual(fetchedHrefs, [
      HASHED_WASM,
      HASHED_WASM,
      HASHED_WASM,
      HASHED_WASM,
      STABLE_WASM,
    ]);
    assert.ok(initCalls[0] instanceof Response);
  });

  it("passes non-URL wasm inputs through to wasm-bindgen untouched", async () => {
    const initCalls: unknown[] = [];
    _setRuntimedWasmModuleImporterForTests(async () => stubModule(initCalls));
    const wasmFetch = okFetch();
    _setRuntimedWasmFetchForTests(wasmFetch.fetch);

    const bytes = new ArrayBuffer(8);
    await initializeRuntimedWasmClient(STABLE_MODULE, bytes);

    assert.deepEqual(wasmFetch.calls, []);
    assert.equal(initCalls[0], bytes);
  });

  it("clears the cached import after a fully failed attempt so a retry can succeed", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const importedHrefs: string[] = [];
    let healed = false;
    _setRuntimedWasmModuleImporterForTests(async (href) => {
      importedHrefs.push(href);
      if (!healed) {
        throw new TypeError("Failed to fetch dynamically imported module");
      }
      return stubModule();
    });
    _setRuntimedWasmFetchForTests(okFetch().fetch);

    const firstAttempt = initializeRuntimedWasmClient(STABLE_MODULE, STABLE_WASM);
    for (const delay of [150, 500, 1500]) {
      await drain();
      t.mock.timers.tick(delay);
    }
    await assert.rejects(firstAttempt, /Failed to fetch dynamically imported module/);
    assert.equal(importedHrefs.length, 4);

    // The retry path (retryLiveConnection / a fresh connect attempt) calls
    // initialize again. Before the cached-rejection fix this re-awaited the
    // pinned rejected import; with it, a fresh import() is issued.
    healed = true;
    const module = await initializeRuntimedWasmClient(STABLE_MODULE, STABLE_WASM);

    assert.equal(typeof module.project_markdown_json, "function");
    assert.equal(importedHrefs.length, 5);
  });

  it("clears the init cache when wasm-bindgen init rejects, then recovers", async () => {
    const initCalls: unknown[] = [];
    let initFailures = 1;
    _setRuntimedWasmModuleImporterForTests(async () => ({
      default: async (options: { module_or_path: unknown }) => {
        if (initFailures > 0) {
          initFailures -= 1;
          throw new Error("synthetic wasm init failure");
        }
        initCalls.push(options.module_or_path);
      },
      project_markdown_json: () => null,
    }));
    _setRuntimedWasmFetchForTests(okFetch().fetch);

    await assert.rejects(
      initializeRuntimedWasmClient(STABLE_MODULE, STABLE_WASM),
      /synthetic wasm init failure/,
    );

    await initializeRuntimedWasmClient(STABLE_MODULE, STABLE_WASM);

    assert.equal(initCalls.length, 1);
  });

  it("still refuses a second initialization from a different source", async () => {
    _setRuntimedWasmModuleImporterForTests(async () => stubModule());
    _setRuntimedWasmFetchForTests(okFetch().fetch);

    await initializeRuntimedWasmClient(STABLE_MODULE, STABLE_WASM);

    await assert.rejects(
      initializeRuntimedWasmClient(STABLE_MODULE, "/assets/other_bg.wasm"),
      /already initialized from/,
    );
  });
});
