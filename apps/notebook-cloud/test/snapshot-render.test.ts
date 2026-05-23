import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeRuntimedWasm } from "../src/runtimed-wasm.ts";
import { materializeSnapshotPairRender } from "../src/snapshot-render.ts";
import { createNotebookCloudBlobResolver } from "../src/blob-resolver.ts";

const wasmBytes = await readFile(
  new URL("../../notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm", import.meta.url),
);

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
        notebookId: "fixture-display-data",
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
});
