import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { AutomergeSyncBackend } from "./backend.mjs";
import { DocStore, MemoryByteStore } from "./doc-store.mjs";
import { newId } from "./test-helpers.mjs";

test("refusal evidence retains document and frame identity without trusting stale frames", async () => {
  const evidence = [],
    sent = [];
  let receive;
  const backend = await AutomergeSyncBackend.load({
    store: new DocStore(new MemoryByteStore()),
    onRefusal: (value) => evidence.push(value),
  });
  const doc = A.from({ text: "local" });
  const id = newId();
  await backend.store(id, [{ kind: "document", heads: A.getHeads(doc), blob: A.save(doc) }]);
  backend.addConnection({
    close() {},
    onClose() {},
    onMessage(fn) {
      receive = fn;
    },
    send(frame) {
      sent.push(frame);
    },
  });
  const r = sent.at(-1).r;
  receive({
    t: "refused",
    doc: id,
    r: r - 1,
    code: "invalid_page_content",
    message: "older",
    fatal: false,
  });
  assert.equal(evidence[0].correlated, false);
  receive({
    t: "refused",
    doc: id,
    r,
    code: "missing_dependencies",
    message: "missing",
    fatal: false,
  });
  assert.deepEqual(evidence[1], {
    doc: id,
    r,
    code: "missing_dependencies",
    message: "missing",
    fatal: false,
    correlated: true,
  });
  assert.ok(Object.isFrozen(evidence[1]));
  receive({
    t: "refused",
    doc: id,
    r,
    code: "invalid_page_content",
    message: "duplicate",
    fatal: false,
  });
  assert.equal(evidence[2].correlated, false);
  receive({ t: "refused", doc: newId(), r, code: "invalid_page_content" });
  assert.equal(evidence.length, 3);
  const staleReceive = receive;
  backend.addConnection({
    close() {},
    onClose() {},
    onMessage(fn) {
      receive = fn;
    },
    send(frame) {
      sent.push(frame);
    },
  });
  staleReceive({ t: "refused", doc: id, r: sent.at(-1).r, code: "invalid_page_content" });
  assert.equal(evidence.length, 3, "a replaced connection cannot expose evidence");
  const session = backend.open(id);
  const events = session.events[Symbol.asyncIterator]();
  assert.deepEqual((await events.next()).value.records[0].heads, A.getHeads(doc));
  await session.close();
  await backend.close();
});

test("a throwing refusal observer cannot interrupt round settlement", async () => {
  let receive, frame;
  const backend = await AutomergeSyncBackend.load({
    store: new DocStore(new MemoryByteStore()),
    onRefusal: () => {
      throw Error("observer failure");
    },
  });
  backend.addConnection({
    close() {},
    onClose() {},
    onMessage(fn) {
      receive = fn;
    },
    send(value) {
      frame = value;
    },
  });
  const id = newId();
  const round = backend.synchronizeTree(id, { create: true });
  receive({
    t: "refused",
    doc: id,
    r: frame.r,
    code: "invalid_page_content",
    message: "refused",
    fatal: false,
  });
  assert.equal((await round).outcome, "failed");
  await backend.close();
});
