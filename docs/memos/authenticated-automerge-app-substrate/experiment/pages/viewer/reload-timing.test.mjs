// Virtual-time specs for the drain timeout, navigation cancelling a reload,
// and a reload waiting for its receipt. Inputs and expected outputs are
// marbles; times are milliseconds (TestScheduler run mode).
//
// The harness below drives today's ReloadGate and PageSession on a virtual
// clock: it injects the gate's timers, applies each input at its frame, and
// lets promise continuations run before the clock moves on.
import test from "node:test";
import assert from "node:assert/strict";
import { TestScheduler } from "rxjs/testing";
import * as A from "@automerge/automerge";
import { PageSession } from "./session.mjs";
import { CLOSE_DRAIN_MS, ReloadGate } from "./build-freshness.mjs";
import { createPageData, initializePage } from "../model/page.mjs";

const SAVE_TIMEOUT =
  "Your latest edits haven't saved yet, so Pages won't reload. Check your connection and try again.";
const OUTCOMES = {
  o: { ok: true },
  x: { ok: false, cancelled: true },
  t: { ok: false, message: SAVE_TIMEOUT },
};

const settle = () => new Promise((resolve) => setImmediate(resolve));
const marbles = (spec, values) =>
  TestScheduler.parseMarbles(spec, values, undefined, undefined, true).map(
    ({ frame, notification }) => ({ frame, value: notification.value }),
  );

/** Run `inputs` (name -> marbles) against `actions` on a virtual clock and
 * return what `record` saw, as frames and values. */
async function runOnClock({ inputs, values = {}, start }) {
  let now = 0;
  const timers = new Set();
  const clock = {
    setTimeout: (fn, ms) => {
      const timer = { fn, due: now + ms };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
  };
  const seen = [];
  const actions = await start({ clock, record: (value) => seen.push({ frame: now, value }) });
  const steps = Object.entries(inputs)
    .flatMap(([name, spec]) =>
      marbles(spec, values).map(({ frame, value }) => ({ frame, run: () => actions[name](value) })),
    )
    .sort((a, b) => a.frame - b.frame);
  for (;;) {
    const due = Math.min(steps[0]?.frame ?? Infinity, ...[...timers].map((t) => t.due));
    if (due === Infinity) break;
    now = due;
    for (const timer of [...timers].filter((t) => t.due === now)) {
      timers.delete(timer);
      timer.fn();
    }
    while (steps[0]?.frame === now) steps.shift().run();
    await settle();
  }
  return seen;
}

/** A PageSession whose storage and sockets are recorders. It is saving an
 * edit the host has not acknowledged. */
function savingSession() {
  const pageId = crypto.randomUUID();
  const doc = A.change(A.from(createPageData({ pageId, title: "Garden notes" })), initializePage);
  const session = new PageSession(pageId);
  session.identity = { principal: "dev" };
  session.handle = { doc: () => doc };
  session.repo = { flush: async () => {} };
  session.localPage = { pending: true };
  session.persistLocal = async () => {};
  session.releaseLocal = async () => {};
  session.disconnectSockets = async () => {};
  session.status = "Saving";
  const receipt = () => {
    session.savedHeads = A.getHeads(doc);
    session.localPage = { pending: false };
    session.status = "Saved";
    session.emit();
  };
  const offline = () => {
    session.status = "Offline";
    session.emit();
  };
  return { session, receipt, offline };
}

/** Leave a saving Page; `c` marks the frame its close starts. */
function drain(inputs) {
  return runOnClock({
    inputs,
    async start({ clock, record }) {
      const { session, receipt, offline } = savingSession();
      const gate = new ReloadGate({ timers: clock });
      gate.hold(session);
      const close = session.close.bind(session);
      session.close = () => {
        if (!session.closing) record("c");
        return close();
      };
      return { leave: () => void gate.drainAndClose(session), receipt, offline };
    },
  });
}

test("a left Page closes at its receipt, when it goes offline, or after CLOSE_DRAIN_MS", async () => {
  assert.equal(CLOSE_DRAIN_MS, 10_000);
  assert.deepEqual(await drain({ leave: "a" }), marbles("10s c"));
  assert.deepEqual(await drain({ leave: "a", receipt: "4s r" }), marbles("4s c"));
  assert.deepEqual(await drain({ leave: "a", offline: "2s f" }), marbles("2s c"));
  // A receipt after the drain gave up changes nothing.
  assert.deepEqual(await drain({ leave: "a", receipt: "12s r" }), marbles("10s c"));
});

class FakeSession {
  alive = true;
  deleted = false;
  pending = true;
  status = "Saving";
  savedHeads = [];
  listeners = new Set();
  pauses = new Set();
  doc = { title: "Garden notes" };
  constructor(pageId) {
    this.pageId = pageId;
    this.identity = { principal: "dev" };
  }
  get recoveryPending() {
    return this.pending;
  }
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  set(patch) {
    Object.assign(this, patch);
    for (const fn of this.listeners) fn();
  }
  pauseEdits(reason, paused = true) {
    if (paused) this.pauses.add(reason);
    else this.pauses.delete(reason);
  }
  retryConnection() {}
  queueSaved() {}
  exportRecovery() {
    return { markdown: "", heads: [] };
  }
  async close() {
    this.alive = false;
    this.checkpointWritten = true;
  }
}

/** Reload while Page A saves. `leave` drains A, `open` installs B, `receipt`
 * acknowledges A's edits. The reload's answer is recorded at its frame. */
function reloadWith(inputs) {
  return runOnClock({
    inputs,
    async start({ clock, record }) {
      const gate = new ReloadGate({ timers: clock });
      const a = new FakeSession("page-a");
      gate.hold(a);
      return {
        reload: () =>
          void gate.reload({ reload() {} }).then((result) => {
            record(result);
          }),
        leave: () => void gate.drainAndClose(a),
        open: () => gate.hold(Object.assign(new FakeSession("page-b"), { pending: false })),
        receipt: () => a.set({ pending: false, status: "Saved", savedHeads: ["h1"] }),
      };
    },
  });
}

test("a reload waits for the held Page's receipt, or gives up after SAVE_BEFORE_RELOAD_MS", async () => {
  assert.deepEqual(await reloadWith({ reload: "a", receipt: "3s r" }), marbles("3s o", OUTCOMES));
  assert.deepEqual(await reloadWith({ reload: "a" }), marbles("15s t", OUTCOMES));
});

test("navigation during the wait cancels the reload once everything settles", async () => {
  // Leaving A keeps it saving; the attempt ends with A's receipt, cancelled.
  assert.deepEqual(
    await reloadWith({ reload: "a", leave: "2s l", receipt: "5s r" }),
    marbles("5s x", OUTCOMES),
  );
  // Opening B while A saves cancels too.
  assert.deepEqual(
    await reloadWith({ reload: "a", open: "1s b", receipt: "4s r" }),
    marbles("4s x", OUTCOMES),
  );
  // A Page left mid-wait that never saves: the attempt waits on it as a held
  // save, so its timeout ends the attempt, cancelled, while the Page drains.
  assert.deepEqual(await reloadWith({ reload: "a", leave: "6s l" }), marbles("15s x", OUTCOMES));
});
