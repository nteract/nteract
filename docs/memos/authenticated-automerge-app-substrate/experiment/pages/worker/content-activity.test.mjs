import assert from "node:assert/strict";
import { test } from "node:test";
import { runTable } from "../shared/machine-test.mjs";
import {
  CONTENT_ACTIVITY_INTERVAL_MS as WINDOW,
  CONTENT_ACTIVITY_KEY,
  CONTENT_ACTIVITY_MAX_BACKOFF_MS,
  CONTENT_ACTIVITY_MAX_SKEW_MS as SKEW,
  ContentActivity,
  acceptedTime,
  changesContent,
  contentActivityMachine,
  laterTime,
  retryDelay,
  validTime,
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
const stopped = (overrides) => ({ name: "stopped", ...fields(overrides) });
const refused = (state) => ({ state, effects: [], rejected: "the Page host stopped" });

test("the content activity machine covers every state and event", async () => {
  const known = iso(T0);
  const later = iso(T0 + 10_000);
  await runTable(contentActivityMachine, [
    {
      case: "stored",
      label: "startup takes the stored time as known and durable",
      state: idle(),
      event: { type: "restored", value: known, now: T0 },
      expect: { state: idle({ latest: known, durable: known }), effects: [] },
    },
    {
      case: "ahead",
      label: "a stored time from a clock running ahead is ignored",
      state: idle(),
      event: { type: "restored", value: iso(T0 + SKEW + 1), now: T0 },
      expect: { state: idle(), effects: [], rejected: "the stored time is ahead of this clock" },
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
    ...[
      idle({ latest: known, durable: known }),
      waiting(T0 + WINDOW, { latest: later, durable: known, flushedAt: T0 }),
      flushing(later, { durable: known }),
    ].map((state) => ({
      label: `stopping from ${state.name} cancels the timer and anything deferred`,
      state,
      event: { type: "stop" },
      expect: {
        state: stopped({
          latest: state.latest,
          durable: state.durable,
          flushedAt: state.flushedAt,
        }),
        effects: [{ type: "cancel" }],
      },
    })),
    ...[
      { type: "restored", value: known, now: T0 },
      { type: "changed", now: T0 + WINDOW },
      { type: "due", now: T0 + WINDOW },
      { type: "flushed", now: T0 + 1 },
      { type: "failed", now: T0 + 1 },
      { type: "stop" },
    ].map((event) => ({
      label: `a stopped host refuses ${event.type}`,
      state: stopped({ latest: later, durable: known }),
      event,
      expect: refused(stopped({ latest: later, durable: known })),
    })),
  ]);
});

test("times have exactly one format, and a writer drops one too far ahead of its clock", () => {
  assert.equal(validTime("2026-11-01T00:00:00.000Z"), true);
  for (const value of [
    "2026-11-01T00:00:00Z",
    "2026-11-01T00:00:00.0Z",
    "2026-11-01T00:00:00.000000Z",
    "2026-11-01T00:00:00.000+00:00",
    "2026-13-01T00:00:00.000Z",
    1793500000000,
    null,
  ])
    assert.equal(validTime(value), false, String(value));
  // Lexical order is time order only within one format.
  assert.equal(
    laterTime("2026-11-01T00:00:00.5Z", "2026-11-01T00:00:00.100Z"),
    "2026-11-01T00:00:00.100Z",
  );
  assert.equal(acceptedTime(iso(T0 + SKEW), T0), iso(T0 + SKEW));
  assert.equal(acceptedTime(iso(T0 + SKEW + 1), T0), null);
  assert.equal(acceptedTime(iso(T0 - 1), T0), iso(T0 - 1));
  assert.equal(acceptedTime("garbage", T0), null);
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

/** A tracker on mocked time. `reports` collects every reported value and
 * `held` every piece of work held on the calling request. With `loseTimers`,
 * timers never fire, as celld drops them with the request that set them. */
function tracker(t, { storage = new Storage(), report, clock = true, loseTimers = false } = {}) {
  if (clock) t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: T0 });
  const reports = [];
  const held = [];
  const activity = new ContentActivity({
    storage,
    report: report ?? (async (value) => reports.push(value)),
    hold: (work) => held.push(work),
    onError: () => {},
    ...(loseTimers && { setTimer: () => ({}), clearTimer: () => {} }),
  });
  // Flushes settle in a few turns; held window timers settle when they fire.
  const settle = async () => {
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  /** A change the request that made it pumps, as a tool edit is. */
  const edit = () => {
    activity.changed();
    activity.pump();
  };
  return { activity, storage, reports, settle, held, edit };
}

test("edits coalesce to one write and one report per window", async (t) => {
  const { activity, storage, reports, settle, edit } = tracker(t);
  await activity.restore();
  edit();
  await settle();
  assert.deepEqual(reports, [iso(T0)], "the first change reports at once");
  assert.equal(storage.puts, 1);
  // A minute of typing, a change every 250 ms.
  for (let step = 1; step <= 240; step++) {
    t.mock.timers.tick(250);
    edit();
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

test("a change observed outside a live request waits for one to run its effects", async (t) => {
  const { activity, storage, reports, settle, held } = tracker(t);
  await activity.restore();
  // The repository's loop observes the change: nothing is stored or held,
  // because work started there would never settle on celld.
  activity.changed();
  await settle();
  assert.equal(activity.value, iso(T0));
  assert.equal(activity.state.name, "flushing");
  assert.equal(activity.pending, true);
  assert.deepEqual([storage.puts, reports.length, held.length], [0, 0, 0]);
  // The next request runs it.
  activity.pump();
  await settle();
  assert.deepEqual(reports, [iso(T0)]);
  assert.equal(activity.pending, false);
  assert.equal(held.length, 1, "the flush is held on the request that ran it");
  // A change inside the window: the request arms the window's timer and holds
  // it until it fires, so the trailing flush runs in that request too.
  t.mock.timers.tick(1000);
  activity.changed();
  activity.pump();
  assert.equal(activity.state.name, "waiting");
  assert.equal(held.length, 2);
  let fired = false;
  void held[1].then(() => {
    fired = true;
  });
  await settle();
  assert.equal(fired, false);
  t.mock.timers.tick(WINDOW - 1000);
  await settle();
  assert.equal(fired, true);
  assert.deepEqual(reports, [iso(T0), iso(T0 + 1000)]);
});

test("a resident socket's request serves changes until it closes", async (t) => {
  const { activity, reports, settle } = tracker(t);
  await activity.restore();
  let close;
  const closed = new Promise((resolve) => {
    close = resolve;
  });
  const serving = activity.serve(closed);
  activity.changed();
  await settle();
  assert.deepEqual(reports, [iso(T0)], "the socket's loop ran the flush");
  close();
  await serving;
  t.mock.timers.tick(WINDOW);
  activity.changed();
  await settle();
  assert.deepEqual(reports, [iso(T0)], "nothing serves after the socket closed");
  assert.equal(activity.pending, true);
});

test("a stored time survives a restart and a lost timer is nudged", async (t) => {
  const { activity, storage, reports, settle, edit } = tracker(t);
  await activity.restore();
  edit();
  await settle();
  t.mock.timers.tick(1000);
  activity.changed();
  // The host goes away before the trailing flush: one window is lost.
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
  const second = tracker(t, { storage, clock: false, loseTimers: true });
  await second.activity.restore();
  second.edit();
  await second.settle();
  t.mock.timers.tick(1000);
  second.edit();
  second.activity.nudge();
  assert.equal(second.activity.state.name, "waiting", "not due yet");
  t.mock.timers.tick(WINDOW);
  await second.settle();
  assert.equal(second.activity.state.name, "waiting", "the timer was lost");
  second.activity.pump();
  await second.settle();
  assert.equal(second.activity.state.name, "idle");
  assert.equal(second.reports.at(-1), iso(T0 + 7000));
});

test("stopping is terminal: a running flush, a later change and a nudge write nothing", async (t) => {
  let release;
  const reports = [];
  const { activity, storage, settle, held, edit } = tracker(t, {
    report: (value) =>
      new Promise((resolve) => {
        release = () => {
          reports.push(value);
          resolve();
        };
      }),
  });
  await activity.restore();
  edit();
  await settle();
  assert.equal(activity.state.name, "flushing");
  activity.changed();
  activity.stop();
  assert.equal(activity.state.name, "stopped");
  release();
  await settle();
  assert.equal(activity.state.name, "stopped", "the flush's outcome is refused");
  const puts = storage.puts;
  t.mock.timers.tick(10 * WINDOW);
  activity.changed();
  activity.pump();
  activity.nudge();
  await settle();
  assert.equal(storage.puts, puts, "nothing stored after stop");
  assert.equal(activity.pending, false);
  assert.equal(held.length, 1, "only the flush that was already running");
  // A stop with an armed window timer releases its hold.
  const second = tracker(t, { clock: false });
  await second.activity.restore();
  second.edit();
  await second.settle();
  t.mock.timers.tick(1000);
  second.edit();
  assert.equal(second.activity.state.name, "waiting");
  second.activity.stop();
  await Promise.all(second.held);
  t.mock.timers.tick(WINDOW);
  await second.settle();
  assert.equal(second.reports.length, 1);
  // A serve loop ends.
  await second.activity.serve(new Promise(() => {}));
});

test("a failed flush retries with backoff and never loses the newest time", async (t) => {
  let fail = true;
  const reports = [];
  const { activity, storage, settle, edit } = tracker(t, {
    report: async (value) => {
      if (fail) throw Error("injected report failure");
      reports.push(value);
    },
  });
  await activity.restore();
  edit();
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
  edit();
  await settle();
  assert.equal(activity.state.name, "waiting", "a storage failure retries too");
  assert.equal(reports.length, 1, "nothing is reported before it is stored");
});

test("a stored time from a clock running ahead doesn't hold back real changes", async (t) => {
  const storage = new Storage();
  storage.values.set(CONTENT_ACTIVITY_KEY, { content_updated_at: iso(T0 + 3_600_000) });
  const { activity, reports, settle, edit } = tracker(t, { storage });
  await activity.restore();
  assert.equal(activity.value, null);
  edit();
  await settle();
  assert.deepEqual(reports, [iso(T0)]);
});
