// The outbound-sync table through the pure machine, its RxJS interpreter on
// virtual time, and PageSession's use of it: the lifecycle flushes, caret
// publication and the save receipt.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { VirtualTimeScheduler } from "rxjs";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import {
  OUTBOUND_DEBOUNCE_MS,
  OUTBOUND_MAX_WAIT_MS,
  outboundSyncMachine,
} from "./outbound-sync-machine.mjs";
import { OutboundSync } from "./outbound-sync.mjs";
import { PageSession } from "./session.mjs";

const TABLE = new URL("../test/fixtures/machines/outbound-sync.json", import.meta.url);

test("the outbound-sync table runs through the pure machine", async () => {
  assert.deepEqual(await runTable(outboundSyncMachine, loadTable(TABLE)), {
    rows: 14,
    pairs: 12,
    unreachable: 0,
    cases: 3,
  });
});

/** An OutboundSync on virtual time that records when each tree's round and
 * each caret went out. */
function harness() {
  const scheduler = new VirtualTimeScheduler();
  const errors = [];
  const outbound = new OutboundSync({ scheduler, onError: (error) => errors.push(error) });
  const sent = [];
  const at = (time, run) => scheduler.schedule(run, time);
  const store = (tree) =>
    outbound.scheduleLocalSync(tree, () => sent.push([scheduler.now(), tree]));
  return { scheduler, outbound, sent, errors, at, store };
}

test("a pause in typing sends the run one debounce after the last keystroke", () => {
  const { scheduler, sent, at, store } = harness();
  for (const time of [0, 10, 20]) at(time, () => store("page"));
  scheduler.flush();
  assert.equal(OUTBOUND_DEBOUNCE_MS, 30);
  assert.deepEqual(sent, [[20 + OUTBOUND_DEBOUNCE_MS, "page"]]);
});

test("continuous typing still sends at least every maximum wait", () => {
  const { scheduler, sent, at, store } = harness();
  // A key every 20 ms for 400 ms never pauses long enough to debounce.
  for (let time = 0; time < 400; time += 20) at(time, () => store("page"));
  scheduler.flush();
  assert.equal(OUTBOUND_MAX_WAIT_MS, 100);
  assert.deepEqual(
    sent.map(([time]) => time),
    [100, 220, 340, 410],
  );
  // Twenty stores, four rounds; the last waits only for the pause after it.
});

test("a flush sends what waits at once and leaves no timer armed", () => {
  const { scheduler, outbound, sent, at, store } = harness();
  at(0, () => store("page"));
  at(10, () => outbound.flush());
  at(15, () => outbound.flush());
  scheduler.flush();
  assert.deepEqual(sent, [[10, "page"]]);
  assert.equal(outbound.state.name, "idle");
});

test("a send starts every tree's newest round, then publishes only the newest caret", () => {
  const { scheduler, outbound, sent, at, store } = harness();
  const carets = [];
  at(0, () => store("page"));
  at(1, () => outbound.publish(() => carets.push(["old", scheduler.now()])));
  at(2, () => store("comments"));
  at(3, () => outbound.publish(() => carets.push(["new", scheduler.now()])));
  at(4, () => store("page"));
  scheduler.flush();
  assert.deepEqual(sent, [
    [34, "page"],
    [34, "comments"],
  ]);
  assert.deepEqual(carets, [["new", 34]]);
});

test("a callback that throws is reported and the rest of the send still runs", () => {
  const { scheduler, outbound, sent, errors, at, store } = harness();
  at(0, () =>
    outbound.scheduleLocalSync("broken", () => {
      throw Error("native round failed to start");
    }),
  );
  at(1, () => store("page"));
  scheduler.flush();
  assert.deepEqual(sent, [[31, "page"]]);
  assert.deepEqual(
    errors.map((error) => error.message),
    ["native round failed to start"],
  );
});

test("closing sends what waits, then every later store goes out at once", () => {
  const { scheduler, outbound, sent, at, store } = harness();
  at(0, () => store("page"));
  at(5, () => outbound.close());
  at(50, () => store("page"));
  scheduler.flush();
  assert.deepEqual(sent, [
    [5, "page"],
    [50, "page"],
  ]);
  assert.equal(outbound.state.name, "closed");
  assert.equal(scheduler.actions.length, 0, "no timer outlives the close");
});

/** A session on virtual time with its own window and document. */
function sessionHarness(t) {
  const scheduler = new VirtualTimeScheduler();
  const session = new PageSession("outbound-fixture", { scheduler });
  const page = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  session.watchPageLifecycle({ page, document });
  t.after(() => session.unwatchPageLifecycle());
  const sent = [];
  const store = () => session.outbound.scheduleLocalSync("page", () => sent.push(scheduler.now()));
  return { scheduler, session, page, document, sent, store };
}

for (const type of ["blur", "pagehide", "beforeunload"])
  test(`a ${type} sends waiting edits without waiting for the debounce`, (t) => {
    const { scheduler, page, sent, store } = sessionHarness(t);
    scheduler.schedule(store, 0);
    scheduler.schedule(() => page.dispatchEvent(new Event(type)), 5);
    scheduler.flush();
    assert.deepEqual(sent, [5]);
  });

test("hiding the tab sends waiting edits; showing it doesn't", (t) => {
  const { scheduler, document, sent, store } = sessionHarness(t);
  scheduler.schedule(store, 0);
  scheduler.schedule(() => document.dispatchEvent(new Event("visibilitychange")), 5);
  scheduler.schedule(() => {
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  }, 10);
  scheduler.flush();
  assert.deepEqual(sent, [10]);
});

test("closing the session's listeners stops lifecycle flushes", (t) => {
  const { scheduler, session, page, sent, store } = sessionHarness(t);
  session.unwatchPageLifecycle();
  scheduler.schedule(store, 0);
  scheduler.schedule(() => page.dispatchEvent(new Event("blur")), 5);
  scheduler.flush();
  assert.deepEqual(sent, [OUTBOUND_DEBOUNCE_MS]);
});

test("a caret goes out after the debounce, newest value only", (t) => {
  const { scheduler, session } = sessionHarness(t);
  const broadcasts = [];
  session.handle = { broadcast: (message) => broadcasts.push([scheduler.now(), message]) };
  scheduler.schedule(() => session.publishPresence({ block_id: "a" }), 0);
  scheduler.schedule(() => session.publishPresence({ block_id: "b" }), 10);
  scheduler.flush();
  assert.deepEqual(broadcasts, [[40, { kind: "selection", value: { block_id: "b" } }]]);
});

test("a save receipt starts waiting sync rounds before it asks the host", async (t) => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  const scheduler = new VirtualTimeScheduler();
  const session = new PageSession("receipt-fixture", { scheduler });
  const doc = A.from({ text: "typed" });
  const order = [];
  session.handle = { doc: () => doc };
  session.repo = {
    flush: async () => {
      // A store that finished during the flush asks for its round.
      session.outbound.scheduleLocalSync("page", () => order.push("round"));
    },
  };
  session.receiptRevision = 1;
  globalThis.fetch = async () => {
    order.push("receipt");
    return Response.json({ durableHeads: A.getHeads(doc) });
  };
  t.after(() => {
    clearTimeout(session.savedTimer);
    session.cancelReceiptRetry();
  });
  await session.saveReceipt();
  assert.deepEqual(order, ["round", "receipt"]);
  assert.equal(session.status, "Saved");
});
