import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { startProviderFixture } from "../../preview-python/test/provider-fixture.mjs";
import { ManagedPythonRoom } from "../src/managed-python-room.ts";
import { encodeTypedFrame } from "../src/protocol.ts";
import { blobKey } from "../src/storage.ts";
import { RuntimeStatePeerHandle, loadRoomHostSnapshot } from "../src/runtimed-wasm.ts";
import { initializeTestRuntimedWasm } from "./runtimed-wasm-test-loader.ts";
import { fixture, sync } from "./preview-python-helpers.mjs";

const arrowMime = "application/vnd.apache.arrow.stream";
// Arrow output is a runtime capability. Skip, not fail, when the pinned
// Pyodide ships no PyArrow; Sift and native Arrow paths are unaffected.
const lockedPackages = new URL(
  "../../../packages/pyodide-runtime/scripts/packages.mjs",
  import.meta.url,
);
const pyodideArrow = /"pyarrow"\]/.test(readFileSync(lockedPackages, "utf8"));

test(
  "real celld Arrow output follows accepted notebook source into durable blob references",
  { timeout: 180_000, skip: !process.env.CELLD_BIN || (!pyodideArrow && "PyArrow is not bundled") },
  async (t) => {
    await initializeTestRuntimedWasm();
    const rows = Number(process.env.NTERACT_ARROW_ROWS ?? 100_000);
    assert.ok(Number.isSafeInteger(rows) && rows > 0 && rows <= 1_000_000);
    const source = `import pyarrow as pa, numpy as np
n = ${rows}
ids = np.arange(n, dtype=np.int64)
table = pa.table({
    'id': ids,
    'score': ids * 0.5,
    'city': pa.array(['Santa Cruz', 'Oakland', 'San Jose', 'San Francisco']).take(pa.array(ids % 4)),
    'timestamp': pa.array(ids * 1000, type=pa.timestamp('ms')),
    'active': ids % 2 == 0,
})
assert table.num_rows == n and table.num_columns == 5
print('ARROW_ROWS', table.num_rows)
table`;
    const server = await startProviderFixture();
    let bridge, timer;
    t.after(async () => {
      clearInterval(timer);
      try {
        await bridge?.close();
      } finally {
        await server.close();
      }
    });
    const memory = [];
    const started = performance.now();
    const sample = () => {
      const processes = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/).map(Number));
      const owned = new Set([server.pid]);
      for (let changed = true; changed; ) {
        changed = false;
        for (const [pid, parent] of processes) {
          if (owned.has(parent) && !owned.has(pid)) {
            owned.add(pid);
            changed = true;
          }
        }
      }
      memory.push({
        elapsedMs: performance.now() - started,
        processes: processes
          .filter(([pid]) => owned.has(pid))
          .map(([pid, ppid, rssKiB]) => ({ pid, ppid, rssKiB })),
      });
    };
    sample();
    timer = setInterval(sample, 1000);
    const { host, owner, request } = await fixture(t, source);
    const blobs = new Map();
    host.set_workstation_attachment_json(
      JSON.stringify({
        workstation_id: "celld-preview-python",
        display_name: "Python (sandboxed)",
        provider: "celld-pyodide",
        default_environment_label: "Python",
        environment_policy: "curated",
        status: "connecting",
        runtime_session_id: "arrow",
      }),
    );
    const env = {
      NOTEBOOK_CLOUD_PYTHON_PROVIDER: "celld",
      PREVIEW_PYTHON_SESSIONS: {
        idFromName: (name) => name,
        get: () => ({
          fetch: (request) =>
            fetch(server.url + new URL(request.url).pathname, {
              method: request.method,
              body: request.body,
              duplex: "half",
              signal: AbortSignal.timeout(145_000),
            }),
        }),
      },
      NOTEBOOK_SNAPSHOTS: {
        head: async (key) => blobs.get(key) ?? null,
        put: async (key, bytes, metadata) => {
          if (blobs.has(key)) return null;
          const object = { bytes: bytes.slice(), size: bytes.byteLength, ...metadata };
          blobs.set(key, object);
          return object;
        },
      },
    };
    const materializer = {
      getCloudPackageManifest: async () => JSON.parse(host.get_cloud_package_manifest_json()),
      setCloudPackageState: async (sessionId, value) =>
        host.set_cloud_package_state_json(sessionId, JSON.stringify(value)),
      syncPeer: async (peer) => host.sync_peer(peer.id, peer.identity.scope),
      receiveFrame: async (peer, frame) =>
        host.receive_peer_frame(
          peer.id,
          peer.identity.principal,
          peer.identity.actorLabel,
          peer.identity.scope,
          false,
          encodeTypedFrame(frame.type, frame.payload),
        ),
      checkpoint: async () => {},
      removePeer: async (id) => host.remove_peer(id),
    };
    bridge = new ManagedPythonRoom(
      env,
      materializer,
      "notebook",
      "user:dev:owner",
      "arrow",
      (result) => bridge.accept(result),
    );
    await bridge.start();
    const startupMs = performance.now() - started;
    await bridge.wake();
    const executionMs = performance.now() - started - startupMs;
    const viewer = new RuntimeStatePeerHandle("user:dev:arrow-viewer/test");
    t.after(() => viewer.free());
    sync(host, viewer, "arrow-viewer", "viewer", true);
    const execution = Object.values(viewer.get_runtime_state().executions)[0];
    assert.equal(execution.status, "done", JSON.stringify(execution));
    assert.equal(execution.success, true, JSON.stringify(execution));
    assert.equal(
      execution.source,
      source,
      "the later notebook edit must not replace accepted code",
    );
    const ref = execution.outputs.find((output) => output.data?.[arrowMime])?.data[arrowMime];
    assert.ok(ref?.blob, JSON.stringify(execution.outputs));
    const blob = blobs.get(blobKey("notebook", ref.blob));
    assert.equal(blob.httpMetadata.contentType, arrowMime);
    assert.equal(ref.size, blob.bytes.byteLength);
    assert.ok(ref.size > 2 * 1024 * 1024);
    assert.equal(createHash("sha256").update(blob.bytes).digest("hex"), ref.blob);
    assert.ok(JSON.stringify(execution.outputs).length < 4096, "no IPC bytes in RuntimeStateDoc");
    const notebookBytes = host.save_notebook();
    const runtimeBytes = host.save_runtime_state_doc();
    const restored = await loadRoomHostSnapshot(notebookBytes, runtimeBytes);
    const reconnected = new RuntimeStatePeerHandle("user:dev:arrow-reconnected/test");
    t.after(() => {
      restored.free();
      reconnected.free();
    });
    sync(restored, reconnected, "arrow-reconnected", "viewer", true);
    assert.deepEqual(
      Object.values(reconnected.get_runtime_state().executions)[0].outputs,
      execution.outputs,
    );

    // A rich table must not prevent the next synced execution from completing.
    owner.update_source("code", "print('ARROW_NEXT_CELL', table.num_rows)");
    sync(host, owner, "owner", "owner");
    const accepted = request();
    bridge.accept(accepted);
    sync(host, owner, "owner", "owner", false, accepted.outbound);
    await bridge.wake();
    // This fixture only routes live fanout to the managed peer. A fresh
    // observer gets a complete sync instead of depending on discarded frames.
    const afterViewer = new RuntimeStatePeerHandle("user:dev:arrow-after/test");
    t.after(() => afterViewer.free());
    sync(host, afterViewer, "arrow-after", "viewer", true);
    const after = Object.values(afterViewer.get_runtime_state().executions);
    assert.ok(
      after.some(
        (item) =>
          item.success &&
          item.outputs.some((o) => o.text?.inline?.includes(`ARROW_NEXT_CELL ${rows}`)),
      ),
      JSON.stringify(after),
    );
    sample();
    const evidence = {
      rows,
      columns: 5,
      startupMs,
      executionMs,
      ipcBytes: ref.size,
      sha256: ref.blob,
      outputManifestBytes: JSON.stringify(execution.outputs).length,
      notebookSnapshotBytes: notebookBytes.byteLength,
      runtimeSnapshotBytes: runtimeBytes.byteLength,
      peakProcessRssKiB: Math.max(
        ...memory.flatMap((sample) => sample.processes.map((p) => p.rssKiB)),
      ),
      peakSummedRssKiB: Math.max(
        ...memory.map((sample) => sample.processes.reduce((sum, p) => sum + p.rssKiB, 0)),
      ),
      platform: process.platform,
      memory,
    };
    t.diagnostic(JSON.stringify({ ...evidence, memory: undefined }));
    if (process.env.NTERACT_ARROW_EVIDENCE_DIR) {
      const directory = resolve(process.env.NTERACT_ARROW_EVIDENCE_DIR);
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, "table.arrow"), blob.bytes);
      await writeFile(resolve(directory, "evidence.json"), JSON.stringify(evidence, null, 2));
    }
  },
);
