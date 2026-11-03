import assert from "node:assert/strict";
import { test } from "node:test";
import { runTable } from "../shared/machine-test.mjs";
import {
  CONTENT_ACTIVITY_INTERVAL_MS as WINDOW,
  CONTENT_ACTIVITY_KEY,
  CONTENT_ACTIVITY_MAX_BACKOFF_MS,
  ContentActivity,
  changesContent,
  contentActivityMachine,
  laterTime,
  retryDelay,
} from "./content-activity.mjs";

const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const fields = (overrides = {}) => ({
  latest: null,
  durable: null,
  flushedAt: null,
  attempt: 0,
  ...overrides,
});
const idle = (overrides) => ({ name: "idle", ...fields(overrides) });
const waiting = (dueAt, overrides) => ({ name: "waiting", ...fields(overrides), dueAt });
const flushing = (value, overrides) => ({
  name: "flushing",
  ...fields({ latest: value, ...overrides }),
  value,
});

test("the content activity machine covers every state and event", async () => {
  const known = iso(T0);
  const later = iso(T0 + 10_000);
  await runTable(contentActivityMachine, [
    {
      label: "startup takes the stored time as known and durable",
      state: idle(),
      event: { type: "restored", value: known },
      expect: { state: idle({ latest: known, durable: known }), effects: [] },
    },
    {
      case: "window-closed",
      label: "the first change after a quiet window flushes at once",
      state: idle({ latest: known, durable: known }),
      event: { type: "changed", now: T0 + 10_000 },
      expect: {
        state: flushing(later, { durable: known }),
        effects: [{ type: "flush", value: later }],
      },
    },
    {
      case: "window-open",
      label: "a change inside the window waits for its end",
      state: idle({ latest: known, durable: known, flushedAt: T0 }),
      event: { type: "changed", now: T0 + 10_000 },
      expect: {
        state: waiting(T0 + WINDOW, { latest: later, durable: known, flushedAt: T0 }),
        effects: [{ type: "arm", at: T0 + WINDOW }],
      },
    },
    {
      case: "not-newer",
      label: "a clock behind the stored time observes nothing newer",
      state: idle({ latest: later, durable: later, flushedAt: T0 }),
      event: { type: "changed", now: T0 },
      expect: {
        state: idle({ latest: later, durable: later, flushedAt: T0 }),
        effects: [],
        rejected: "not newer than the stored time",
      },
    },
    {
      case: "before-due",
      label: "more changes in the window only move the newest time",
      state: waiting(T0 + WINDOW, { latest: known, flushedAt: T0 }),
      event: { type: "changed", now: T0 + 30_000 },
      expect: {
        state: waiting(T0 + WINDOW, { latest: iso(T0 + 30_000), flushedAt: T0 }),
        effects: [],
      },
    },
    {
      case: "past-due",
      label: "a change after a timer that never fired flushes",
      state: waiting(T0 + WINDOW, { latest: known, flushedAt: T0 }),
      event: { type: "changed", now: T0 + WINDOW + 5 },
      expect: {
        state: flushing(iso(T0 + WINDOW + 5), { flushedAt: T0 }),
        effects: [{ type: "flush", value: iso(T0 + WINDOW + 5) }],
      },
    },
    {
      label: "a change during a flush waits for the flush to finish",
      state: flushing(known),
      event: { type: "changed", now: T0 + 10_000 },
      expect: { state: { ...flushing(known), latest: later }, effects: [] },
    },
    {
      state: idle({ latest: known, durable: known }),
      event: { type: "due", now: T0 + WINDOW },
      expect: {
        state: idle({ latest: known, durable: known }),
        effects: [],
        rejected: "nothing waits",
      },
    },
    {
      case: "early",
      label: "a nudge before the window ends changes nothing",
      state: waiting(T0 + WINDOW, { latest: known, flushedAt: T0 }),
      event: { type: "due", now: T0 + WINDOW - 1 },
      expect: {
        state: waiting(T0 + WINDOW, { latest: known, flushedAt: T0 }),
        effects: [],
        rejected: "not due yet",
      },
    },
    {
      case: "on-time",
      state: waiting(T0 + WINDOW, { latest: later, durable: known, flushedAt: T0 }),
      event: { type: "due", now: T0 + WINDOW },
      expect: {
        state: flushing(later, { durable: known, flushedAt: T0 }),
        effects: [{ type: "flush", value: later }],
      },
    },
    {
      state: flushing(known),
      event: { type: "due", now: T0 + WINDOW },
      expect: { state: flushing(known), effects: [], rejected: "a flush is running" },
    },
    {
      case: "caught-up",
      state: flushing(known, { attempt: 2 }),
      event: { type: "flushed", now: T0 + 1 },
      expect: { state: idle({ latest: known, durable: known, flushedAt: T0 + 1 }), effects: [] },
    },
    {
      case: "newer-waits",
      label: "a change during the flush starts the next window",
      state: { ...flushing(known), latest: later },
      event: { type: "flushed", now: T0 + 1 },
      expect: {
        state: waiting(T0 + 1 + WINDOW, { latest: later, durable: known, flushedAt: T0 + 1 }),
        effects: [{ type: "arm", at: T0 + 1 + WINDOW }],
      },
    },
    {
      label: "a failed flush keeps the time and backs off",
      state: flushing(later, { durable: known, flushedAt: T0, attempt: 1 }),
      event: { type: "failed", now: T0 + 5 },
      expect: {
        state: waiting(T0 + 5 + 2 * WINDOW, {
          latest: later,
          durable: known,
          flushedAt: T0,
          attempt: 2,
        }),
        effects: [{ type: "arm", at: T0 + 5 + 2 * WINDOW }],
      },
    },
  ]);
});

