import assert from "node:assert/strict";
import test from "node:test";
import { concatMap, takeUntil } from "rxjs";
import { TestScheduler } from "rxjs/testing";
import { liveOutputBatches } from "../src/live-output-stream.js";

const stdout = (text) => ({ type: "stream", name: "stdout", text });
const stderr = (text) => ({ type: "stream", name: "stderr", text });
const batch = (...events) => ({ events, stopped: false });
const stopped = { events: [], stopped: true };
const scheduler = () => new TestScheduler((actual, expected) => assert.deepEqual(actual, expected));

test("live windows coalesce adjacent stream writes and preserve clear/display ordering", () => {
  const clock = scheduler();
  clock.run(({ cold, expectObservable }) => {
    const values = {
      a: stdout("a"),
      b: stdout("b"),
      c: stderr("c"),
      d: { type: "clear", wait: true },
      e: { type: "boundary" },
      f: stdout("f"),
    };
    expectObservable(
      liveOutputBatches(cold("abcde-f---|", values), { intervalMs: 5, scheduler: clock }),
    ).toBe("-----x----(y|)", {
      x: batch(stdout("ab"), stderr("c"), values.d, values.e),
      y: batch(stdout("f")),
    });
  });
});

test("overflow stops a structural flood before the next window without retaining its events", () => {
  const clock = scheduler();
  clock.run(({ cold, expectObservable, expectSubscriptions }) => {
    const events = cold("abc---d", {
      a: stdout("a"),
      b: stderr("b"),
      c: stdout("c"),
      d: stdout("d"),
    });
    expectObservable(
      liveOutputBatches(events, { intervalMs: 10, maxPending: 2, scheduler: clock }),
    ).toBe("--(s|)", { s: stopped });
    expectSubscriptions(events.subscriptions).toBe("^-!");
  });
});

test("the guest byte limit stops pending and future live windows", () => {
  const clock = scheduler();
  clock.run(({ cold, expectObservable, expectSubscriptions }) => {
    const events = cold("a-b-s----c", {
      a: stdout("a"),
      b: stdout("b"),
      s: { type: "live_stopped" },
      c: stdout("c"),
    });
    expectObservable(liveOutputBatches(events, { intervalMs: 10, scheduler: clock })).toBe(
      "----(s|)",
      { s: stopped },
    );
    expectSubscriptions(events.subscriptions).toBe("^---!");
  });
});

test("cancellation tears down the timer and ignores late events", () => {
  const clock = scheduler();
  clock.run(({ cold, hot, expectObservable, expectSubscriptions }) => {
    const events = cold("a---b-----c|", { a: stdout("a"), b: stdout("b"), c: stdout("c") });
    expectObservable(
      liveOutputBatches(events, { intervalMs: 5, scheduler: clock }).pipe(takeUntil(hot("---x"))),
    ).toBe("---|");
    expectSubscriptions(events.subscriptions).toBe("^--!");
  });
});

test("ordered publication drains a slow earlier window before the final completion", () => {
  const clock = scheduler();
  clock.run(({ cold, expectObservable }) => {
    const events = cold("a-----b-----|", { a: stdout("a"), b: stdout("b") });
    const published = liveOutputBatches(events, { intervalMs: 5, scheduler: clock }).pipe(
      concatMap((value) => cold("------(x|)", { x: value })),
    );
    expectObservable(published).toBe("-----------x-----(y|)", {
      x: batch(stdout("a")),
      y: batch(stdout("b")),
    });
  });
});
