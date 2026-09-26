import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { initializeTestRuntimedWasm } from "./runtimed-wasm-test-loader.ts";
import { fixture, sync } from "./preview-python-helpers.mjs";
import { PythonRuntimePeer } from "../../preview-python/src/runtime-peer.js";
import { createOutputPreparer } from "../../preview-python/src/output-manifests.js";
import { prepare_output_content } from "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js";
import { RuntimeStatePeerHandle, loadRoomHostSnapshot } from "../src/runtimed-wasm.ts";
import { storeManagedPythonBlob } from "../src/managed-python-blobs.ts";
import { blobKey } from "../src/storage.ts";
import { materializeSnapshotPairRender } from "../src/snapshot-render.ts";
import { createNotebookCloudBlobResolver } from "../src/blob-resolver.ts";

before(initializeTestRuntimedWasm);

test("large Python raster bytes stay in blob storage through runtime sync and snapshot reload", async (t) => {
  const image = largePng();
  const hash = createHash("sha256").update(image).digest("hex");
  const { host, peer, publish } = await fixture(t, "display(large_image)");
  const objects = new Map();
  const env = {
    NOTEBOOK_SNAPSHOTS: {
      head: async (key) => objects.get(key) ?? null,
      put: async (key, bytes, options) => {
        if (objects.has(key)) return null;
        const stored = { bytes: bytes.slice(), size: bytes.byteLength, ...options };
        objects.set(key, stored);
        return stored;
      },
    },
  };
  const bridge = new PythonRuntimePeer({
    peer,
    sessionKey: "image-test",
    isCurrent: () => true,
    publish: async () => {
      // The runtime must not sync a reference ahead of its binary upload.
      for (const execution of Object.values(peer.get_runtime_state().executions)) {
        if (execution.outputs.length) assert.ok(objects.has(blobKey("pyodide-test", hash)));
      }
      await publish();
    },
    pool: {
      execute: async (_key, execution) => {
        assert.equal(execution.cell_id, "code");
        assert.equal(execution.source, "display(large_image)");
        return {
          execution_count: 1,
          success: true,
          outputs: [
            {
              output_type: "display_data",
              metadata: {},
              data: { "image/png": image.toString("base64"), "text/plain": "large raster" },
            },
          ],
        };
      },
      release: async () => {},
    },
    prepareOutputs: createOutputPreparer({
      prepareContent: prepare_output_content,
      putBlob: (blob) => storeManagedPythonBlob(env, "pyodide-test", blob),
    }),
  });
  t.after(() => bridge.close());
  await bridge.drain();
  const expectedRef = { blob: hash, size: image.byteLength };
  const observer = new RuntimeStatePeerHandle("user:dev:image-observer/test");
  t.after(() => observer.free());
  sync(host, observer, "image-observer", "viewer", true);
  const execution = Object.values(observer.get_runtime_state().executions)[0];
  assert.equal(execution.status, "done");
  const manifest = execution.outputs[0];
  assert.deepEqual(manifest.data["image/png"], expectedRef);
  assert.deepEqual(manifest.data["text/plain"], { inline: "large raster" });
  assert.ok(JSON.stringify(manifest).length < 512);

  const notebookBytes = host.save_notebook();
  const runtimeStateBytes = host.save_runtime_state_doc();
  assert.ok(notebookBytes.byteLength < 16_384);
  assert.ok(runtimeStateBytes.byteLength < 16_384);
  const saved = await materializeSnapshotPairRender({
    notebookId: "pyodide-test",
    notebookHeadsHash: "test",
    runtimeHeadsHash: "test",
    notebookBytes,
    runtimeStateBytes,
  });
  assert.deepEqual(saved.cells[0].outputs[0].data["image/png"], expectedRef);
  assert.ok(JSON.stringify(saved).length < 4096);

  // A new room and peer recover exactly the same references from saved bytes.
  const restored = await loadRoomHostSnapshot(notebookBytes, runtimeStateBytes);
  const reconnected = new RuntimeStatePeerHandle("user:dev:reconnected/test");
  t.after(() => {
    restored.free();
    reconnected.free();
  });
  sync(restored, reconnected, "reconnected", "viewer", true);
  assert.deepEqual(
    Object.values(reconnected.get_runtime_state().executions)[0].outputs,
    execution.outputs,
  );

  let reads = 0;
  const makeResolver = () =>
    createNotebookCloudBlobResolver({
      baseUrl: "https://viewer.example.test",
      blobBasePath: "/api/n/pyodide-test/blobs/",
      authenticatedBinaryDisplayUrls: true,
      fetchImpl: async (url) => {
        assert.equal(String(url), `https://viewer.example.test/api/n/pyodide-test/blobs/${hash}`);
        reads++;
        const stored = objects.get(blobKey("pyodide-test", hash));
        return new Response(stored.bytes, {
          headers: { "Content-Type": stored.httpMetadata.contentType },
        });
      },
    });
  for (const ref of [manifest.data["image/png"], saved.cells[0].outputs[0].data["image/png"]]) {
    const resolver = makeResolver();
    const display = await resolver.displayUrl(ref, "image/png");
    assert.equal(await resolver.displayUrl(ref, "image/png"), display);
    assert.deepEqual(Buffer.from(await (await fetch(display)).arrayBuffer()), image);
  }
  assert.equal(reads, 2, "reload fetches the stored bytes; rerender reuses the display string");
  assert.equal(objects.size, 1);
  t.diagnostic(
    JSON.stringify({
      imageBytes: image.byteLength,
      imageReferenceBytes: JSON.stringify(expectedRef).length,
      outputManifestBytes: JSON.stringify(manifest).length,
      notebookSnapshotBytes: notebookBytes.byteLength,
      runtimeSnapshotBytes: runtimeStateBytes.byteLength,
    }),
  );
});

// Valid, deterministic 1024 x 1024 RGBA PNG. Uncompressed DEFLATE keeps the
// binary payload large even though the fixture is a simple gradient.
function largePng() {
  const size = 1024;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(size * (1 + 4 * size));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = y * (1 + 4 * size) + 1 + 4 * x;
      pixels.set([x % 256, y % 256, 128, 255], offset);
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
