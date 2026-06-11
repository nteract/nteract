/**
 * Retry/caching behavior of the runtimed WASM client.
 *
 * The load path caches the dynamic `import()` promise for the life of the
 * page. Before the cached-rejection fix, a single transient import failure
 * pinned the rejected promise forever: every later attempt — including
 * retryLiveConnection reconnects — re-awaited the same rejection. These
 * tests inject a controllable importer to prove a failed attempt clears
 * the cache so the next attempt really re-imports.
 *
 * Runs in its own file: the runtimed-wasm-client module caches the loaded
 * module singleton per process, so these tests must not share a process
 * with anything that initializes the real WASM module.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  _resetRuntimedWasmClientForTests,
  _setRuntimedWasmModuleImporterForTests,
  initializeRuntimedWasmClient,
} from "../viewer/runtimed-wasm-client.ts";

function stubModule(initCalls: unknown[] = []) {
  return {
    default: async (options: { module_or_path: unknown }) => {
      initCalls.push(options.module_or_path);
    },
    project_markdown_json: () => null,
  };
}

describe("runtimed WASM client cached-rejection recovery", () => {
  beforeEach(() => {
    _resetRuntimedWasmClientForTests();
  });

  afterEach(() => {
    _setRuntimedWasmModuleImporterForTests(null);
    _resetRuntimedWasmClientForTests();
  });

  it("clears the cached import on rejection so a retry can succeed", async () => {
    const importedHrefs: string[] = [];
    let failuresRemaining = 1;
    _setRuntimedWasmModuleImporterForTests(async (href) => {
      importedHrefs.push(href);
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new TypeError("Failed to fetch dynamically imported module");
      }
      return stubModule();
    });

    await assert.rejects(
      initializeRuntimedWasmClient("/assets/runtimed_wasm.js", "/assets/runtimed_wasm_bg.wasm"),
      /Failed to fetch dynamically imported module/,
    );

    // The retry path (retryLiveConnection / a fresh connect attempt) calls
    // initialize again. Before the fix this re-awaited the pinned rejected
    // import; with it, a fresh import() is issued and succeeds.
    const module = await initializeRuntimedWasmClient(
      "/assets/runtimed_wasm.js",
      "/assets/runtimed_wasm_bg.wasm",
    );

    assert.equal(typeof module.project_markdown_json, "function");
    assert.equal(importedHrefs.length, 2);
    assert.deepEqual(importedHrefs, ["/assets/runtimed_wasm.js", "/assets/runtimed_wasm.js"]);
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

    await assert.rejects(
      initializeRuntimedWasmClient("/assets/runtimed_wasm.js", "/assets/runtimed_wasm_bg.wasm"),
      /synthetic wasm init failure/,
    );

    await initializeRuntimedWasmClient("/assets/runtimed_wasm.js", "/assets/runtimed_wasm_bg.wasm");

    assert.equal(initCalls.length, 1);
  });

  it("still refuses a second initialization from a different source", async () => {
    _setRuntimedWasmModuleImporterForTests(async () => stubModule());

    await initializeRuntimedWasmClient("/assets/runtimed_wasm.js", "/assets/runtimed_wasm_bg.wasm");

    await assert.rejects(
      initializeRuntimedWasmClient("/assets/runtimed_wasm.js", "/assets/other_bg.wasm"),
      /already initialized from/,
    );
  });
});
