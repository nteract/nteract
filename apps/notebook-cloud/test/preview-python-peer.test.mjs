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
        assert.equal(peer.get_runtime_state().queue.executing.execution_id, execution.execution_id);
        assert.equal(peer.get_runtime_state().queue.queued.length, 0);
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
  assert.equal(observer.get_runtime_state().queue.executing, null);
  assert.deepEqual(observer.get_runtime_state().queue.queued, []);
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
  assert.equal(peer.get_runtime_state().queue.executing, null);
  assert.deepEqual(peer.get_runtime_state().queue.queued, []);
  sync(host, peer, "runtime", "runtime_peer", true, request().outbound);
  await bridge.drain();
  assert.equal(calls, 2);
  assert.equal(
    Object.values(peer.get_runtime_state().executions).filter((e) => e.success === true).length,
    1,
  );
  await bridge.close();
});

test("display updates cross executions and clear wait preserves indexed output semantics", async (t) => {
  const { host, owner, peer, request, publish } = await fixture(t);
  for (const id of ["second", "third"]) {
    owner.add_cell(0, id, "code");
    owner.update_source(id, "pass");
  }
  sync(host, owner, "owner", "owner");
  const display = (text, update = false) => ({
    output_type: update ? "update_display_data" : "display_data",
    transient: { display_id: "shared" },
    data: { "text/plain": text },
    metadata: { label: text },
  });
  const batches = [
    [display("before"), display("before")],
    [
      display("after", true),
      { output_type: "stream", name: "stdout", text: "discard" },
      { output_type: "clear_output", wait: true },
      { output_type: "stream", name: "stdout", text: "keep" },
      { output_type: "clear_output", wait: true },
    ],
    [display("temporary"), { output_type: "clear_output", wait: false }, display("final", true)],
  ];
  let count = 0;
  const bridge = new PythonRuntimePeer({
    peer,
    sessionKey: "display",
    isCurrent: () => true,
    publish,
    pool: {
      execute: async () => ({ execution_count: ++count, success: true, outputs: batches.shift() }),
      release: async () => {},
    },
    prepareOutputs: createOutputPreparer({
      prepareContent: prepare_output_content,
      putBlob: async () => assert.fail("inline only"),
    }),
  });
  await bridge.drain();
  const first = Object.values(peer.get_runtime_state().executions)[0];
  const outputIds = first.outputs.map((output) => output.output_id);
  for (const cellId of ["second", "third"]) {
    const accepted = request("owner", cellId);
    sync(host, owner, "owner", "owner", false, accepted.outbound);
    sync(host, peer, "runtime", "runtime_peer", true, accepted.outbound);
    await bridge.drain();
  }
  const observer = new RuntimeStatePeerHandle("user:dev:display-observer/test");
  t.after(() => observer.free());
  sync(host, observer, "display-observer", "viewer", true);
  const executions = Object.values(observer.get_runtime_state().executions);
  const original = executions.find((e) => e.cell_id === "code");
  assert.deepEqual(
    original.outputs.map((o) => o.output_id),
    outputIds,
  );
  assert.deepEqual(
    original.outputs.map((o) => o.data["text/plain"]),
    [{ inline: "final" }, { inline: "final" }],
  );
  assert.deepEqual(
    original.outputs.map((o) => o.metadata),
    [{ label: "final" }, { label: "final" }],
  );
  assert.deepEqual(
    executions.find((e) => e.cell_id === "second").outputs.map((o) => o.text),
    [{ inline: "keep" }],
  );
  assert.deepEqual(executions.find((e) => e.cell_id === "third").outputs, []);
  assert.ok(executions.every((e) => e.status === "done" && e.success));
  await bridge.close();
});
