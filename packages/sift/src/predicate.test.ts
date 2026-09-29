import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetPredicateModuleForTests,
  _setWasmModuleLoaderForTests,
  ensureModule,
  setWasmUrl,
} from "./predicate";

type WasmInput = string | ArrayBuffer | undefined;

function stubWasmModule(initUrls: WasmInput[], failFor: Set<WasmInput>) {
  return {
    default: async (options: { module_or_path?: string | ArrayBuffer }) => {
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
    vi.unstubAllGlobals();
  });

  it("initializes embedded WASM bytes without a fetch under a restricted CSP", async () => {
    const initialize = vi.fn(async (_options: { module_or_path?: string | ArrayBuffer }) => {});
    const fetchMock = vi.fn(() => Promise.reject(new Error("CSP blocked fetch")));
    vi.stubGlobal("fetch", fetchMock);
    _setWasmModuleLoaderForTests(async () => ({ default: initialize }));

    setWasmUrl("data:application/wasm;base64,AGFzbQ==");
    await ensureModule();

    const input = initialize.mock.calls[0][0].module_or_path;
    expect(input).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(input as ArrayBuffer)]).toEqual([0, 97, 115, 109]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries the stable fallback URL once when the primary hashed URL fails", async () => {
    const initUrls: WasmInput[] = [];
    const hashed = "https://assets.test/renderer-assets/sift_wasm.0123456789abcdef.wasm";
    const stable = "https://assets.test/renderer-assets/sift_wasm.wasm?v=dev";
    _setWasmModuleLoaderForTests(async () => stubWasmModule(initUrls, new Set([hashed])));

    setWasmUrl(hashed, stable);
    await ensureModule();

    expect(initUrls).toEqual([hashed, stable]);
  });

  it("stays terminal when no fallback is configured", async () => {
    const initUrls: WasmInput[] = [];
    const url = "https://assets.test/renderer-assets/sift_wasm.wasm?v=dev";
    _setWasmModuleLoaderForTests(async () => stubWasmModule(initUrls, new Set([url])));

    setWasmUrl(url);
    await expect(ensureModule()).rejects.toThrow(/synthetic wasm load failure/);
    expect(initUrls).toEqual([url]);
  });

  it("does not double-load when primary and fallback are identical", async () => {
    const initUrls: WasmInput[] = [];
    const url = "https://assets.test/renderer-assets/sift_wasm.wasm?v=dev";
    _setWasmModuleLoaderForTests(async () => stubWasmModule(initUrls, new Set([url])));

    setWasmUrl(url, url);
    await expect(ensureModule()).rejects.toThrow(/synthetic wasm load failure/);
    expect(initUrls).toEqual([url]);
  });

  it("loads the primary URL without touching the fallback on success", async () => {
    const initUrls: WasmInput[] = [];
    const hashed = "https://assets.test/renderer-assets/sift_wasm.0123456789abcdef.wasm";
    _setWasmModuleLoaderForTests(async () => stubWasmModule(initUrls, new Set()));

    setWasmUrl(hashed, "https://assets.test/renderer-assets/sift_wasm.wasm?v=dev");
    await ensureModule();

    expect(initUrls).toEqual([hashed]);
  });
});
