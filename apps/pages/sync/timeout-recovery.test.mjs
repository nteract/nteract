import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { AutomergeSyncBackend } from "./backend.mjs";
import { DocStore, MemoryByteStore } from "./doc-store.mjs";
import { host } from "./test-helpers.mjs";

for (const order of ["refusal-before", "refusal-after", "none", "success-before", "obsolete"])
  test(`timed-out native hello negotiates again before complete: ${order}`, async (t) => {
    const base = A.change(A.init({ actor: "aa".repeat(16) }), { time: 0 }, (d) => {
      d.n = 0;
    });
    const local = A.change(A.clone(base, { actor: "bb".repeat(16) }), { time: 0 }, (d) => {
      d.n = 1;
    });
    const id = "11".repeat(32);
    const h = await host();
    await h.seed(id, "page", base);
    const store = new DocStore(new MemoryByteStore());
    const backend = await AutomergeSyncBackend.load({ store, syncTimeoutMs: 100 });
    await backend.store(id, [{ kind: "document", heads: A.getHeads(local), blob: A.save(local) }]);
    t.after(async () => {
      await backend.close();
      A.free(base);
      A.free(local);
    });
    const outbound = [],
      replies = [],
      trace = [];
    const endpoint = (queue) => ({
      send(f) {
        queue.push(f);
      },
      onMessage(fn) {
        this.receive = fn;
      },
      onClose(fn) {
        this.closed = fn;
      },
      close() {
        this.closed?.();
      },
    });
    let client = endpoint(outbound),
      server = endpoint(replies);
    h.accept(server, { principal: "account:test", role: "editor" });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    backend.addConnection(client);
    const deliverToHost = async () => {
      const frame = outbound.shift();
      assert.ok(frame);
      trace.push({ direction: "client", r: frame.r, null: frame.m === null });
      server.receive(frame);
      await h.durableHeads(id);
      return frame;
    };
    const first = backend.synchronizeTree(id);
    const hello = await deliverToHost();
    assert.equal(A.decodeSyncMessage(hello.m).changes.length, 0);
    const held = replies.shift();
    assert.ok(held.m);
    t.mock.timers.tick(100);
    assert.equal((await first).outcome, "failed");
    const refusal = {
      t: "refused",
      doc: id,
      r: hello.r,
      code: "missing_dependencies",
      fatal: false,
      message: "late",
    };
    if (order === "obsolete") {
      const oldClient = client;
      const replacementClient = endpoint(outbound),
        replacementServer = endpoint(replies);
      h.accept(replacementServer, { principal: "account:test", role: "editor" });
      backend.addConnection(replacementClient);
      oldClient.receive(refusal);
      oldClient.receive(held);
      client = replacementClient;
      server = replacementServer;
    }
    let secondResult;
    const second = backend.synchronizeTree(id).then((value) => {
      secondResult = value;
      return value;
    });
    await deliverToHost();
    if (order === "refusal-before") client.receive(refusal);
    if (order === "success-before") client.receive(held);
    for (const frame of replies.splice(0)) {
      trace.push({ direction: "host", r: frame.r, null: frame.m === null });
      client.receive(frame);
    }
    if (order === "refusal-after") client.receive(refusal);
    for (let i = 0; i < 10 && outbound.length; i++) {
      await deliverToHost();
      for (const frame of replies.splice(0)) {
        trace.push({ direction: "host", r: frame.r, null: frame.m === null });
        client.receive(frame);
      }
    }
    if (!secondResult) t.mock.timers.tick(100);
    const result = await second;
    const durable = await h.durableHeads(id);
    await backend.flush();
    const checkpoint = A.decodeSyncState(await store.syncState(id));
    t.diagnostic(
      JSON.stringify({
        order,
        trace,
        result,
        durable,
        target: A.getHeads(local),
        savedSharedHeads: checkpoint.sharedHeads,
      }),
    );
    assert.equal(outbound.length, 0, "native exchange is bounded");
    assert.equal(result.outcome, "complete");
    assert.deepEqual(
      durable,
      result.checkpoint.heads,
      "host has admitted and persisted the completed target",
    );
    assert.ok(
      checkpoint.sharedHeads.every((head) => durable.includes(head)),
      "saved peer bookkeeping cannot claim unadmitted heads in this graph",
    );
  });
