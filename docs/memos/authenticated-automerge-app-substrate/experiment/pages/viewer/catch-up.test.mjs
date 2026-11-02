// The viewer-catch-up table through the pure machine, and its RxJS
// interpreter on virtual time. PageSession's use of it is covered in
// receipt-reconnect.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { VirtualTimeScheduler } from "rxjs";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import { CATCH_UP_SHOW_MS, catchingUp, viewerCatchUpMachine } from "./catch-up-machine.mjs";
import { CatchUp } from "./catch-up.mjs";

const TABLE = new URL("../test/fixtures/machines/viewer-catch-up.json", import.meta.url);

test("the viewer-catch-up table runs through the pure machine", async () => {
  assert.deepEqual(await runTable(viewerCatchUpMachine, loadTable(TABLE)), {
    rows: 30,
    pairs: 25,
    unreachable: 0,
    cases: 9,
  });
});

test("only catchingUp shows", () => {
  for (const name of viewerCatchUpMachine.states)
    assert.equal(catchingUp({ name }), name === "catchingUp", name);
});

/** A CatchUp on virtual time that records when "Catching up…" starts and
 * stops showing. */
function harness() {
  const scheduler = new VirtualTimeScheduler();
  const shown = [];
  const catchUp = new CatchUp({
    scheduler,
    onChange: (showing) => shown.push([scheduler.now(), showing]),
  });
  const at = (time, event) => scheduler.schedule(() => catchUp.dispatch(event), time);
  return { scheduler, catchUp, shown, at };
}
const ADMITTED = { type: "admitted" },
  REMOTE = { type: "remote" },
  CURRENT = { type: "acknowledged", current: true },
  BEHIND = { type: "acknowledged", current: false };

test("a catch-up that lands in one burst never shows", () => {
  const { scheduler, catchUp, shown, at } = harness();
  at(0, ADMITTED);
  // The missed changes arrive together; the debounced receipt confirms them
  // a debounce and a round trip later, after the threshold.
  for (const time of [40, 41, 42]) at(time, REMOTE);
  at(420, CURRENT);
  scheduler.flush();
  assert.equal(CATCH_UP_SHOW_MS, 300);
  assert.deepEqual(shown, []);
  assert.equal(catchUp.store.snapshot().name, "current");
});

test("a catch-up confirmed inside the threshold never shows and disarms the timer", () => {
  const { scheduler, catchUp, shown, at } = harness();
  at(0, ADMITTED);
  at(50, REMOTE);
  at(250, CURRENT);
  scheduler.flush();
  assert.deepEqual(shown, []);
  assert.deepEqual(catchUp.store.snapshot(), { name: "current", attempt: 1 });
  assert.equal(scheduler.actions.length, 0);
});

test("changes still streaming after the threshold show catch-up until the host confirms", () => {
  const { scheduler, shown, at } = harness();
  at(0, ADMITTED);
  for (let time = 50; time <= 2000; time += 50) at(time, REMOTE);
  at(2400, CURRENT);
  scheduler.flush();
  assert.deepEqual(shown, [
    [350, true],
    [2400, false],
  ]);
});

test("a receipt showing the host ahead shows catch-up before any change lands", () => {
  const { scheduler, shown, at } = harness();
  at(0, ADMITTED);
  // The first receipt goes out a debounce after admission, before the large
  // missing history has arrived.
  at(400, BEHIND);
  at(2000, REMOTE);
  at(2400, CURRENT);
  scheduler.flush();
  assert.deepEqual(shown, [
    [400, true],
    [2400, false],
  ]);
});

test("a receipt that was already behind shows catch-up at the threshold, not before", () => {
  const { scheduler, shown, at } = harness();
  at(0, ADMITTED);
  at(100, BEHIND);
  at(900, CURRENT);
  scheduler.flush();
  assert.deepEqual(shown, [
    [CATCH_UP_SHOW_MS, true],
    [900, false],
  ]);
});

test("collaborators' changes after catching up never show it", () => {
  const { scheduler, shown, at } = harness();
  at(0, ADMITTED);
  at(350, CURRENT);
  for (let time = 400; time < 5000; time += 120) at(time, REMOTE);
  at(5000, BEHIND);
  scheduler.flush();
  assert.deepEqual(shown, []);
});

test("a disconnect before the threshold drops its timer; the next socket starts over", () => {
  const { scheduler, catchUp, shown, at } = harness();
  at(0, ADMITTED);
  at(100, BEHIND);
  at(200, { type: "disconnected" });
  at(1000, ADMITTED);
  at(1200, CURRENT);
  scheduler.flush();
  // The first socket's evidence went with it; its timer never fired.
  assert.deepEqual(shown, []);
  assert.deepEqual(catchUp.store.snapshot(), { name: "current", attempt: 2 });
});

test("a disconnect mid catch-up hides it; reconnecting needs new evidence", () => {
  const { scheduler, shown, at } = harness();
  at(0, ADMITTED);
  at(400, BEHIND);
  at(800, { type: "disconnected" });
  at(1500, ADMITTED);
  at(1700, REMOTE);
  at(1800, CURRENT);
  scheduler.flush();
  assert.deepEqual(shown, [
    [400, true],
    [800, false],
  ]);
});

test("a closed CatchUp fires no timer", () => {
  const { scheduler, catchUp, shown, at } = harness();
  at(0, ADMITTED);
  at(100, BEHIND);
  scheduler.schedule(() => catchUp.close(), 150);
  scheduler.flush();
  assert.deepEqual(shown, []);
  assert.deepEqual(catchUp.store.snapshot(), { name: "opening", attempt: 1, behind: true });
});
