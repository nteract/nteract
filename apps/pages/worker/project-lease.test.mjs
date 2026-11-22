import assert from "node:assert/strict";
import { test } from "node:test";
import { runTable } from "../shared/machine-test.mjs";
import {
  PROJECT_LEASE_RENEW_AHEAD_MS as AHEAD,
  PROJECT_LEASE_RETRY_MS as RETRY,
  ProjectLease,
  projectLeaseMachine,
  renewAt,
} from "./project-lease.mjs";

const T0 = 100_000;
const idle = (token = 0) => ({ name: "idle", token });
const armed = (validUntil, at, token = 0) => ({ name: "armed", token, validUntil, at });
const refreshing = (validUntil, token = 1) => ({ name: "refreshing", token, validUntil });
const stopped = (token = 0) => ({ name: "stopped", token });
const refused = (state, rejected) => ({ state, effects: [], rejected });

test("the project lease machine covers every state, event and guard case", async () => {
  const lease1 = T0 + 60_000;
  const lease2 = T0 + 120_000;
  const earlier = T0 + 45_000;
  await runTable(projectLeaseMachine, [
    // idle
    {
      label: "first Project-bound socket arms renewal ahead of validUntil",
      state: idle(),
      event: { type: "leaseBound", validUntil: lease1, now: T0 },
      expect: {
        state: armed(lease1, lease1 - AHEAD),
        effects: [{ type: "arm", at: lease1 - AHEAD }],
      },
    },
    {
      label: "due while idle is rejected",
      state: idle(),
      event: { type: "due", now: T0 },
      expect: refused(idle(), "no lease is armed"),
    },
    {
      label: "resolved while idle is rejected",
      state: idle(),
      event: { type: "resolved", token: 0, validUntil: lease1, now: T0 },
      expect: refused(idle(), "no refresh is running"),
    },
    {
      label: "unavailable while idle is rejected",
      state: idle(),
      event: { type: "unavailable", token: 0, now: T0 },
      expect: refused(idle(), "no refresh is running"),
    },
    {
      label: "socketsGone while idle is rejected",
      state: idle(),
      event: { type: "socketsGone" },
      expect: refused(idle(), "already idle"),
    },
    {
      label: "stop from idle cancels and enters stopped",
      state: idle(2),
      event: { type: "stop" },
      expect: { state: stopped(2), effects: [{ type: "cancel" }] },
    },

    // armed
    {
      case: "unchanged",
      label: "same validUntil while armed is rejected",
      state: armed(lease1, lease1 - AHEAD),
      event: { type: "leaseBound", validUntil: lease1, now: T0 + 1000 },
      expect: refused(armed(lease1, lease1 - AHEAD), "already armed for this lease"),
    },
    {
      case: "later",
      label: "a newer validUntil while armed moves the renewal forward",
      state: armed(lease1, lease1 - AHEAD),
      event: { type: "leaseBound", validUntil: lease2, now: T0 + 2000 },
      expect: {
        state: armed(lease2, lease2 - AHEAD),
        effects: [{ type: "arm", at: lease2 - AHEAD }],
      },
    },
    {
      case: "earlier-rearm",
      label: "an earlier validUntil pulls the renewal timer forward",
      state: armed(lease1, lease1 - AHEAD),
      event: { type: "leaseBound", validUntil: earlier, now: T0 + 1000 },
      expect: {
        state: armed(earlier, earlier - AHEAD),
        effects: [{ type: "arm", at: earlier - AHEAD }],
      },
    },
    {
      case: "earlier-keep",
      label: "an earlier validUntil whose renewAt is not earlier keeps the existing timer",
      state: armed(lease1, T0 + 2000),
      event: { type: "leaseBound", validUntil: earlier, now: T0 + 1000 },
      expect: {
        state: armed(earlier, T0 + 2000),
        effects: [],
      },
    },
    {
      case: "early",
      label: "due before the armed time is rejected",
      state: armed(lease1, lease1 - AHEAD),
      event: { type: "due", now: lease1 - AHEAD - 1 },
      expect: refused(armed(lease1, lease1 - AHEAD), "not due yet"),
    },
    {
      case: "on-time",
      label: "due at the armed time enters refreshing with an incremented token",
      state: armed(lease1, lease1 - AHEAD, 3),
      event: { type: "due", now: lease1 - AHEAD },
      expect: {
        state: refreshing(lease1, 4),
        effects: [{ type: "resolve", token: 4 }],
      },
    },
    {
      label: "resolved while armed is rejected",
      state: armed(lease1, lease1 - AHEAD),
      event: { type: "resolved", token: 0, validUntil: lease2, now: T0 },
      expect: refused(armed(lease1, lease1 - AHEAD), "no refresh is running"),
    },
    {
      label: "unavailable while armed is rejected",
      state: armed(lease1, lease1 - AHEAD),
      event: { type: "unavailable", token: 0, now: T0 },
      expect: refused(armed(lease1, lease1 - AHEAD), "no refresh is running"),
    },
    {
      label: "socketsGone while armed cancels the timer and returns to idle",
      state: armed(lease1, lease1 - AHEAD, 1),
      event: { type: "socketsGone" },
      expect: { state: idle(1), effects: [{ type: "cancel" }] },
    },
    {
      label: "stop while armed cancels the timer",
      state: armed(lease1, lease1 - AHEAD, 1),
      event: { type: "stop" },
      expect: { state: stopped(1), effects: [{ type: "cancel" }] },
    },

    // refreshing
    {
      case: "later",
      label: "a newer validUntil while refreshing updates the tracked deadline",
      state: refreshing(lease1, 1),
      event: { type: "leaseBound", validUntil: lease2, now: T0 + 10_000 },
      expect: { state: refreshing(lease2, 1), effects: [] },
    },
    {
      case: "not-later",
      label: "a same-or-older validUntil while refreshing is rejected",
      state: refreshing(lease1, 1),
      event: { type: "leaseBound", validUntil: lease1, now: T0 + 10_000 },
      expect: refused(refreshing(lease1, 1), "a refresh is already running"),
    },
    {
      label: "due while refreshing is rejected",
      state: refreshing(lease1, 1),
      event: { type: "due", now: lease1 },
      expect: refused(refreshing(lease1, 1), "a refresh is already running"),
    },
    {
      case: "stale",
      label: "resolved with an old token is rejected",
      state: refreshing(lease1, 2),
      event: { type: "resolved", token: 1, validUntil: lease2, now: T0 + 10_000 },
      expect: refused(refreshing(lease1, 2), "stale refresh outcome"),
    },
    {
      case: "still-bound",
      label: "resolved with a new validUntil arms the next renewal",
      state: refreshing(lease1, 2),
      event: { type: "resolved", token: 2, validUntil: lease2, now: T0 + 10_000 },
      expect: {
        state: armed(lease2, lease2 - AHEAD, 2),
        effects: [{ type: "arm", at: lease2 - AHEAD }],
      },
    },
    {
      case: "unbound",
      label: "resolved with null returns to idle",
      state: refreshing(lease1, 2),
      event: { type: "resolved", token: 2, validUntil: null, now: T0 + 10_000 },
      expect: { state: idle(2), effects: [] },
    },
    {
      case: "stale",
      label: "unavailable with an old token is rejected",
      state: refreshing(lease1, 2),
      event: { type: "unavailable", token: 1, now: T0 + 10_000 },
      expect: refused(refreshing(lease1, 2), "stale refresh outcome"),
    },
    {
      case: "retry",
      label: "unavailable with room left in the lease arms a 1 s retry",
      state: refreshing(lease1, 2),
      event: { type: "unavailable", token: 2, now: lease1 - RETRY - 500 },
      expect: {
        state: armed(lease1, lease1 - 500, 2),
        effects: [{ type: "arm", at: lease1 - 500 }],
      },
    },
    {
      case: "no-room",
      label: "unavailable with no room for another retry before validUntil returns to idle",
      state: refreshing(lease1, 2),
      event: { type: "unavailable", token: 2, now: lease1 - RETRY },
      expect: { state: idle(2), effects: [] },
    },
    {
      label: "socketsGone while refreshing returns to idle and fences the in-flight reply",
      state: refreshing(lease1, 2),
      event: { type: "socketsGone" },
      expect: { state: idle(2), effects: [{ type: "cancel" }] },
    },
    {
      label: "stop while refreshing enters stopped",
      state: refreshing(lease1, 2),
      event: { type: "stop" },
      expect: { state: stopped(2), effects: [{ type: "cancel" }] },
    },

    // stopped
    {
      label: "stopped refuses leaseBound",
      state: stopped(),
      event: { type: "leaseBound", validUntil: lease1, now: T0 },
      expect: refused(stopped(), "the Project lease runner stopped"),
    },
    {
      label: "stopped refuses due",
      state: stopped(),
      event: { type: "due", now: T0 },
      expect: refused(stopped(), "the Project lease runner stopped"),
    },
    {
      label: "stopped refuses resolved",
      state: stopped(),
      event: { type: "resolved", token: 0, validUntil: lease1, now: T0 },
      expect: refused(stopped(), "the Project lease runner stopped"),
    },
    {
      label: "stopped refuses unavailable",
      state: stopped(),
      event: { type: "unavailable", token: 0, now: T0 },
      expect: refused(stopped(), "the Project lease runner stopped"),
    },
    {
      label: "stopped refuses socketsGone",
      state: stopped(),
      event: { type: "socketsGone" },
      expect: refused(stopped(), "the Project lease runner stopped"),
    },
    {
      label: "stopped refuses stop",
      state: stopped(),
      event: { type: "stop" },
      expect: refused(stopped(), "the Project lease runner stopped"),
    },
  ]);
  assert.equal(renewAt(T0 + 2_000, T0), T0);
});

