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
  assert.equal(calls[0].cell_id, "code");
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

test("Interrupt cancels queued work, keeps the interrupted result, and a new Run executes", async (t) => {
  const { host, owner, peer, request, publish } = await fixture(t);
  owner.add_cell(1, "queued", "code");
  owner.update_source("queued", "42");
  sync(host, owner, "owner", "owner");
  sync(host, peer, "runtime", "runtime_peer", true, request("owner", "queued").outbound);
  const calls = [];
  let finish;
  const bridge = new PythonRuntimePeer({
    peer,
    sessionKey: "session",
    isCurrent: () => true,
    publish,
    pool: {
      execute: (_key, execution) => {
        calls.push(execution.cell_id);
        if (calls.length > 1)
          return Promise.resolve({ execution_count: calls.length, success: true, outputs: [] });
        return new Promise((resolve) => {
          finish = () =>
            resolve({
              execution_count: 1,
              success: false,
              outputs: [
                { output_type: "error", ename: "KeyboardInterrupt", evalue: "", traceback: [] },
              ],
            });
        });
      },
      release: async () => {},
    },
    prepareOutputs: async () => [],
  });
  const draining = bridge.drain();
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  await bridge.interrupt();
  const queued = Object.values(peer.get_runtime_state().executions).find(
    (e) => e.cell_id === "queued",
  );
  assert.equal(queued.status, "cancelled");
  finish();
  await draining;
  assert.deepEqual(calls, ["code"]);
  const interrupted = Object.values(peer.get_runtime_state().executions).find(
    (e) => e.cell_id === "code",
  );
  assert.equal(interrupted.status, "error");
  assert.equal(interrupted.success, false);
  // Fresh explicit intent after the interrupt runs normally.
  sync(host, peer, "runtime", "runtime_peer", true, request("owner", "queued").outbound);
  await bridge.drain();
  assert.deepEqual(calls, ["code", "queued"]);
  await bridge.close();
});

test("Interrupt between claiming an entry and invoking Python never runs it", async (t) => {
  const { host, peer } = await fixture(t);
  let bridge;
  let interrupted = false;
  bridge = new PythonRuntimePeer({
    peer,
    sessionKey: "session",
    isCurrent: () => true,
    publish: async () => {
      sync(host, peer, "runtime", "runtime_peer", true);
      if (!interrupted && peer.get_runtime_state().queue.executing) {
        interrupted = true;
        await bridge.interrupt();
      }
    },
    pool: {
      execute: async () => assert.fail("claimed entry ran after Interrupt"),
      release: async () => {},
    },
    prepareOutputs: async () => [],
  });
  await bridge.drain();
  assert.equal(interrupted, true);
  const [execution] = Object.values(peer.get_runtime_state().executions);
  assert.equal(execution.status, "error");
  assert.equal(execution.success, false);
  assert.equal(execution.outputs[0].ename, "KeyboardInterrupt");
  assert.equal(peer.get_runtime_state().queue.executing, null);
  await bridge.close();
});

test("live stream output updates one record in place, then the batch replaces it", async (t) => {
  const { host, peer, publish } = await fixture(t);
  // Read the room host's state through a fresh viewer each time: the harness
  // sync() drops host broadcast frames addressed to other peers, so a
  // long-lived observer here would miss changes it was never forwarded.
  let observers = 0;
  const observed = () => {
    const observer = new RuntimeStatePeerHandle(`user:dev:live-observer-${++observers}/test`);
    try {
      sync(host, observer, `live-observer-${observers}`, "viewer", true);
      return Object.values(observer.get_runtime_state().executions)[0];
    } finally {
      observer.free();
    }
  };
  const snapshots = [];
  let livePublishes = 0;
  const bridge = new PythonRuntimePeer({
    peer,
    sessionKey: "session",
    isCurrent: () => true,
    publish,
    publishLive: async () => {
      livePublishes++;
      sync(host, peer, "runtime", "runtime_peer", true);
    },
    pool: {
      execute: async (_key, _execution, options) => {
        const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
        options.onLive({ type: "stream", name: "stdout", text: "a\n" });
        await settle();
        snapshots.push(observed().outputs.map((o) => [o.output_id, o.text]));
        options.onLive({ type: "stream", name: "stdout", text: "b\n" });
        await settle();
        snapshots.push(observed().outputs.map((o) => [o.output_id, o.text]));
        options.onLive({ type: "boundary" });
        options.onLive({ type: "stream", name: "stdout", text: "c\n" });
        await settle();
        snapshots.push(observed().outputs.map((o) => o.text));
        assert.equal(observed().status, "running");
        return {
          execution_count: 1,
          success: true,
          outputs: [
            { output_type: "stream", name: "stdout", text: "a\nb\n" },
            { output_type: "display_data", data: { "text/plain": "x" }, metadata: {} },
            { output_type: "stream", name: "stdout", text: "c\n" },
          ],
        };
      },
      release: async () => {},
    },
    prepareOutputs: createOutputPreparer({
      prepareContent: prepare_output_content,
      putBlob: async () => assert.fail("inline only"),
    }),
  });
  await bridge.drain();
  assert.ok(livePublishes >= 3, "live changes reach peers without the terminal publish");
  assert.deepEqual(
    snapshots[0].map(([, text]) => text),
    [{ inline: "a\n" }],
  );
  // Same record, grown in place.
  assert.equal(snapshots[1].length, 1);
  assert.equal(snapshots[1][0][0], snapshots[0][0][0]);
  assert.deepEqual(snapshots[1][0][1], { inline: "a\nb\n" });
  assert.deepEqual(snapshots[2], [{ inline: "a\nb\n" }, { inline: "c\n" }]);
  const final = observed();
  assert.equal(final.status, "done");
  assert.deepEqual(
    final.outputs.map((o) => o.output_type),
    ["stream", "display_data", "stream"],
  );
  assert.deepEqual(final.outputs[0].text, { inline: "a\nb\n" });
  await bridge.close();
});

