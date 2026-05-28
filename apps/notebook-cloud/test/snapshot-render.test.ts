import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeRuntimedWasm, RuntimeStatePeerHandle } from "../src/runtimed-wasm.ts";
import { materializeSnapshotPairRender } from "../src/snapshot-render.ts";
import {
  createNotebookCloudBlobResolver,
  notebookCloudBlobBasePath,
} from "../src/blob-resolver.ts";

const wasmBytes = await readFile(
  new URL("../../notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm", import.meta.url),
);
const ARROW_STREAM_MANIFEST_MIME = "application/vnd.nteract.arrow-stream-manifest+json";

before(async () => {
  await initializeRuntimedWasm(wasmBytes);
});

describe("snapshot pair render materialization", () => {
  it("loads NotebookDoc + RuntimeStateDoc bytes and preserves output manifests", async () => {
    const [notebookBytes, runtimeStateBytes] = await Promise.all([
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/output_streaming/doc.bin",
          import.meta.url,
        ),
      ),
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/output_streaming/state_doc.bin",
          import.meta.url,
        ),
      ),
    ]);

    const render = await materializeSnapshotPairRender({
      notebookId: "fixture-output-streaming",
      notebookHeadsHash: "heads-fixture",
      runtimeHeadsHash: "runtime-fixture",
      notebookBytes,
      runtimeStateBytes,
      generatedAt: "2026-05-22T00:00:00.000Z",
    });
    const cells = render.cells as Array<Record<string, unknown>>;
    const outputs = cells[0].outputs as Array<Record<string, unknown>>;

    assert.equal(render.generated_from, "runtimed-wasm:load_snapshot");
    assert.equal(render.source, "snapshot-pair");
    assert.notEqual(render.metadata, undefined);
    assert.equal(cells.length, 1);
    assert.equal(cells[0].id, "cell-1");
    assert.deepEqual(
      outputs.map((output) => output.output_id),
      [
        "c8b09c2d-a456-5186-b875-441a5fadf374",
        "58af4526-9a90-5bca-98de-d8d0e36718b2",
        "cad63e3f-42e3-542b-b28b-5d3acde7906d",
      ],
    );
  });

  it("derives hosted blob URLs through the shared BlobResolver surface", async () => {
    const [notebookBytes, runtimeStateBytes] = await Promise.all([
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/display_data_output/doc.bin",
          import.meta.url,
        ),
      ),
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/display_data_output/state_doc.bin",
          import.meta.url,
        ),
      ),
    ]);

    const render = await materializeSnapshotPairRender({
      notebookId: "fixture-display-data",
      notebookHeadsHash: "heads-fixture",
      runtimeHeadsHash: "runtime-fixture",
      notebookBytes,
      runtimeStateBytes,
      generatedAt: "2026-05-22T00:00:00.000Z",
      blobResolver: createNotebookCloudBlobResolver({
        baseUrl: "https://cloud.test/n/fixture-display-data",
        blobBasePath: notebookCloudBlobBasePath("fixture-display-data"),
      }),
    });
    const blobUrls = Object.values(render.blob_urls);

    assert.ok(blobUrls.length > 0, "fixture should contain at least one blob ref");
    assert.ok(
      blobUrls.every((url) =>
        url.startsWith("https://cloud.test/api/n/fixture-display-data/blobs/"),
      ),
      `unexpected blob URL set: ${JSON.stringify(render.blob_urls)}`,
    );
  });

  it("derives hosted blob URLs from Arrow stream manifest chunk hashes", async () => {
    const [fixtureManifest, notebookBytes, runtimeStateBytes] = await Promise.all([
      readJson(
        new URL(
          "../../../packages/runtimed/tests/fixtures/sift_arrow_output/manifest.json",
          import.meta.url,
        ),
      ),
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/sift_arrow_output/doc.bin",
          import.meta.url,
        ),
      ),
      readFile(
        new URL(
          "../../../packages/runtimed/tests/fixtures/sift_arrow_output/state_doc.bin",
          import.meta.url,
        ),
      ),
    ]);
    const expected = fixtureManifest.expected as Record<string, unknown>;
    const blobHash = expected.blob_hash as string;

    const render = await materializeSnapshotPairRender({
      notebookId: "fixture-sift-arrow",
      notebookHeadsHash: "heads-fixture",
      runtimeHeadsHash: "runtime-fixture",
      notebookBytes,
      runtimeStateBytes,
      generatedAt: "2026-05-22T00:00:00.000Z",
      blobResolver: createNotebookCloudBlobResolver({
        baseUrl: "https://cloud.test/n/fixture-sift-arrow",
        blobBasePath: notebookCloudBlobBasePath("fixture-sift-arrow"),
      }),
    });
    const cells = render.cells as Array<{
      outputs?: Array<{ data?: Record<string, { inline?: string }> }>;
    }>;
    const arrowRef = cells[0].outputs?.[0].data?.[ARROW_STREAM_MANIFEST_MIME];

    assert.ok(arrowRef?.inline, "fixture should contain an inline Arrow stream manifest");
    assert.equal(JSON.parse(arrowRef.inline).chunks[0].hash, blobHash);
    assert.equal(
      render.blob_urls[blobHash],
      `https://cloud.test/api/n/fixture-sift-arrow/blobs/${encodeURIComponent(blobHash)}`,
    );
  });

  it("materializes RuntimeStateDoc widget comms for hosted widget views", async () => {
    const notebookBytes = await readFile(
      new URL(
        "../../../packages/runtimed/tests/fixtures/output_streaming/doc.bin",
        import.meta.url,
      ),
    );
    const peer = new RuntimeStatePeerHandle("runtime");
    peer.put_comm_json(
      "progress-widget",
      "jupyter.widget",
      "@jupyter-widgets/controls",
      "IntProgressModel",
      JSON.stringify({
        description: "Resolving data files:",
        value: 56,
        min: 0,
        max: 56,
        bar_style: "success",
        orientation: "horizontal",
      }),
      4,
    );
    const runtimeStateBytes = peer.save();
    peer.free();

    const render = await materializeSnapshotPairRender({
      notebookId: "fixture-widget-progress",
      notebookHeadsHash: "heads-fixture",
      runtimeHeadsHash: "runtime-fixture",
      notebookBytes,
      runtimeStateBytes,
      generatedAt: "2026-05-22T00:00:00.000Z",
    });

    assert.deepEqual(render.widget_comms, [
      {
        comm_id: "progress-widget",
        target_name: "jupyter.widget",
        model_module: "@jupyter-widgets/controls",
        model_name: "IntProgressModel",
        state: {
          description: "Resolving data files:",
          value: 56,
          min: 0,
          max: 56,
          bar_style: "success",
          orientation: "horizontal",
        },
        seq: 4,
      },
    ]);
  });
});

async function readJson(url: URL): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(url, "utf8")) as Record<string, unknown>;
}