function fakeClock(start = T0) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  const setTimer = (fn, delay) => {
    const id = nextId++;
    timers.set(id, { at: now + Math.max(0, delay), fn });
    return id;
  };
  const clearTimer = (id) => timers.delete(id);
  const advance = async (ms) => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    const target = now + ms;
    for (;;) {
      let next = null;
      for (const [id, entry] of timers) {
        if (entry.at <= target && (!next || entry.at < next.entry.at)) next = { id, entry };
      }
      if (!next) break;
      timers.delete(next.id);
      now = next.entry.at;
      next.entry.fn();
      for (let i = 0; i < 6; i++) await Promise.resolve();
    }
    now = target;
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  return { now: () => now, setTimer, clearTimer, advance, count: () => timers.size };
}

test("ProjectLease renews across multiple cycles, retries unavailability, and hands off between sockets", async () => {
  const clock = fakeClock(T0);
  let calls = 0;
  let failNext = 0;
  const runner = new ProjectLease({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    resolve: async () => {
      calls++;
      if (failNext > 0) {
        failNext--;
        throw Object.assign(new Error("project unavailable"), {
          code: "project_policy_unavailable",
        });
      }
      return clock.now() + 60_000;
    },
  });

  let closeA;
  let closeB;
  const doneA = runner.serve(
    new Promise((resolve) => {
      closeA = resolve;
    }),
  );
  const doneB = runner.serve(
    new Promise((resolve) => {
      closeB = resolve;
    }),
  );

  runner.leaseBound(T0 + 60_000);
  await clock.advance(49_999);
  assert.equal(calls, 0);
  await clock.advance(1);
  assert.equal(calls, 1, "renews 10 s before the 60 s lease ends");
  assert.equal(runner.state.name, "armed");
  assert.equal(runner.state.validUntil, T0 + 110_000);

  // Driver socket A closes while socket B stays open: socket B takes over the timer.
  closeA();
  await doneA;
  await clock.advance(50_000);
  assert.equal(calls, 2, "second live socket drives the next renewal");

  // Two transient failures retry at 2 s intervals, then recover before validUntil.
  failNext = 2;
  await clock.advance(50_000);
  assert.equal(calls, 3, "initial attempt fails");
  assert.equal(runner.state.name, "armed");
  await clock.advance(2_000);
  assert.equal(calls, 4, "first retry fails");
  await clock.advance(2_000);
  assert.equal(calls, 5, "second retry succeeds before lease expiry");
  assert.equal(runner.state.validUntil, clock.now() + 60_000);

  // Unavailability exhausting the remaining lease drops to idle cleanly.
  failNext = 10;
  await clock.advance(50_000);
  await clock.advance(10_000);
  assert.equal(runner.state.name, "idle");
  assert.equal(clock.count(), 0);

  closeB();
  await doneB;
});