async function liveBridge(t, execute, { blobs = [] } = {}) {
  const { host, peer, publish } = await fixture(t);
  const read = () => {
    const observer = new RuntimeStatePeerHandle(`user:dev:reader-${crypto.randomUUID()}/test`);
    try {
      sync(host, observer, `reader-${crypto.randomUUID()}`, "viewer", true);
      return Object.values(observer.get_runtime_state().executions)[0];
    } finally {
      observer.free();
    }
  };
  const bridge = new PythonRuntimePeer({
    peer,
    sessionKey: "session",
    isCurrent: () => true,
    publish,
    publishLive: async () => sync(host, peer, "runtime", "runtime_peer", true),
    pool: {
      execute: (_key, _execution, options) => execute(options.onLive, read),
      release: async () => {},
    },
    prepareOutputs: createOutputPreparer({
      prepareContent: prepare_output_content,
      putBlob: async (blob) => {
        blobs.push(blob);
      },
    }),
  });
  t.after(() => bridge.close());
  return { bridge, read };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 250));

test("live text over the inline threshold never uploads blobs while running", async (t) => {
  const blobs = [];
  let blobsWhileRunning;
  let liveRecords;
  const long = "x".repeat(99) + "\n";
  const { bridge, read } = await liveBridge(
    t,
    async (onLive, observed) => {
      for (let i = 0; i < 30; i++) onLive({ type: "stream", name: "stdout", text: long });
      await tick();
      liveRecords = observed().outputs;
      blobsWhileRunning = blobs.length;
      return {
        execution_count: 1,
        success: true,
        outputs: [{ output_type: "stream", name: "stdout", text: long.repeat(30) }],
      };
    },
    { blobs },
  );
  await bridge.drain();
  assert.equal(blobsWhileRunning, 0, "live records stay inline");
  assert.ok(liveRecords.length >= 4, "3,000 bytes span several sub-1 KiB live records");
  assert.ok(liveRecords.every((o) => new TextEncoder().encode(o.text.inline).length <= 960));
  assert.equal(liveRecords.map((o) => o.text.inline).join(""), long.repeat(30));
  // Only the final batch may use a blob for the long text.
  const final = read();
  assert.equal(final.outputs.length, 1);
  assert.equal(final.status, "done");
});

test("boundary floods cannot create unbounded live records", async (t) => {
  let observedCount;
  const { bridge } = await liveBridge(t, async (onLive, observed) => {
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 40; i++) {
        onLive({ type: "stream", name: "stdout", text: "y" });
        onLive({ type: "boundary" });
      }
      await tick();
    }
    observedCount = observed().outputs.length;
    return { execution_count: 1, success: true, outputs: [] };
  });
  await bridge.drain();
  assert.ok(observedCount <= 48, `live records capped (saw ${observedCount})`);
});

test("live clear_output clears earlier live records", async (t) => {
  let afterClear;
  let afterWaitClear;
  const { bridge } = await liveBridge(t, async (onLive, observed) => {
    onLive({ type: "stream", name: "stdout", text: "first\n" });
    await tick();
    onLive({ type: "clear", wait: false });
    onLive({ type: "stream", name: "stdout", text: "second\n" });
    await tick();
    afterClear = observed().outputs.map((o) => o.text.inline);
    onLive({ type: "clear", wait: true });
    await tick();
    onLive({ type: "stream", name: "stdout", text: "third\n" });
    await tick();
    afterWaitClear = observed().outputs.map((o) => o.text.inline);
    return { execution_count: 1, success: true, outputs: [] };
  });
  await bridge.drain();
  assert.deepEqual(afterClear, ["second\n"]);
  assert.deepEqual(afterWaitClear, ["third\n"]);
});

test("a failed execution keeps its partial live output with the error", async (t) => {
  const { bridge, read } = await liveBridge(t, async (onLive) => {
    onLive({ type: "stream", name: "stdout", text: "partial\n" });
    await tick();
    throw new Error("Preview Python execution deadline exceeded; restart required");
  });
  await assert.rejects(bridge.drain(), /deadline/);
  const execution = read();
  assert.equal(execution.status, "error");
  assert.deepEqual(execution.outputs[0].text, { inline: "partial\n" });
  assert.equal(execution.outputs.at(-1).output_type, "error");
});
