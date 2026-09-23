import { test } from "node:test";
import assert from "node:assert/strict";
import { ManagedPythonRoom } from "../src/managed-python-room.ts";
import { initializeTestRuntimedWasm } from "./runtimed-wasm-test-loader.ts";
import { fixture, sync } from "./preview-python-helpers.mjs";
import { RuntimeStatePeerHandle } from "../src/runtimed-wasm.ts";
import { encodeTypedFrame } from "../src/protocol.ts";

test("managed room uses private service and publishes through actual runtime-peer permissions", async (t) => {
  await initializeTestRuntimedWasm();
  const { host } = await fixture(t);
  host.set_workstation_attachment_json(
    JSON.stringify({
      workstation_id: "celld-preview-python",
      display_name: "Preview Python",
      provider: "celld-pyodide",
      default_environment_label: "Python",
      environment_policy: "curated",
      status: "connecting",
      runtime_session_id: "session",
    }),
  );
  const requests = [];
  const env = {
    NOTEBOOK_CLOUD_PYTHON_PROVIDER: "celld",
    PREVIEW_PYTHON_SESSIONS: {
      idFromName: (n) => n,
      get: () => ({
        fetch: async (request) => {
          const body = await request.json();
          requests.push({ path: new URL(request.url).pathname, ...body });
          if (new URL(request.url).pathname === "/execute")
            return Response.json({
              execution_count: 1,
              success: true,
              outputs: [{ output_type: "stream", name: "stdout", text: "managed output\n" }],
            });
          return Response.json({ ok: true });
        },
      }),
    },
  };
  const materializer = {
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
  const runtime = new ManagedPythonRoom(
    env,
    materializer,
    "notebook",
    "user:dev:owner",
    "session",
    (result) => runtime.accept(result),
  );
  await runtime.start();
  await runtime.wake();
  assert.equal(requests[0].path, "/open");
  const executed = requests.find((r) => r.path === "/execute");
  assert.equal(executed.ownerPrincipal, "user:dev:owner");
  assert.equal(executed.notebookId, "notebook");
  assert.equal(executed.sessionId, "session");
  assert.equal(executed.execution.source, "print('accepted from notebook')");
  const viewer = new RuntimeStatePeerHandle("user:dev:viewer/test");
  t.after(() => viewer.free());
  sync(host, viewer, "viewer", "viewer", true);
  const execution = Object.values(viewer.get_runtime_state().executions)[0];
  assert.equal(execution.status, "done");
  assert.deepEqual(execution.outputs[0].text, { inline: "managed output\n" });
  await runtime.close();
  assert.equal(requests.at(-1).path, "/close");
});
