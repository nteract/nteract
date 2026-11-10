import assert from "node:assert/strict";
import test from "node:test";
import { VirtualTimeScheduler } from "rxjs";
import { CLOCK_PERIOD_MS, Clock } from "./clock.mjs";

/** A scheduler whose clock is also the Clock's `now`. flush() runs every
 * action due up to maxFrames; raising maxFrames advances virtual time. */
function virtualClock() {
  const scheduler = new VirtualTimeScheduler();
  scheduler.maxFrames = 0;
  const advance = (ms) => {
    scheduler.maxFrames += ms;
    scheduler.flush();
  };
  return { scheduler, advance, now: () => scheduler.frame };
}

test("the clock ticks once a minute while connected and stops on disconnect", () => {
  assert.equal(CLOCK_PERIOD_MS, 60_000);
  const { scheduler, advance, now } = virtualClock();
  let time = 1_000;
  const clock = new Clock({ now: () => time + now(), scheduler });
  assert.equal(clock.snapshot(), 1_000);
  const seen = [];
  const subscription = clock.store.state$.subscribe((value) => seen.push(value));
  time = 5_000;
  const disconnect = clock.connect();
  assert.equal(clock.snapshot(), 5_000, "connecting reads the time at once");
  advance(59_999);
  assert.equal(clock.snapshot(), 5_000);
  advance(1);
  assert.equal(clock.snapshot(), 65_000);
  advance(120_000);
  assert.equal(clock.snapshot(), 185_000);
  disconnect();
  advance(600_000);
  assert.equal(clock.snapshot(), 185_000, "a disconnected clock holds still");
  assert.deepEqual(seen, [1_000, 5_000, 65_000, 125_000, 185_000]);
  subscription.unsubscribe();
});

test("a clock reconnected after StrictMode's extra cleanup keeps one interval", () => {
  const { scheduler, advance, now } = virtualClock();
  const reads = [];
  const clock = new Clock({ now: () => (reads.push(now()), now()), scheduler });
  clock.connect()();
  const disconnect = clock.connect();
  reads.length = 0;
  advance(CLOCK_PERIOD_MS);
  assert.deepEqual(reads, [CLOCK_PERIOD_MS], "one tick per period");
  disconnect();
});
