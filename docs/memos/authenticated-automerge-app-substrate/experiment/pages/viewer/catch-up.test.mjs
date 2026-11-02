// The viewer-catch-up table through the pure machine, and its RxJS
// interpreter on virtual time. PageSession's use of it is covered in
// receipt-reconnect.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { VirtualTimeScheduler } from "rxjs";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import {
  CATCH_UP_LIMIT_MS,
  CATCH_UP_SHOW_MS,
  catchingUp,
  viewerCatchUpMachine,
} from "./catch-up-machine.mjs";
import { CatchUp } from "./catch-up.mjs";

const TABLE = new URL("../test/fixtures/machines/viewer-catch-up.json", import.meta.url);

test("the viewer-catch-up table runs through the pure machine", async () => {
  assert.deepEqual(await runTable(viewerCatchUpMachine, loadTable(TABLE)), {
    rows: 51,
    pairs: 36,
    unreachable: 0,
    cases: 25,
  });
});

test("only catchingUp shows", () => {
  for (const name of viewerCatchUpMachine.states)
    assert.equal(catchingUp({ name }), name === "catchingUp", name);
});

const HOST = { page: ["a".repeat(64)], comments: null };
const NEWER = { page: ["b".repeat(64)], comments: null };

/** A CatchUp on virtual time over a fake replica whose held heads the test
 * sets. Records when "Catching up…" starts and stops showing. */
function harness() {
  const scheduler = new VirtualTimeScheduler();
  const held = new Set();
  const shown = [],
    timeouts = [];
  const catchUp = new CatchUp({
    scheduler,
    holds: (frontier) => frontier.page.every((head) => held.has(head)),
    onChange: (showing) => shown.push([scheduler.now(), showing]),
    onTimeout: (attempt) => timeouts.push([scheduler.now(), attempt]),
  });
  const at = (time, run) => scheduler.schedule(run, time);
  // A remote change that lands `heads` in the replica.
  const land = (...heads) => {
    for (const head of heads) held.add(head);
    catchUp.remote();
  };
  return { scheduler, catchUp, shown, timeouts, at, land, held };
}

test("a frontier answered and landed inside the threshold never shows", () => {
  const { scheduler, catchUp, shown, at, land } = harness();
  at(0, () => catchUp.admitted());
  at(80, () => catchUp.answered(1, HOST));
  at(150, () => land());
  at(200, () => land(HOST.page[0]));
  scheduler.flush();
  assert.equal(CATCH_UP_SHOW_MS, 300);
  assert.deepEqual(shown, []);
  assert.deepEqual(catchUp.store.snapshot(), { name: "current", attempt: 1 });
  assert.equal(scheduler.actions.length, 0, "both timers are disarmed");
});

test("a Page already current never shows, and collaborators' changes never bring it", () => {
  const { scheduler, catchUp, shown, at, land, held } = harness();
  held.add(HOST.page[0]);
  at(0, () => catchUp.admitted());
  at(60, () => catchUp.answered(1, HOST));
  for (let time = 400; time < 20_000; time += 700) at(time, () => land("c".repeat(64)));
  scheduler.flush();
  assert.deepEqual(shown, []);
  assert.equal(catchUp.store.snapshot().name, "current");
});

test("a large catch-up shows after the threshold and clears on the change that lands the frontier", () => {
  const { scheduler, catchUp, shown, at, land } = harness();
  at(0, () => catchUp.admitted());
  at(90, () => catchUp.answered(1, HOST));
  for (let time = 100; time < 2400; time += 50) at(time, () => land());
  at(2400, () => land(HOST.page[0]));
  scheduler.flush();
  assert.deepEqual(shown, [
    [CATCH_UP_SHOW_MS, true],
    [2400, false],
  ]);
});

test("changes still streaming before any answer show catch-up; the late answer clears it", () => {
  const { scheduler, catchUp, shown, at, land, held } = harness();
  at(0, () => catchUp.admitted());
  for (let time = 50; time <= 2000; time += 50) at(time, () => land());
  at(2000, () => held.add(HOST.page[0]));
  at(2100, () => catchUp.answered(1, HOST));
  scheduler.flush();
  assert.deepEqual(shown, [
    [350, true],
    [2100, false],
  ]);
});