test("ProjectLease ignores stale in-flight resolution after socketsGone and reconnect", async () => {
  const clock = fakeClock(T0);
  const resolvers = [];
  const runner = new ProjectLease({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    resolve: () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      }),
  });
  let close;
  const done = runner.serve(
    new Promise((resolve) => {
      close = resolve;
    }),
  );
  runner.leaseBound(T0 + 60_000);
  await clock.advance(50_000);
  assert.equal(runner.state.name, "refreshing");
  assert.equal(resolvers.length, 1);

  // All sockets disconnect, then a fresh socket binds and enters a new refresh.
  runner.socketsGone();
  runner.leaseBound(clock.now() + 60_000);
  await clock.advance(50_000);
  assert.equal(resolvers.length, 2);
  assert.equal(runner.state.token, 2);

  // First (stale) refresh resolves with null: must be ignored.
  resolvers[0](null);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(runner.state.name, "refreshing");
  assert.equal(runner.state.token, 2);

  // Second (current) refresh resolves with a new deadline.
  resolvers[1](clock.now() + 60_000);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(runner.state.name, "armed");

  runner.stop();
  close();
  await done;
});

test("ProjectLease re-arms if the runtime fires its timer 1 ms early", async () => {
  let now = T0;
  const scheduled = [];
  let calls = 0;
  const runner = new ProjectLease({
    now: () => now,
    setTimer: (fn, delay) => {
      const entry = { fn, delay, cleared: false };
      scheduled.push(entry);
      return entry;
    },
    clearTimer: (entry) => {
      entry.cleared = true;
    },
    resolve: async () => {
      calls++;
      return now + 15_000;
    },
  });
  let close;
  const done = runner.serve(
    new Promise((resolve) => {
      close = resolve;
    }),
  );
  runner.leaseBound(T0 + 60_000);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(scheduled.length, 1);

  // Fire 1 ms early: must re-arm for the remaining 1 ms instead of dropping the timer.
  now = T0 + 49_999;
  scheduled[0].fn();
  assert.equal(calls, 0);
  assert.equal(runner.state.name, "armed");
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[1].delay, 1);

  // Fire on time: renewal runs.
  now = T0 + 50_000;
  scheduled[1].fn();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(runner.state.name, "armed");

  runner.stop();
  close();
  await done;
});
