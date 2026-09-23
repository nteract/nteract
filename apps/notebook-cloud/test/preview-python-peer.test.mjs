import { before, test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeStatePeerHandle } from "../src/runtimed-wasm.ts";
import { initializeTestRuntimedWasm } from "./runtimed-wasm-test-loader.ts";
import { PythonRuntimePeer } from "../../preview-python/src/runtime-peer.js";
import { createOutputPreparer } from "../../preview-python/src/output-manifests.js";
import { prepare_output_content } from "../../notebook/src/wasm/runtimed-wasm/runtimed_wasm.js";
before(initializeTestRuntimedWasm);

import { sync, fixture } from "./preview-python-helpers.mjs";

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
    prepareOutputs: createOutputPreparer({
      prepareContent: prepare_output_content,
      putBlob: async () => {
        assert.fail("short stream should stay inline");
      },
    }),
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
  assert.deepEqual(execution.outputs[0].text, { inline: "hello\n" });
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

test("Python exception cancels queued work and permits a later explicit execution", async (t) => {
  const { host, owner, peer, request, publish } = await fixture(t);
  owner.add_cell(1, "queued", "code");
  owner.update_source("queued", "42");
  sync(host, owner, "owner", "owner");
  sync(host, peer, "runtime", "runtime_peer", true, request("owner", "queued").outbound);
  let calls = 0;
  const bridge = new PythonRuntimePeer({
    peer,
    sessionKey: "session",
    isCurrent: () => true,
    publish,
    pool: {
      execute: async () => {
        calls++;
        return { execution_count: calls, success: calls > 1, outputs: [] };
      },
      release: async () => {},
    },
    prepareOutputs: async () => [],
  });
  await bridge.drain();
  assert.equal(calls, 1);
  const states = Object.values(peer.get_runtime_state().executions);
  assert.equal(states.filter((e) => e.status === "cancelled").length, 1);
  assert.equal(states.filter((e) => e.success === false).length, 1);
  sync(host, peer, "runtime", "runtime_peer", true, request().outbound);
  await bridge.drain();
  assert.equal(calls, 2);
  assert.equal(
    Object.values(peer.get_runtime_state().executions).filter((e) => e.success === true).length,
    1,
  );
  await bridge.close();
});
