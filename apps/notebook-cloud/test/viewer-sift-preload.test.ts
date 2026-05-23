import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { JupyterOutput } from "../../../src/components/cell/jupyter-output.ts";
import type { ResolvedCell } from "../viewer/render-resolution.ts";
import { cellsUseSift, siftWasmPreloadUrlForCells } from "../viewer/sift-preload.ts";

describe("cloud viewer Sift WASM preload", () => {
  it("skips notebooks without Sift-backed outputs", () => {
    const cells = [cell([{ output_type: "stream", name: "stdout", text: "hello\n" }])];

    assert.equal(cellsUseSift(cells), false);
    assert.equal(siftWasmPreloadUrlForCells(cells, preloadOptions()), null);
  });

  it("preloads the exact renderer asset URL for Arrow manifest outputs", () => {
    const cells = [
      cell([
        {
          output_type: "display_data",
          data: {
            "text/html": "<table></table>",
            "application/vnd.nteract.arrow-stream-manifest+json": {
              chunks: [{ url: "https://cloud.test/api/n/demo/blobs/sha256-table" }],
            },
          },
          metadata: {},
        },
      ]),
    ];

    assert.equal(cellsUseSift(cells), true);
    assert.equal(
      siftWasmPreloadUrlForCells(
        cells,
        preloadOptions({
          rendererAssetsBasePath: "https://outputs.example/renderer-assets/",
        }),
      ),
      "https://outputs.example/renderer-assets/sift_wasm.wasm?v=dev",
    );
  });

  it("supports host-relative renderer asset routes", () => {
    const cells = [
      cell([
        {
          output_type: "execute_result",
          execution_count: 1,
          data: {
            "application/vnd.apache.arrow.stream": "https://cloud.test/api/n/demo/blobs/sha256",
          },
          metadata: {},
        },
      ]),
    ];

    assert.equal(
      siftWasmPreloadUrlForCells(
        cells,
        preloadOptions({
          rendererAssetsBasePath: "/renderer-assets/",
        }),
      ),
      "https://cloud.test/renderer-assets/sift_wasm.wasm?v=dev",
    );
  });
});

function cell(outputs: JupyterOutput[]): ResolvedCell {
  return {
    id: "cell-1",
    cellType: "code",
    source: "df",
    language: "python",
    executionCount: null,
    outputs,
    metadata: {},
  };
}

function preloadOptions(overrides: Partial<Parameters<typeof siftWasmPreloadUrlForCells>[1]> = {}) {
  return {
    blobBasePath: "/api/n/demo/blobs/",
    rendererAssetsBasePath: "/renderer-assets/",
    pageUrl: "https://cloud.test/n/demo",
    ...overrides,
  };
}