test("retries back off to a cap, and later times compare as ISO strings", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(retryDelay), [
    60_000,
    120_000,
    240_000,
    480_000,
    CONTENT_ACTIVITY_MAX_BACKOFF_MS,
    CONTENT_ACTIVITY_MAX_BACKOFF_MS,
  ]);
  assert.equal(laterTime(null, null), null);
  assert.equal(laterTime(iso(T0), null), iso(T0));
  assert.equal(laterTime("garbage", iso(T0)), iso(T0));
  assert.equal(laterTime(iso(T0 + 1), iso(T0)), iso(T0 + 1));
});

test("only title and block patches count as content", () => {
  assert.equal(changesContent([{ action: "put", path: ["title"], value: "x" }]), true);
  assert.equal(changesContent([{ action: "splice", path: ["blocks", "b1", "text", 0] }]), true);
  for (const path of [["comments", "t1"], ["schema", "features", 0], ["page_id"]])
    assert.equal(changesContent([{ action: "put", path }]), false, path.join("/"));
  assert.equal(changesContent([]), false);
  assert.equal(changesContent(undefined), false);
});

class Storage {
  values = new Map();
  puts = 0;
  failPut = false;
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (this.failPut) throw Error("injected storage failure");
    this.puts++;
    this.values.set(key, structuredClone(value));
  }
}

/** A tracker on mocked time. `reports` collects every reported value. */
function tracker(t, { storage = new Storage(), report, clock = true } = {}) {
  if (clock) t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: T0 });
  const reports = [];
  const held = [];
  const activity = new ContentActivity({
    storage,
    report: report ?? (async (value) => reports.push(value)),
    hold: (work) => held.push(work),
    onError: () => {},
  });
  const settle = async () => {
    while (held.length) await Promise.allSettled(held.splice(0));
  };
  return { activity, storage, reports, settle };
}

