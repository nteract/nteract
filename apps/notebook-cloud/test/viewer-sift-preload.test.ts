import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { JupyterOutput } from "../../../src/components/cell/jupyter-output.ts";
import type { ResolvedCell } from "../viewer/render-resolution.ts";
import {
  cellsUseSift,
  preloadSiftWasmForCells,
  siftWasmPreloadUrlForCells,
} from "../viewer/sift-preload.ts";

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

  it("uses prefetch so sandboxed output frames do not trigger unused-preload warnings", () => {
    const targetDocument = fakeDocument();
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
      preloadSiftWasmForCells(cells, preloadOptions(), targetDocument as unknown as Document),
      "https://cloud.test/renderer-assets/sift_wasm.wasm?v=dev",
    );
    assert.equal(targetDocument.links.length, 1);
    assert.equal(targetDocument.links[0]?.rel, "prefetch");
    assert.equal(targetDocument.links[0]?.as, "fetch");
    assert.equal(targetDocument.links[0]?.type, "application/wasm");
    assert.equal(targetDocument.links[0]?.crossOrigin, "anonymous");
    assert.equal(targetDocument.links[0]?.dataset.nteractPreload, "sift-wasm");
  });

  it("keeps repeated live materialization preloads idempotent", () => {
    const targetDocument = fakeDocument();
    const cells = [
      cell([
        {
          output_type: "display_data",
          data: {
            "application/vnd.nteract.arrow-stream-manifest+json": {
              chunks: [{ url: "https://cloud.test/api/n/demo/blobs/sha256-table" }],
            },
          },
          metadata: {},
        },
      ]),
    ];

    assert.equal(
      preloadSiftWasmForCells(cells, preloadOptions(), targetDocument as unknown as Document),
      "https://cloud.test/renderer-assets/sift_wasm.wasm?v=dev",
    );
    assert.equal(
      preloadSiftWasmForCells(cells, preloadOptions(), targetDocument as unknown as Document),
      "https://cloud.test/renderer-assets/sift_wasm.wasm?v=dev",
    );
    assert.equal(targetDocument.links.length, 1);
  });
});

function cell(outputs: JupyterOutput[]): ResolvedCell {
  return {
    id: "cell-1",
    cellType: "code",
    source: "df",
    language: "python",
    executionId: null,
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

type FakeLink = {
  rel: string;
  as: string;
  type: string;
  href: string;
  crossOrigin: string;
  dataset: Record<string, string>;
};

function fakeDocument(): {
  links: FakeLink[];
  head: { querySelectorAll: () => unknown[]; append: (link: unknown) => void };
  createElement: () => unknown;
} {
  const links: FakeLink[] = [];
  return {
    links,
    head: {
      querySelectorAll: () => links,
      append: (link: unknown) => {
        links.push(link as (typeof links)[number]);
      },
    },
    createElement: () => ({
      rel: "",
      as: "",
      type: "",
      href: "",
      crossOrigin: "",
      dataset: {},
    }),
  };
}
