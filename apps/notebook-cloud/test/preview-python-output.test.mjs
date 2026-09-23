import { before, test } from "node:test";
import assert from "node:assert/strict";
import { initializeTestRuntimedWasm } from "./runtimed-wasm-test-loader.ts";
import { prepare_output_content } from "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js";
import { createOutputPreparer } from "../../preview-python/src/output-manifests.js";
before(initializeTestRuntimedWasm);

test("rich Python outputs use canonical MIME decoding and uploaded content references", async () => {
  const blobs = new Map();
  const prepare = createOutputPreparer({
    prepareContent: prepare_output_content,
    putBlob: async (blob) => blobs.set(blob.hash, blob),
  });
  const outputs = await prepare([
    { output_type: "stream", name: "stdout", text: "hello" },
    {
      output_type: "display_data",
      metadata: {},
      data: {
        "image/png": "AQID",
        "text/html": "x".repeat(2048),
        "application/json": { x: 1 },
        "image/svg+xml": "<svg/>",
      },
    },
    { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["line1", "line2"] },
  ]);
  assert.deepEqual(outputs[0].text, { inline: "hello" });
  const rich = outputs[1].data;
  assert.deepEqual(Array.from(blobs.get(rich["image/png"].blob).bytes), [1, 2, 3]);
  assert.equal(rich["image/png"].size, 3);
  assert.equal(new TextDecoder().decode(blobs.get(rich["text/html"].blob).bytes), "x".repeat(2048));
  assert.deepEqual(rich["application/json"], { inline: '{"x":1}' });
  assert.deepEqual(rich["image/svg+xml"], { inline: "<svg/>" });
  assert.deepEqual(outputs[2].traceback, { inline: '["line1","line2"]' });
  assert.equal(new Set(outputs.map((o) => o.output_id)).size, 3);
  await assert.rejects(
    prepare([{ output_type: "display_data", data: { "image/png": "bad!" } }]),
    /Invalid binary/,
  );
});

test("failed blob upload prevents returning publishable manifests", async () => {
  const prepare = createOutputPreparer({
    prepareContent: prepare_output_content,
    putBlob: async () => {
      throw new Error("storage unavailable");
    },
  });
  await assert.rejects(
    prepare([{ output_type: "display_data", data: { "image/png": "AQID" } }]),
    /storage unavailable/,
  );
});
