import assert from "node:assert/strict";
import test from "node:test";
import * as A from "@automerge/automerge";
import { PageSession } from "./session.mjs";

function fixture(t, doc, respond) {
  const original = globalThis.fetch;
  const session = new PageSession("receipt-fixture");
  session.handle = { doc: () => doc };
  session.repo = { flush: async () => {} };
  session.receiptRevision = 1;
  session.status = "Saving";
  let requests = 0;
  globalThis.fetch = async (_url, options) => {
    requests++;
    return respond(JSON.parse(options.body).heads, options);
  };
  t.after(() => {
    globalThis.fetch = original;
    clearTimeout(session.savedTimer);
    session.cancelReceiptRetry();
  });
  return { session, requests: () => requests };
}

test("a durable descendant frontier acknowledges the requested older client heads", async (t) => {
  const client = A.from({ text: "before" });
  const server = A.change(A.clone(client), (d) => {
    d.text = "later server edit";
  });
  const requested = A.getHeads(client);
  assert.equal(A.hasHeads(server, requested), true);
  assert.notDeepEqual(A.getHeads(server), requested);
  const { session, requests } = fixture(t, client, (heads) => {
    assert.deepEqual(heads, requested);
    return Response.json({ durableHeads: A.getHeads(server) });
  });
  await session.saveReceipt();
  assert.equal(session.status, "Saved");
  assert.deepEqual(session.savedHeads, requested);
  assert.equal(requests(), 1);
  assert.equal(session.receiptRetryTimer, undefined);
});

for (const receipt of [
  null,
  {},
  { durableHeads: null },
  { durableHeads: [] },
  { durableHeads: ["not-a-hash"] },
]) {
  test(`a malformed successful response cannot acknowledge edits: ${JSON.stringify(receipt)}`, async (t) => {
    const { session } = fixture(t, A.from({ text: "not acknowledged" }), () =>
      Response.json(receipt),
    );
    await session.saveReceipt();
    assert.equal(session.status, "Unsaved");
    assert.equal(session.statusRetry, true);
    assert.deepEqual(session.savedHeads, []);
    assert.equal(session.problem, "Invalid durability receipt");
    assert.ok(session.receiptRetryTimer);
  });
}

test("a failed receipt never acknowledges the requested heads", async (t) => {
  const { session } = fixture(t, A.from({ text: "pending" }), () =>
    Response.json({ error: "missing" }, { status: 409 }),
  );
  await session.saveReceipt();
  assert.equal(session.status, "Unsaved");
  assert.deepEqual(session.savedHeads, []);
  assert.ok(session.receiptRetryTimer);
});

test("a stalled durability response times out without acknowledging edits", async (t) => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    assert.equal(milliseconds, 30_000);
    return controller.signal;
  });
  let started;
  const requested = new Promise((resolve) => {
    started = resolve;
  });
  const { session } = fixture(
    t,
    A.from({ text: "pending" }),
    (_heads, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
        started();
      }),
  );
  const saving = session.saveReceipt();
  await requested;
  controller.abort(new DOMException("Durability receipt timed out", "TimeoutError"));
  await saving;
  assert.equal(session.status, "Unsaved");
  assert.deepEqual(session.savedHeads, []);
  assert.ok(session.receiptRetryTimer);
});
