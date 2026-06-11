import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetPredicateModuleForTests,
  _setWasmModuleLoaderForTests,
  ensureModule,
  setWasmUrl,
} from "./predicate";

function stubWasmModule(initUrls: (string | undefined)[], failFor: Set<string | undefined>) {
  return {
    default: async (options: { module_or_path?: string }) => {
      initUrls.push(options.module_or_path);
      if (failFor.has(options.module_or_path)) {
        throw new Error(`synthetic wasm load failure: ${options.module_or_path}`);
      }
    },
  };
}

describe("predicate wasm loading fallback", () => {
  beforeEach(() => {
    _resetPredicateModuleForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    _setWasmModuleLoaderForTests(null);
    _resetPredicateModuleForTests();
    vi.restoreAllMocks();
  });

  it("retries the stable fallback URL once when the primary hashed URL fails", async () => {
    const initUrls: (string | undefined)[] = [];
    const hashed = "https://assets.test/renderer-assets/sift_wasm.0123456789abcdef.wasm";
    const stable = "https://assets.test/renderer-assets/sift_wasm.wasm?v=dev";
    _setWasmModuleLoaderForTests(async () => stubWasmModule(initUrls, new Set([hashed])));

    setWasmUrl(hashed, stable);
    await ensureModule();

    expect(initUrls).toEqual([hashed, stable]);
  });

  it("stays terminal when no fallback is configured", async () => {
    const initUrls: (string | undefined)[] = [];
    const url = "https://assets.test/renderer-assets/sift_wasm.wasm?v=dev";
    _setWasmModuleLoaderForTests(async () => stubWasmModule(initUrls, new Set([url])));

    setWasmUrl(url);
    await expect(ensureModule()).rejects.toThrow(/synthetic wasm load failure/);
    expect(initUrls).toEqual([url]);
  });

  it("does not double-load when primary and fallback are identical", async () => {
    const initUrls: (string | undefined)[] = [];
    const url = "https://assets.test/renderer-assets/sift_wasm.wasm?v=dev";
    _setWasmModuleLoaderForTests(async () => stubWasmModule(initUrls, new Set([url])));

    setWasmUrl(url, url);
    await expect(ensureModule()).rejects.toThrow(/synthetic wasm load failure/);
    expect(initUrls).toEqual([url]);
  });

  it("loads the primary URL without touching the fallback on success", async () => {
    const initUrls: (string | undefined)[] = [];
    const hashed = "https://assets.test/renderer-assets/sift_wasm.0123456789abcdef.wasm";
    _setWasmModuleLoaderForTests(async () => stubWasmModule(initUrls, new Set()));

    setWasmUrl(hashed, "https://assets.test/renderer-assets/sift_wasm.wasm?v=dev");
    await ensureModule();

    expect(initUrls).toEqual([hashed]);
  });
});