test("edits coalesce to one write and one report per window", async (t) => {
  const { activity, storage, reports, settle } = tracker(t);
  await activity.restore();
  activity.changed();
  await settle();
  assert.deepEqual(reports, [iso(T0)], "the first change reports at once");
  assert.equal(storage.puts, 1);
  // A minute of typing, a change every 250 ms.
  for (let step = 1; step <= 240; step++) {
    t.mock.timers.tick(250);
    activity.changed();
    await settle();
  }
  // The window closed at T0 + 60 s, just before that tick's change: one
  // flush there carried the newest time it had seen.
  assert.deepEqual(reports, [iso(T0), iso(T0 + WINDOW - 250)]);
  assert.equal(storage.puts, 2);
  assert.equal(activity.value, iso(T0 + 240 * 250));
  assert.equal(activity.state.name, "waiting");
  t.mock.timers.tick(WINDOW);
  await settle();
  assert.deepEqual(reports, [iso(T0), iso(T0 + WINDOW - 250), iso(T0 + 240 * 250)]);
  assert.equal(storage.puts, 3, "three writes for a minute of typing plus its tail");
  assert.deepEqual(storage.values.get(CONTENT_ACTIVITY_KEY), {
    content_updated_at: iso(T0 + 240 * 250),
  });
  assert.equal(activity.state.name, "idle");
  // Quiet: nothing more is written.
  t.mock.timers.tick(10 * WINDOW);
  await settle();
  assert.equal(storage.puts, 3);
});

test("a stored time survives a restart and a lost timer is nudged", async (t) => {
  const { activity, storage, reports, settle } = tracker(t);
  await activity.restore();
  activity.changed();
  await settle();
  t.mock.timers.tick(1000);
  activity.changed();
  // The host goes away before the trailing flush: one window is lost.
  activity.stop();
  const restarted = new ContentActivity({
    storage,
    report: async (value) => reports.push(value),
    hold: () => {},
  });
  await restarted.restore();
  assert.equal(restarted.value, iso(T0), "the stored time lags by at most one window");
  assert.equal(restarted.state.durable, iso(T0));
  // A timer that never fires is nudged by the next request after it was due.
  t.mock.timers.tick(5000);
  const second = tracker(t, { storage, clock: false });
  await second.activity.restore();
  second.activity.changed();
  await second.settle();
  t.mock.timers.tick(1000);
  second.activity.changed();
  second.activity.stop(); // the timer is lost
  second.activity.nudge();
  assert.equal(second.activity.state.name, "waiting", "not due yet");
  t.mock.timers.tick(WINDOW);
  second.activity.nudge();
  await second.settle();
  assert.equal(second.activity.state.name, "idle");
  assert.equal(second.reports.at(-1), iso(T0 + 7000));
});

test("a failed flush retries with backoff and never loses the newest time", async (t) => {
  let fail = true;
  const reports = [];
  const { activity, storage, settle } = tracker(t, {
    report: async (value) => {
      if (fail) throw Error("injected report failure");
      reports.push(value);
    },
  });
  await activity.restore();
  activity.changed();
  await settle();
  assert.equal(activity.state.name, "waiting");
  assert.equal(activity.state.attempt, 1);
  t.mock.timers.tick(WINDOW - 1);
  await settle();
  assert.equal(activity.state.attempt, 1, "not retried before its backoff");
  t.mock.timers.tick(1);
  await settle();
  assert.equal(activity.state.attempt, 2);
  assert.equal(activity.state.dueAt, T0 + WINDOW + 2 * WINDOW);
  fail = false;
  t.mock.timers.tick(2 * WINDOW);
  await settle();
  assert.deepEqual(reports, [iso(T0)]);
  assert.equal(activity.state.name, "idle");
  assert.equal(storage.values.get(CONTENT_ACTIVITY_KEY).content_updated_at, iso(T0));
  storage.failPut = true;
  t.mock.timers.tick(WINDOW);
  activity.changed();
  await settle();
  assert.equal(activity.state.name, "waiting", "a storage failure retries too");
  assert.equal(reports.length, 1, "nothing is reported before it is stored");
});
