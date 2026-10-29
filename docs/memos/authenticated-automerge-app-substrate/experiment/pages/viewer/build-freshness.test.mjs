import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILD_CHECK_INTERVAL_MS,
  BuildMonitor,
  VISIBLE_RECHECK_MS,
  LEFT_PAGE_UNSAVED,
  ReloadGate,
  UNSENT_COMMENT,
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
  pending = true;
  status = "Saving";
  listeners = new Set();
  pauses = new Set();
  calls = [];
  constructor(pageId = crypto.randomUUID()) {
    this.pageId = pageId;
    this.identity = { principal: "dev" };
  }
  get recoveryPending() {
    return this.pending;
  }
  get editsPaused() {
    return this.pauses.size > 0;
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
  retryConnection(options) {
    this.calls.push(["retry", options]);
  }
  queueSaved() {
    this.calls.push("queueSaved");
  }
  async close() {
    this.calls.push("close");
    this.alive = false;
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
const settle = () => new Promise((resolve) => setImmediate(resolve));
function gate() {
  const timers = manualTimers();
  let reloaded = 0;
  const reloadGate = new ReloadGate({ timers });
  return {
    timers,
    reloadGate,
    reloaded: () => reloaded,
    reload: () => reloadGate.reload({ reload: () => reloaded++ }),
  };
}

test("reload waits for accepted edits to be saved on the host", async () => {
  const g = gate();
  const session = new FakeSession();
  g.reloadGate.hold(session);
  const result = g.reload();
  assert.deepEqual([...session.pauses], ["reload"], "no new edits race the flush");
  assert.deepEqual(session.calls, ["queueSaved"]);
  // A local checkpoint is not enough: the reload must not depend on it.
  session.set({ status: "Saved locally" });
  await settle();
  assert.equal(g.reloaded(), 0);
  session.set({ status: "Saved", pending: false });
  assert.deepEqual(await result, { ok: true });
  assert.equal(g.reloaded(), 1);
  assert.equal(g.timers.pending.size, 0);
  assert.equal(session.listeners.size, 0);
});

test("reload is immediate with nothing to save, and retries a stalled save", async () => {
  const g = gate();
  assert.deepEqual(await g.reload(), { ok: true });
  const saved = new FakeSession();
  saved.set({ pending: false, status: "Saved" });
  g.reloadGate.hold(saved);
  assert.deepEqual(await g.reload(), { ok: true });
  assert.equal(g.reloaded(), 2);

  const offline = new FakeSession();
  offline.status = "Offline";
  const result = saveBeforeReload(offline, manualTimers());
  assert.deepEqual(offline.calls, [["retry", { retryReceipt: true }]]);
  offline.set({ status: "Saved", pending: false });
  assert.deepEqual(await result, { ok: true });
});

test("edits that can't be saved block the reload and say why", async () => {
  for (const status of ["Sign in to sync", "Access removed", "Local save failed"]) {
    const g = gate();
    const session = new FakeSession();
    session.status = status;
    g.reloadGate.hold(session);
    const result = await g.reload();
    assert.equal(result.ok, false, status);
    assert.match(result.message, /edits/);
    assert.equal(g.reloaded(), 0);
    assert.equal(session.editsPaused, false, "editing resumes after a voluntary attempt");
  }
  // A save that fails mid-wait stops the attempt too.
  const g = gate();
  const session = new FakeSession();
  g.reloadGate.hold(session);
  const failing = g.reload();
  session.set({ status: "Local save failed" });
  assert.equal((await failing).ok, false);
  assert.equal(g.reloaded(), 0);
});

test("a raised floor during a failed reload keeps edits paused", async () => {
  const g = gate();
  const session = new FakeSession();
  g.reloadGate.hold(session);
  const result = g.reload();
  // The floor rises while the optional reload is waiting for its receipt.
  session.pauseEdits("protocol");
  assert.equal([...g.timers.pending][0].ms, 15_000);
  g.timers.fire();
  const { ok, message } = await result;
  assert.equal(ok, false);
  assert.match(message, /haven't saved yet/);
  assert.deepEqual([...session.pauses], ["protocol"], "only the reload's pause is released");
  assert.equal(session.editsPaused, true);
  assert.equal(session.listeners.size, 0);
});

test("unsent comment drafts block the reload until sent or discarded", async () => {
  const g = gate();
  let draft = "Half a thought";
  const stop = g.reloadGate.watchDrafts(() => Boolean(draft));
  assert.deepEqual(await g.reload(), { ok: false, message: UNSENT_COMMENT });
  // A draft typed while edits wait to save also blocks.
  draft = "";
  const session = new FakeSession();
  g.reloadGate.hold(session);
  const waiting = g.reload();
  draft = "Typed during the wait";
  session.set({ status: "Saved", pending: false });
  assert.deepEqual(await waiting, { ok: false, message: UNSENT_COMMENT });
  assert.equal(session.editsPaused, false);
  draft = "";
  assert.deepEqual(await g.reload(), { ok: true });
  stop();
  assert.equal(g.reloadGate.hasDrafts(), false);
});

test("a Page being left keeps saving, and Reload waits for its receipt", async () => {
  const g = gate();
  const left = new FakeSession();
  g.reloadGate.hold(left);
  const closed = g.reloadGate.drainAndClose(left);
  assert.deepEqual(left.calls, [], "still open while its receipt is in flight");
  assert.equal([...g.timers.pending][0].ms, 10_000);
  const result = g.reload();
  await settle();
  assert.equal(g.reloaded(), 0);
  left.set({ status: "Saved", pending: false });
  await closed;
  assert.deepEqual(left.calls, ["close"]);
  assert.deepEqual(await result, { ok: true });
  assert.equal(g.reloadGate.closing.size, 0);
});

test("a Page left without its receipt blocks Reload until it is opened again", async () => {
  const g = gate();
  const left = new FakeSession("page-left");
  g.reloadGate.hold(left);
  const closed = g.reloadGate.drainAndClose(left);
  // Leaving never hangs: offline ends the drain and the checkpoint keeps it.
  left.set({ status: "Offline" });
  await closed;
  assert.deepEqual(left.calls, ["close"]);
  assert.deepEqual(await g.reload(), { ok: false, message: LEFT_PAGE_UNSAVED });
  // Reopening loads that checkpoint; the new session owns the receipt.
  const reopened = new FakeSession("page-left");
  g.reloadGate.hold(reopened);
  const result = g.reload();
  reopened.set({ status: "Saved", pending: false });
  assert.deepEqual(await result, { ok: true });
});

test("navigation during the wait cancels the reload", async () => {
  const g = gate();
  const first = new FakeSession();
  g.reloadGate.hold(first);
  const result = g.reload();
  void g.reloadGate.drainAndClose(first);
  const second = new FakeSession();
  second.set({ pending: false, status: "Saved" });
  g.reloadGate.hold(second);
  first.set({ status: "Saved", pending: false });
  assert.deepEqual(await result, { ok: false, cancelled: true });
  assert.equal(g.reloaded(), 0);
  assert.equal(first.editsPaused, false);
});

test("paused edits need every reason released and survive capability refreshes", () => {
  const session = new PageSession("page");
  session.credentialCanWrite = true;
  session.access = { role: "owner", canWrite: true, canComment: true, canDelete: true };
  session.updateCapabilities();
  assert.equal(session.canWrite, true);
  let emitted = 0;
  session.subscribe(() => emitted++);
  session.pauseEdits("reload");
  assert.deepEqual(
    [session.canWrite, session.canComment, session.canDelete],
    [false, false, false],
  );
  assert.throws(() => session.change(() => {}), /read only/);
  // Sign-in and access refreshes recompute capabilities; the pause holds.
  session.updateCapabilities();
  assert.equal(session.canWrite, false);
  session.pauseEdits("reload");
  assert.equal(emitted, 1, "repeating a pause does not repaint");
  session.pauseEdits("protocol");
  session.pauseEdits("reload", false);
  assert.equal(session.canWrite, false, "the protocol floor still holds");
  session.pauseEdits("protocol", false);
  assert.equal(session.canWrite, true);
  assert.equal(emitted, 4);
});
