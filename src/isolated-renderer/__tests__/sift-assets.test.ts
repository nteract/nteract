import { describe, expect, it } from "vite-plus/test";
import { resolveSiftWasmUrl, resolveSiftWasmUrls } from "../sift-assets";

describe("Sift renderer assets", () => {
  it("uses an explicit renderer asset base when the host provides one", () => {
    expect(
      resolveSiftWasmUrl({
        tableUrl: "https://notebooks.example/api/n/demo/blobs/sha256-abc",
        rendererAssetsBaseUrl: "https://outputs.example/renderer-assets/",
      }),
    ).toBe("https://outputs.example/renderer-assets/sift_wasm.wasm?v=dev");
  });

  it("supports host-relative renderer asset bases for Worker/CDN routes", () => {
    expect(
      resolveSiftWasmUrl({
        tableUrl: "https://notebooks.example/api/n/demo/blobs/sha256-abc",
        rendererAssetsBaseUrl: "/plugins/",
      }),
    ).toBe("https://notebooks.example/plugins/sift_wasm.wasm?v=dev");
  });

  it("falls back to the daemon-style plugin route on the blob URL origin", () => {
    expect(
      resolveSiftWasmUrl({
        tableUrl: "http://127.0.0.1:49152/api/n/demo/blobs/sha256-abc",
      }),
    ).toBe("http://127.0.0.1:49152/plugins/sift_wasm.wasm?v=dev");
  });

  it("uses a content-hashed manifest name without the ?v= query", () => {
    expect(
      resolveSiftWasmUrl({
        tableUrl: "https://notebooks.example/api/n/demo/blobs/sha256-abc",
        rendererAssetsBaseUrl: "https://outputs.example/renderer-assets/",
        siftWasmAssetName: "sift_wasm.0123456789abcdef.wasm",
      }),
    ).toBe("https://outputs.example/renderer-assets/sift_wasm.0123456789abcdef.wasm");
  });

  it("keeps the ?v= cache buster when the manifest hands back the stable name", () => {
    expect(
      resolveSiftWasmUrl({
        tableUrl: "https://notebooks.example/api/n/demo/blobs/sha256-abc",
        rendererAssetsBaseUrl: "https://outputs.example/renderer-assets/",
        siftWasmAssetName: "sift_wasm.wasm",
      }),
    ).toBe("https://outputs.example/renderer-assets/sift_wasm.wasm?v=dev");
  });

  it("rejects asset names that are not sift_wasm variants (host context is sandbox input)", () => {
    expect(
      resolveSiftWasmUrl({
        tableUrl: "https://notebooks.example/api/n/demo/blobs/sha256-abc",
        rendererAssetsBaseUrl: "https://outputs.example/renderer-assets/",
        siftWasmAssetName: "../secrets.wasm",
      }),
    ).toBe("https://outputs.example/renderer-assets/sift_wasm.wasm?v=dev");
  });

  it("pins the validation regex boundaries: short hash, uppercase hex, wrong stem all fall back", () => {
    // Mirrors the worker's isContentHashedAssetPathname predicate (12-64
    // lowercase hex) so immutable caching and the ?v= buster never diverge.
    for (const rejected of [
      "sift_wasm.abc123.wasm", // 6-char hash: too short
      "sift_wasm.0123456789ABCDEF.wasm", // uppercase hex
      "sift_wasm2.0123456789abcdef.wasm", // wrong stem
      "sift_wasm.0123456789abcdef.wasm.js", // wrong extension tail
    ]) {
      expect(
        resolveSiftWasmUrl({
          tableUrl: "https://notebooks.example/api/n/demo/blobs/sha256-abc",
          rendererAssetsBaseUrl: "https://outputs.example/renderer-assets/",
          siftWasmAssetName: rejected,
        }),
      ).toBe("https://outputs.example/renderer-assets/sift_wasm.wasm?v=dev");
    }
  });

  it("pairs a hashed primary URL with the stable + ?v= fallback for deploy-window skew", () => {
    expect(
      resolveSiftWasmUrls({
        tableUrl: "https://notebooks.example/api/n/demo/blobs/sha256-abc",
        rendererAssetsBaseUrl: "https://outputs.example/renderer-assets/",
        siftWasmAssetName: "sift_wasm.0123456789abcdef.wasm",
      }),
    ).toEqual({
      url: "https://outputs.example/renderer-assets/sift_wasm.0123456789abcdef.wasm",
      fallbackUrl: "https://outputs.example/renderer-assets/sift_wasm.wasm?v=dev",
    });
  });

  it("emits no fallback when the primary name is already stable", () => {
    expect(
      resolveSiftWasmUrls({
        tableUrl: "https://notebooks.example/api/n/demo/blobs/sha256-abc",
        rendererAssetsBaseUrl: "https://outputs.example/renderer-assets/",
        siftWasmAssetName: "sift_wasm.wasm",
      }).fallbackUrl,
    ).toBeNull();
    expect(
      resolveSiftWasmUrls({
        tableUrl: "https://notebooks.example/api/n/demo/blobs/sha256-abc",
      }).fallbackUrl,
    ).toBeNull();
  });
});
