import { describe, expect, it } from "vite-plus/test";
import { resolveSiftWasmUrl } from "../sift-assets";

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
});