test("a newer frontier replaces the kept one; only holding the newest clears", () => {
  const { scheduler, catchUp, shown, at, land } = harness();
  at(0, () => catchUp.admitted());
  at(100, () => catchUp.answered(1, HOST));
  at(900, () => catchUp.answered(1, NEWER));
  at(1000, () => land(HOST.page[0]));
  at(1500, () => land(NEWER.page[0]));
  scheduler.flush();
  assert.deepEqual(shown, [
    [CATCH_UP_SHOW_MS, true],
    [1500, false],
  ]);
});

test("a frontier that never arrives stops showing at the limit, quietly", () => {
  const { scheduler, catchUp, shown, timeouts, at, land } = harness();
  at(0, () => catchUp.admitted());
  at(100, () => catchUp.answered(1, HOST));
  for (let time = 400; time < 30_000; time += 400) at(time, () => land());
  scheduler.flush();
  assert.equal(CATCH_UP_LIMIT_MS, 15_000);
  assert.deepEqual(shown, [
    [CATCH_UP_SHOW_MS, true],
    [CATCH_UP_LIMIT_MS, false],
  ]);
  assert.deepEqual(timeouts, [[CATCH_UP_LIMIT_MS, 1]]);
  assert.deepEqual(catchUp.store.snapshot(), { name: "timedOut", attempt: 1 });
});

test("an unanswered socket stops at the limit, so a later collaborator edit shows nothing", () => {
  const { scheduler, catchUp, shown, timeouts, at, land } = harness();
  at(0, () => catchUp.admitted());
  at(CATCH_UP_LIMIT_MS + 5000, () => land());
  scheduler.flush();
  assert.deepEqual(shown, []);
  assert.deepEqual(timeouts, [[CATCH_UP_LIMIT_MS, 1]]);
});

test("an answer to a request sent before a reconnect is ignored", () => {
  const { scheduler, catchUp, shown, at, held } = harness();
  held.add(HOST.page[0]);
  at(0, () => catchUp.admitted());
  at(100, () => catchUp.disconnected());
  at(200, () => catchUp.admitted());
  // The first socket's request answers late; it can't prove the second current.
  at(250, () => catchUp.answered(1, HOST));
  at(260, () => catchUp.answered(2, NEWER));
  at(1200, () => {
    held.add(NEWER.page[0]);
    catchUp.remote();
  });
  scheduler.flush();
  assert.deepEqual(shown, [
    [200 + CATCH_UP_SHOW_MS, true],
    [1200, false],
  ]);
});

test("a disconnect drops both timers; the next socket starts over", () => {
  const { scheduler, catchUp, shown, timeouts, at } = harness();
  at(0, () => catchUp.admitted());
  at(100, () => catchUp.answered(1, HOST));
  at(200, () => catchUp.disconnected());
  scheduler.flush();
  assert.deepEqual(shown, []);
  assert.deepEqual(timeouts, []);
  assert.deepEqual(catchUp.store.snapshot(), { name: "detached", attempt: 1 });
});

test("a holds check that throws counts as not held", () => {
  const scheduler = new VirtualTimeScheduler();
  const catchUp = new CatchUp({
    scheduler,
    holds: () => {
      throw new Error("bad heads");
    },
  });
  catchUp.admitted();
  catchUp.answered(1, HOST);
  assert.deepEqual(catchUp.store.snapshot(), { name: "opening", attempt: 1, frontier: HOST });
  catchUp.close();
});

test("a closed CatchUp fires no timer", () => {
  const { scheduler, catchUp, shown, timeouts, at } = harness();
  at(0, () => catchUp.admitted());
  at(100, () => catchUp.answered(1, HOST));
  at(150, () => catchUp.close());
  scheduler.flush();
  assert.deepEqual(shown, []);
  assert.deepEqual(timeouts, []);
  assert.equal(catchUp.store.snapshot().name, "opening");
});
