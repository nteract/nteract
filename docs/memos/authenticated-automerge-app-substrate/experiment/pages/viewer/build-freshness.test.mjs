import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILD_CHECK_INTERVAL_MS,
  BuildMonitor,
  VISIBLE_RECHECK_MS,
  reloadWhenSaved,
  saveBeforeReload,
} from "./build-freshness.mjs";
import { observeResponses, request } from "./request.mjs";
import { PageSession } from "./session.mjs";

const A = "aaaaaaaaaaaa",
  B = "bbbbbbbbbbbb";

function harness({ advertisement = { build: A, minViewerProtocol: 1 } } = {}) {
  const page = new EventTarget();
  page.visibilityState = "visible";
  const timers = new Map();
  let nextTimer = 0,
    clock = 1_000_000;
  const fetched = [];
  const monitor = new BuildMonitor({
    build: A,
    protocol: 1,
    document: page,
    now: () => clock,
    setInterval: (fn, ms) => {
      timers.set(++nextTimer, { fn, ms });
      return nextTimer;
    },
    clearInterval: (id) => timers.delete(id),
    fetchAdvertisement: async () => {
      fetched.push(clock);
      if (advertisement instanceof Error) throw advertisement;
      return advertisement;
    },
  });
  return {
    monitor,
    fetched,
    timers,
    setAdvertisement: (value) => (advertisement = value),
    advance: (ms) => (clock += ms),
    show: (state) => {
      page.visibilityState = state;
      page.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

test("checks on a slow interval only while the tab is visible", async () => {
  const h = harness();
  h.monitor.start();
  assert.deepEqual(
    [...h.timers.values()].map(({ ms }) => ms),
    [BUILD_CHECK_INTERVAL_MS],
  );
  assert.equal(h.fetched.length, 0, "opening requests already carried the headers");
  h.show("hidden");
  assert.equal(h.timers.size, 0, "no polling while hidden");
  h.advance(VISIBLE_RECHECK_MS);
  h.show("visible");
  await h.monitor.checking;
  assert.equal(h.fetched.length, 1, "regaining visibility checks once");
  assert.equal(h.timers.size, 1);
  // Quick tab switching does not hammer /health.
  h.show("hidden");
  h.show("visible");
  assert.equal(h.fetched.length, 1);
  [...h.timers.values()][0].fn();
  await h.monitor.checking;
  assert.equal(h.fetched.length, 2);
  h.monitor.stop();
  assert.equal(h.timers.size, 0);
});

test("a different build asks for a reload; a raised floor requires one and stops polling", async () => {
  const h = harness({ advertisement: { build: B, minViewerProtocol: 1 } });
  const states = [];
  h.monitor.subscribe(({ state }) => states.push(state));
  h.monitor.start();
  await h.monitor.check();
  assert.deepEqual(h.monitor.getSnapshot(), {
    state: "update",
    server: { build: B, minViewerProtocol: 1 },
  });
  // A host still on the old build during a rolling deploy cannot undo it.
  h.setAdvertisement({ build: A, minViewerProtocol: 1 });
  await h.monitor.check();
  assert.equal(h.monitor.getSnapshot().state, "update");
  h.setAdvertisement({ build: B, minViewerProtocol: 2 });
  await h.monitor.check();
  assert.deepEqual(states, ["update", "required"]);
  assert.equal(h.timers.size, 0);
  h.advance(VISIBLE_RECHECK_MS);
  h.show("visible");
  await h.monitor.check();
  assert.equal(h.fetched.length, 3, "a required reload never polls again");
});

test("failed checks and the same build keep the tab quiet", async () => {
  const h = harness({ advertisement: new Error("offline") });
  let notified = 0;
  h.monitor.subscribe(() => notified++);
  await h.monitor.check();
  h.setAdvertisement({ build: A, minViewerProtocol: 1 });
  await h.monitor.check();
  assert.equal(h.monitor.getSnapshot().state, "current");
  assert.equal(notified, 0);
});

test("headers on ordinary requests are compared without another request", async () => {
  const h = harness();
  const stop = observeResponses(h.monitor.observeHeaders);
  try {
    await request(
      "/api/connect?page=x",
      {},
      {
        fetch: async () =>
          new Response(JSON.stringify({ ok: true }), {
            headers: {
              "content-type": "application/json",
              "X-Pages-Build": B,
              "X-Pages-Min-Viewer-Protocol": "1",
            },
          }),
      },
    );
    assert.equal(h.monitor.getSnapshot().state, "update");
    assert.equal(h.fetched.length, 0);
    // An observer that throws never breaks the request it watches.
    const broken = observeResponses(() => {
      throw new Error("observer bug");
    });
    try {
      assert.deepEqual(
        await request(
          "/api/saved",
          {},
          {
            fetch: async () =>
              new Response("{}", { headers: { "content-type": "application/json" } }),
          },
        ),
        {},
      );
    } finally {
      broken();
    }
  } finally {
    stop();
  }
});

class FakeSession {
  alive = true;
  deleted = false;
  editsPaused = false;
  pending = true;
  status = "Saving";
  listeners = new Set();
  calls = [];
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
  pauseEdits(paused) {
    this.editsPaused = paused;
    this.calls.push(paused ? "pause" : "resume");
  }
  retryConnection(options) {
    this.calls.push(["retry", options]);
  }
  queueSaved() {
    this.calls.push("queueSaved");
  }
}

function manualTimers() {
  const pending = new Set();
  return {
    pending,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms };
      pending.add(timer);
      return timer;
    },
    clearTimeout: (timer) => pending.delete(timer),
    fire() {
      for (const timer of pending) {
        pending.delete(timer);
        timer.fn();
      }
    },
  };
}

test("reload waits for accepted edits to be saved on the host", async () => {
  const session = new FakeSession();
  const timers = manualTimers();
  let reloaded = 0;
  const result = reloadWhenSaved(session, { reload: () => reloaded++, ...timers });
  assert.equal(session.editsPaused, true, "no new edits race the flush");
  assert.deepEqual(session.calls, ["pause", "queueSaved"]);
  // A local checkpoint is not enough: the reload must not depend on it.
  session.set({ status: "Saved locally" });
  await Promise.resolve();
  assert.equal(reloaded, 0);
  session.set({ status: "Saved", pending: false });
  assert.deepEqual(await result, { ok: true });
  assert.equal(reloaded, 1);
  assert.equal(timers.pending.size, 0);
  assert.equal(session.listeners.size, 0);
});

test("reload is immediate with nothing to save, and retries a stalled save", async () => {
  let reloaded = 0;
  assert.deepEqual(await reloadWhenSaved(null, { reload: () => reloaded++ }), { ok: true });
  const saved = new FakeSession();
  saved.set({ pending: false, status: "Saved" });
  assert.deepEqual(await reloadWhenSaved(saved, { reload: () => reloaded++ }), { ok: true });
  assert.equal(reloaded, 2);

  const offline = new FakeSession();
  offline.status = "Offline";
  const timers = manualTimers();
  const result = saveBeforeReload(offline, timers);
  assert.deepEqual(offline.calls, [["retry", { retryReceipt: true }]]);
  offline.set({ status: "Saved", pending: false });
  assert.deepEqual(await result, { ok: true });
});

test("edits that can't be saved block the reload and say why", async () => {
  for (const status of ["Sign in to sync", "Access removed", "Local save failed"]) {
    const session = new FakeSession();
    session.status = status;
    let reloaded = 0;
    const result = await reloadWhenSaved(session, { reload: () => reloaded++ });
    assert.equal(result.ok, false, status);
    assert.match(result.message, /edits/);
    assert.equal(reloaded, 0);
    assert.equal(session.editsPaused, false, "editing resumes after a voluntary attempt");
  }
  // A save that fails mid-wait stops the attempt too.
  const session = new FakeSession();
  const failing = reloadWhenSaved(session, { reload: assert.fail, ...manualTimers() });
  session.set({ status: "Local save failed" });
  assert.equal((await failing).ok, false);
});

test("a save that never finishes times out without reloading", async () => {
  const session = new FakeSession();
  const timers = manualTimers();
  const result = reloadWhenSaved(session, { reload: assert.fail, keepPaused: true, ...timers });
  assert.equal([...timers.pending][0].ms, 15_000);
  timers.fire();
  const { ok, message } = await result;
  assert.equal(ok, false);
  assert.match(message, /haven't saved yet/);
  assert.equal(session.editsPaused, true, "a required reload keeps edits paused");
  assert.equal(session.listeners.size, 0);
});

test("paused edits survive capability refreshes and leave saving alone", () => {
  const session = new PageSession("page");
  session.credentialCanWrite = true;
  session.access = { role: "owner", canWrite: true, canComment: true, canDelete: true };
  session.updateCapabilities();
  assert.equal(session.canWrite, true);
  let emitted = 0;
  session.subscribe(() => emitted++);
  session.pauseEdits(true);
  assert.deepEqual(
    [session.canWrite, session.canComment, session.canDelete],
    [false, false, false],
  );
  assert.throws(() => session.change(() => {}), /read only/);
  // Sign-in and access refreshes recompute capabilities; the pause holds.
  session.updateCapabilities();
  assert.equal(session.canWrite, false);
  session.pauseEdits(true);
  assert.equal(emitted, 1, "repeating a pause does not repaint");
  session.pauseEdits(false);
  assert.equal(session.canWrite, true);
  assert.equal(emitted, 2);
});
