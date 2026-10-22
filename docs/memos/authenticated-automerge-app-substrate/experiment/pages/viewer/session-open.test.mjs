import test from "node:test";
import assert from "node:assert/strict";
import { PageSession } from "./session.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("an opening timeout is visible while native cleanup drains and retains its identity lock", async (t) => {
  const failure = new DOMException("Opening timed out", "TimeoutError");
  const calls = [];
  let session, finishFlush;
  const flushing = new Promise((resolve) => (finishFlush = resolve));
  t.after(() => finishFlush());
  t.mock.method(PageSession.prototype, "start", async function () {
    session = this;
    this.repo = {
      async flush() {
        calls.push("flush");
        await flushing;
      },
      async shutdown() {
        calls.push("shutdown");
      },
    };
    this.backend = { close: async () => calls.push("backend-close") };
    this.storage = { close: async () => calls.push("storage-close") };
    this.signer = { free: () => calls.push("signer-free") };
    this.local = { release: () => calls.push("identity-release") };
    throw failure;
  });
  let outcome;
  const opening = PageSession.open("remote-page").then(
    () => (outcome = "unexpectedly opened"),
    (error) => (outcome = error),
  );
  await tick();
  assert.equal(outcome, failure, "the original timeout must not wait for storage cleanup");
  assert.equal(session.alive, false, "stale session callbacks are disabled immediately");
  assert.deepEqual(calls, ["flush"], "the identity stays owned while native I/O is pending");
  assert.equal(session.close(), session.closing, "repeated cleanup shares the same drain");
  finishFlush();
  await opening;
  await session.closing;
  assert.deepEqual(calls, [
    "flush",
    "shutdown",
    "backend-close",
    "storage-close",
    "signer-free",
    "identity-release",
  ]);
});

test("failed opening handles background cleanup rejection and still releases local ownership", async (t) => {
  const failure = Error("Document unavailable");
  const calls = [];
  t.mock.method(PageSession.prototype, "start", async function () {
    this.storage = {
      async close() {
        calls.push("storage-close");
        throw Error("IndexedDB close failed");
      },
    };
    this.signer = { free: () => calls.push("signer-free") };
    this.local = { release: () => calls.push("identity-release") };
    throw failure;
  });
  await assert.rejects(PageSession.open("remote-page"), (error) => error === failure);
  // Node's test runner treats any unhandled rejection as a failure. Let the
  // independently running cleanup reject without attaching a test-side catch.
  await tick();
  await tick();
  assert.deepEqual(calls, ["storage-close", "signer-free", "identity-release"]);
});
