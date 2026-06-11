/**
 * Retry/caching behavior of the runtimed WASM client.
 *
 * Layers under test:
 *  1. Cached-rejection recovery — a failed connect attempt clears the
 *     cached import so retryLiveConnection really re-imports.
 *  2. The retry ladder ([150, 500, 1500] ms) for both the module import
 *     and the .wasm binary fetch — thrown fetch errors and 404/409/425/
 *     429/5xx statuses retry (404 deliberately, for deploy propagation);
 *     other statuses bail. Delays are boundary-pinned per ladder.
 *  3. Module-map busting — import() retry rungs carry a unique ?retry=
 *     query because the browser module map pins failed fetches per
 *     specifier for the life of the page.
 *  4. The hashed→stable filename fallback, COUPLED pairwise: if either
 *     half falls back to stable, the other follows (never hashed glue
 *     against a stable binary or vice versa — the #3416 skew class).
 *  5. Per-rung timeouts — a hung attempt becomes a failed rung instead of
 *     wedging the shared init singleton forever.
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

/** Strip the module-map cache buster for name-based assertions. */
function unbusted(href: string): string {
  return href.replace(/[?&]retry=\d+$/, "");
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

  it("retries the module import on the exact ladder delays with module-map busting", async (t: TestContext) => {
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
    // Retry rungs bust the browser module map (failed module fetches are
    // pinned per specifier); rung 0 uses the bare name.
    assert.deepEqual(importedHrefs, [
      STABLE_MODULE,
      `${STABLE_MODULE}?retry=1`,
      `${STABLE_MODULE}?retry=2`,
    ]);
    assert.deepEqual(wasmFetch.calls, [STABLE_WASM]);
  });

  it("falls back from the hashed module name to the stable copy after the ladder exhausts", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const importedHrefs: string[] = [];
    _setRuntimedWasmModuleImporterForTests(async (href) => {
      importedHrefs.push(href);
      if (unbusted(href) === HASHED_MODULE) {
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
      `${HASHED_MODULE}?retry=1`,
      `${HASHED_MODULE}?retry=2`,
      `${HASHED_MODULE}?retry=3`,
      STABLE_MODULE,
    ]);
    assert.deepEqual(wasmFetch.calls, [STABLE_WASM]);
  });

  it("has no fallback for stable module names: the failure is terminal after a boundary-exact final rung", async (t: TestContext) => {
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
    await drain();
    t.mock.timers.tick(150);
    await drain();
    t.mock.timers.tick(500);
    await drain();
    assert.equal(importedHrefs.length, 3);
    // Final rung is exactly 1500ms.
    t.mock.timers.tick(1499);
    await drain();
    assert.equal(importedHrefs.length, 3);
    assert.equal(settled(), false);
    t.mock.timers.tick(1);
    await drain();
    assert.equal(importedHrefs.length, 4);
    // Exactly one ladder; no further timers pending, the rejection is final.
    assert.equal(settled(), true);
    await assert.rejects(promise, /Failed to fetch dynamically imported module/);
    assert.ok(importedHrefs.every((href) => unbusted(href) === STABLE_MODULE));
  });

  it("boundary-pins the binary ladder and retries 404/409/425/429 before the stable fallback", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const initCalls: unknown[] = [];
    _setRuntimedWasmModuleImporterForTests(async () => stubModule(initCalls));
    const statuses = [404, 409, 425, 429];
    const fetchedHrefs: string[] = [];
    _setRuntimedWasmFetchForTests((async (input: RequestInfo | URL) => {
      fetchedHrefs.push(String(input));
      const status = statuses.shift();
      return status === undefined ? new Response("wasm-bytes") : new Response("nope", { status });
    }) as typeof fetch);

    const pending = initializeRuntimedWasmClient(STABLE_MODULE, HASHED_WASM);
    await drain();
    assert.equal(fetchedHrefs.length, 1);

    // Binary rungs pinned independently of the module ladder.
    t.mock.timers.tick(149);
    await drain();
    assert.equal(fetchedHrefs.length, 1);
    t.mock.timers.tick(1);
    await drain();
    assert.equal(fetchedHrefs.length, 2);

    t.mock.timers.tick(499);
    await drain();
    assert.equal(fetchedHrefs.length, 2);
    t.mock.timers.tick(1);
    await drain();
    assert.equal(fetchedHrefs.length, 3);

    t.mock.timers.tick(1499);
    await drain();
    assert.equal(fetchedHrefs.length, 3);
    t.mock.timers.tick(1);
    await drain();
    // Final hashed attempt (429) exhausts the ladder; the stable fallback
    // fires immediately with no further sleep.
    assert.equal(fetchedHrefs.length, 5);

    await pending;
    assert.deepEqual(fetchedHrefs, [
      HASHED_WASM,
      HASHED_WASM,
      HASHED_WASM,
      HASHED_WASM,
      STABLE_WASM,
    ]);
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

  it("couples the pair: a binary stable-fallback forces the hashed module onto its stable copy", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const initCalls: unknown[] = [];
    const importedHrefs: string[] = [];
    _setRuntimedWasmModuleImporterForTests(async (href) => {
      importedHrefs.push(href);
      return stubModule(initCalls);
    });
    const fetchedHrefs: string[] = [];
    _setRuntimedWasmFetchForTests((async (input: RequestInfo | URL) => {
      const href = String(input);
      fetchedHrefs.push(href);
      return href === HASHED_WASM
        ? new Response("gone", { status: 404 })
        : new Response("wasm-bytes");
    }) as typeof fetch);

    const pending = initializeRuntimedWasmClient(HASHED_MODULE, HASHED_WASM);
    for (const delay of [150, 500, 1500]) {
      await drain();
      t.mock.timers.tick(delay);
    }
    await pending;

    // Hashed module succeeded, but the binary fell back to stable — the
    // glue must follow (never hashed glue against a stable binary, #3416).
    assert.deepEqual(importedHrefs, [HASHED_MODULE, STABLE_MODULE]);
    assert.deepEqual(fetchedHrefs, [
      HASHED_WASM,
      HASHED_WASM,
      HASHED_WASM,
      HASHED_WASM,
      STABLE_WASM,
    ]);
    assert.ok(initCalls[0] instanceof Response);
  });

  it("couples the pair: a module stable-fallback skips the hashed binary name outright", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const importedHrefs: string[] = [];
    _setRuntimedWasmModuleImporterForTests(async (href) => {
      importedHrefs.push(href);
      if (unbusted(href) === HASHED_MODULE) {
        throw new TypeError("Failed to fetch dynamically imported module");
      }
      return stubModule();
    });
    const fetchedHrefs: string[] = [];
    _setRuntimedWasmFetchForTests((async (input: RequestInfo | URL) => {
      fetchedHrefs.push(String(input));
      return new Response("wasm-bytes");
    }) as typeof fetch);

    const pending = initializeRuntimedWasmClient(HASHED_MODULE, HASHED_WASM);
    for (const delay of [150, 500, 1500]) {
      await drain();
      t.mock.timers.tick(delay);
    }
    await pending;

    assert.equal(unbusted(importedHrefs[importedHrefs.length - 1] ?? ""), STABLE_MODULE);
    // The hashed binary name is never attempted once the module pair
    // already fell back to stable.
    assert.deepEqual(fetchedHrefs, [STABLE_WASM]);
  });

  it("turns a hung module import rung into a failed rung instead of wedging the singleton", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const importedHrefs: string[] = [];
    _setRuntimedWasmModuleImporterForTests((href) => {
      importedHrefs.push(href);
      if (importedHrefs.length === 1) {
        return new Promise(() => {}); // black-holed: never settles
      }
      return Promise.resolve(stubModule());
    });
    _setRuntimedWasmFetchForTests(okFetch().fetch);

    const pending = initializeRuntimedWasmClient(STABLE_MODULE, STABLE_WASM);
    await drain();
    assert.equal(importedHrefs.length, 1);

    // The rung timeout (20s) abandons the hung attempt...
    t.mock.timers.tick(20_000);
    await drain();
    assert.equal(importedHrefs.length, 1);
    // ...and the ladder advances on its normal first rung.
    t.mock.timers.tick(150);
    await drain();
    assert.equal(importedHrefs.length, 2);

    const module = await pending;
    assert.equal(typeof module.project_markdown_json, "function");
  });

  it("turns a hung binary fetch rung into a failed rung instead of wedging the connect", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const initCalls: unknown[] = [];
    _setRuntimedWasmModuleImporterForTests(async () => stubModule(initCalls));
    let fetchCalls = 0;
    _setRuntimedWasmFetchForTests(((input: RequestInfo | URL) => {
      void input;
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Promise(() => {}); // black-holed: never settles
      }
      return Promise.resolve(new Response("wasm-bytes"));
    }) as typeof fetch);

    const pending = initializeRuntimedWasmClient(STABLE_MODULE, STABLE_WASM);
    await drain();
    assert.equal(fetchCalls, 1);

    t.mock.timers.tick(20_000);
    await drain();
    assert.equal(fetchCalls, 1);
    t.mock.timers.tick(150);
    await drain();
    assert.equal(fetchCalls, 2);

    await pending;
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
    assert.equal(importedHrefs[4], STABLE_MODULE);
  });

  it("prefixes terminal failures for notice classification", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    _setRuntimedWasmModuleImporterForTests(async () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    });
    _setRuntimedWasmFetchForTests(okFetch().fetch);

    const { promise } = trackSettled(initializeRuntimedWasmClient(STABLE_MODULE, STABLE_WASM));
    for (const delay of [150, 500, 1500]) {
      await drain();
      t.mock.timers.tick(delay);
    }
    await drain();
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^runtimed WASM asset failed: /);
      return true;
    });
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
