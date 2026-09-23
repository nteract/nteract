import { before, test } from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyRoomHost,
  NotebookHandle,
  RuntimeStatePeerHandle,
} from "../src/runtimed-wasm.ts";
import { FrameType, encodeTypedFrame } from "../src/protocol.ts";
import { initializeTestRuntimedWasm } from "./runtimed-wasm-test-loader.ts";
import { PythonRuntimePeer } from "../../preview-python/src/runtime-peer.js";
before(initializeTestRuntimedWasm);

function sync(host, peer, id, scope, runtime = false, queued = []) {
  const type = runtime ? FrameType.RUNTIME_STATE_SYNC : FrameType.AUTOMERGE_SYNC;
  const flush = () => (runtime ? peer.flush_runtime_state_sync() : peer.flush_local_changes());
  const receive = (payload) =>
    host.receive_peer_frame(
      id,
      `user:dev:${id}`,
      `user:dev:${id}/test`,
      scope,
      scope === "owner",
      encodeTypedFrame(type, payload),
    );
  let outbound = [...queued];
  const initial = flush();
  if (initial) outbound.push(...receive(initial).outbound);
  outbound.push(...host.sync_peer(id, scope).outbound);
  for (let round = 0; round < 30; round++) {
    const replies = [];
    for (const frame of outbound) {
      if (frame.peer_id !== id || frame.frame_type !== type) continue;
      const received = peer.receive_frame(encodeTypedFrame(type, new Uint8Array(frame.payload)));
      for (const event of runtime ? [received] : received)
        if (event.reply) replies.push(new Uint8Array(event.reply));
    }
    const pending = flush();
    if (pending) replies.push(pending);
    if (!replies.length) return;
    outbound = replies.flatMap((payload) => receive(payload).outbound);
  }
  throw new Error("Automerge sync failed to settle");
}

async function fixture(t) {
  const host = await createEmptyRoomHost("pyodide-test", "system/schema:notebook-cloud-room");
  const owner = NotebookHandle.create_bootstrap("user:dev:owner/test");
  const peer = new RuntimeStatePeerHandle("user:dev:runtime/test");
  t.after(() => {
    peer.free();
    owner.free();
    host.free();
  });
  sync(host, owner, "owner", "owner");
  owner.add_cell(0, "code", "code");
  owner.update_source("code", "print('accepted from notebook')");
  sync(host, owner, "owner", "owner");
  const request = (scope = "owner") =>
    host.receive_peer_frame(
      scope,
      `user:dev:${scope}`,
      `user:dev:${scope}/test`,
      scope,
      scope === "owner",
      encodeTypedFrame(
        FrameType.REQUEST,
        new TextEncoder().encode(
          JSON.stringify({ id: crypto.randomUUID(), action: "execute_cell", cell_id: "code" }),
        ),
      ),
    );
  const accepted = request();
  sync(host, owner, "owner", "owner", false, accepted.outbound);
  // Later edits must not silently replace the source the room accepted.
  owner.update_source("code", "print('edited after submission')");
  sync(host, owner, "owner", "owner");
  sync(host, peer, "runtime", "runtime_peer", true);
  return {
    host,
    peer,
    request,
    publish: async () => sync(host, peer, "runtime", "runtime_peer", true),
  };
}

test("bridge executes synced source and publishes through actual room permissions", async (t) => {
  const { host, peer, request, publish } = await fixture(t);
  assert.throws(() => request("editor"), /owner|execution|request/i);
  const calls = [];
  const bridge = new PythonRuntimePeer({
    peer,
    sessionKey: "session",
    isCurrent: () => true,
    publish,
    pool: {
      execute: async (key, execution) => {
        calls.push(execution);
        assert.equal(peer.get_runtime_state().executions[execution.execution_id].status, "running");
        return {
          execution_count: 1,
          success: true,
          outputs: [{ output_type: "stream", name: "stdout", text: "hello\n" }],
        };
      },
      release: async () => {},
    },
    prepareOutputs: async (outputs) =>
      outputs.map((output) => ({ ...output, output_id: "trusted-output" })),
  });
  await Promise.all([bridge.drain(), bridge.drain()]);
  await bridge.drain();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, "print('accepted from notebook')");
  const observer = new RuntimeStatePeerHandle("user:dev:observer/test");
  t.after(() => observer.free());
  sync(host, observer, "observer", "viewer", true);
  const execution = observer.get_runtime_state().executions[calls[0].execution_id];
  assert.equal(execution.status, "done");
  assert.equal(execution.success, true);
  assert.equal(execution.outputs[0].text, "hello\n");
  assert.equal(execution.cell_id, "code");
  await bridge.close();
});

test("bridge fences output when session expires during execution", async (t) => {
  const { peer, publish } = await fixture(t);
  let current = true;
  const bridge = new PythonRuntimePeer({
    peer,
    sessionKey: "expired",
    isCurrent: () => current,
    publish,
    pool: {
      execute: async () => {
        current = false;
        return { execution_count: 1, success: true, outputs: [] };
      },
      release: async () => {},
    },
    prepareOutputs: async () => {
      assert.fail("stale outputs must not be prepared");
    },
  });
  await assert.rejects(bridge.drain(), /session expired/);
  assert.ok(
    Object.values(peer.get_runtime_state().executions).every(
      (e) => e.status === "running" && e.outputs.length === 0,
    ),
  );
  await bridge.close();
});
