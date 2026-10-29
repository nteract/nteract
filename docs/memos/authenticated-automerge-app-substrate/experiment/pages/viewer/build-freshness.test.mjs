import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILD_CHECK_INTERVAL_MS,
  BuildMonitor,
  VISIBLE_RECHECK_MS,
  ReloadGate,
  UNSENT_COMMENT,
  saveBeforeReload,
} from "./build-freshness.mjs";
import { observeResponses, request } from "./request.mjs";
import { PageSession } from "./session.mjs";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { closeTrashedSessions } from "./trash.mjs";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc");

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
  doc = { title: "Garden notes" };
  heads = ["h1"];
  savedHeads = [];
  exportRecovery() {
    return { markdown: `# ${this.doc.title}\n\nUnsent edit\n`, heads: [...this.heads] };
  }
  checkpointFails = false;
  async close() {
    this.calls.push("close");
    this.alive = false;
    this.checkpointWritten = !this.checkpointFails;
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
  assert.equal(g.reloadGate.draining.size, 0);
  assert.equal(g.reloadGate.closed.size, 0);
});

/** Leave a Page that goes offline before its receipt: the drain ends and
 * close writes the IndexedDB checkpoint (or fails to). */
async function leaveUnsaved(g, session) {
  g.reloadGate.hold(session);
  const closed = g.reloadGate.drainAndClose(session);
  session.set({ status: "Offline" });
  await closed;
  await settle();
}

test("a closed Page keeps only metadata, never its session", async () => {
  const g = gate();
  const left = new FakeSession("page-left");
  await leaveUnsaved(g, left);
  assert.deepEqual(left.calls, ["close"]);
  assert.equal(left.listeners.size, 0, "no listener keeps the session alive");
  assert.equal(g.reloadGate.draining.size, 0);
  assert.equal(g.reloadGate.sessions.size, 0);
  assert.deepEqual(
    [...g.reloadGate.closed.values()],
    [
      {
        key: "dev:page-left",
        account: "dev",
        pageId: "page-left",
        title: "Garden notes",
        checkpointWritten: true,
      },
    ],
  );
  // Plain data only: nothing the gate retains reaches the session or its doc.
  const seen = new Set();
  (function walk(value) {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    assert.notEqual(value, left);
    assert.notEqual(value, left.doc);
    seen.add(value);
    for (const child of value instanceof Map || value instanceof Set
      ? [...value.values(), ...(value instanceof Map ? value.keys() : [])]
      : Object.values(value))
      walk(child);
  })({ ...g.reloadGate });
  // A saved leave keeps nothing at all.
  const saved = new FakeSession();
  g.reloadGate.hold(saved);
  const closing = g.reloadGate.drainAndClose(saved);
  saved.set({ status: "Saved", pending: false });
  await closing;
  await settle();
  assert.equal(g.reloadGate.closed.size, 1);
});

test("the gate releases a closed session for garbage collection", async () => {
  const g = gate();
  let left = new FakeSession("page-gc");
  const ref = new WeakRef(left);
  await leaveUnsaved(g, left);
  left = null;
  await settle();
  gc();
  assert.equal(ref.deref(), undefined);
  assert.equal(g.reloadGate.closed.size, 1);
});

test("Reload names closed Pages waiting in IndexedDB and asks before reloading", async () => {
  const g = gate();
  await leaveUnsaved(g, new FakeSession("page-left"));
  const second = new FakeSession("page-two");
  second.doc = { title: "Plans" };
  await leaveUnsaved(g, second);
  const result = await g.reload();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "checkpointed");
  assert.deepEqual(
    result.pages.map((page) => page.pageId),
    ["page-left", "page-two"],
  );
  assert.equal(
    result.message,
    "Edits on Garden notes and Plans haven't reached the server yet. They're saved in this browser and sync when you open those Pages again.",
  );
  assert.equal(g.reloaded(), 0);
  // Opening one of them supersedes its record; the new session owns the receipt.
  const reopened = new FakeSession("page-left");
  g.reloadGate.hold(reopened);
  const waiting = g.reload();
  reopened.set({ status: "Saved", pending: false });
  const again = await waiting;
  assert.equal(
    again.message,
    "Edits on Plans haven't reached the server yet. They're saved in this browser and sync when you open that Page again.",
  );
  // Reload anyway: the checkpoints stay in IndexedDB for the next open.
  assert.deepEqual(await g.reloadGate.reload({ reload: () => {}, acceptCheckpoints: true }), {
    ok: true,
  });
});

test("a failed checkpoint blocks Reload until its Markdown is downloaded or discarded", async () => {
  const g = gate();
  const left = new FakeSession("page-lost");
  left.checkpointFails = true;
  await leaveUnsaved(g, left);
  await leaveUnsaved(g, new FakeSession("page-kept"));
  const result = await g.reload();
  assert.equal(result.reason, "unsaved");
  assert.deepEqual(result.pages, [
    {
      key: "dev:page-lost",
      account: "dev",
      pageId: "page-lost",
      title: "Garden notes",
      checkpointWritten: false,
      heads: ["h1"],
      markdown: "# Garden notes\n\nUnsent edit\n",
    },
  ]);
  assert.match(result.message, /^Edits on Garden notes couldn't be saved in this browser/);
  // Reload anyway does not cover edits that exist nowhere else.
  assert.equal(
    (await g.reloadGate.reload({ acceptCheckpoints: true, reload() {} })).reason,
    "unsaved",
  );
  assert.equal(g.reloaded(), 0);
  g.reloadGate.discard(result.pages[0]);
  assert.equal((await g.reload()).reason, "checkpointed");
  // A close that throws keeps the export too.
  const broken = new FakeSession("page-broken");
  broken.close = async () => {
    throw new Error("disk");
  };
  g.reloadGate.hold(broken);
  const closing = g.reloadGate.drainAndClose(broken);
  broken.set({ status: "Offline" });
  await assert.rejects(closing, /disk/);
  await settle();
  assert.equal(g.reloadGate.closed.get("dev:page-broken").checkpointWritten, false);
});

test("reopening never clears a failed checkpoint; only a covering receipt or discard does", async () => {
  const g = gate();
  const left = new FakeSession("page-lost");
  left.checkpointFails = true;
  left.heads = ["lost-1", "lost-2"];
  await leaveUnsaved(g, left);
  // The reopened replica lacks the lost edits, so its receipt covers other heads.
  const reopened = new FakeSession("page-lost");
  reopened.heads = ["server"];
  g.reloadGate.hold(reopened);
  assert.equal(g.reloadGate.closed.get("dev:page-lost").checkpointWritten, false);
  let waiting = g.reload();
  reopened.set({ status: "Saved", pending: false, savedHeads: ["server"] });
  assert.equal((await waiting).reason, "unsaved", "a receipt for other heads keeps the record");
  // Leaving again with a written checkpoint, or fully saved, keeps it too.
  const closing = g.reloadGate.drainAndClose(reopened);
  await closing;
  await settle();
  assert.equal(g.reloadGate.closed.get("dev:page-lost").checkpointWritten, false);
  // A second failed checkpoint adds its copy instead of replacing the first.
  const again = new FakeSession("page-lost");
  again.checkpointFails = true;
  again.heads = ["lost-3"];
  await leaveUnsaved(g, again);
  const record = g.reloadGate.closed.get("dev:page-lost");
  assert.deepEqual(record.heads, ["lost-1", "lost-2", "lost-3"]);
  assert.equal(record.markdown.split("# Garden notes").length, 3);
  // A receipt that includes every recorded head clears it.
  const synced = new FakeSession("page-lost");
  g.reloadGate.hold(synced);
  waiting = g.reload();
  synced.set({ status: "Saved", pending: false, savedHeads: ["lost-1", "lost-2", "lost-3"] });
  assert.deepEqual(await waiting, { ok: true });
});

test("closed records are keyed by account and Page id", async () => {
  const g = gate();
  const first = new FakeSession("shared-page");
  first.checkpointFails = true;
  await leaveUnsaved(g, first);
  const other = new FakeSession("shared-page");
  other.identity = { principal: "other" };
  other.checkpointFails = true;
  await leaveUnsaved(g, other);
  const { pages } = await g.reload();
  assert.deepEqual(
    pages.map((page) => page.key),
    ["dev:shared-page", "other:shared-page"],
  );
  g.reloadGate.discard(pages[0]);
  assert.deepEqual(
    (await g.reload()).pages.map((page) => page.key),
    ["other:shared-page"],
  );
});

test("a closed Page whose access was removed never traps Reload", async () => {
  const g = gate();
  const left = new FakeSession("page-revoked");
  g.reloadGate.hold(left);
  // Access removal stops the drain at once; close still writes the checkpoint.
  left.set({ status: "Access removed" });
  await g.reloadGate.drainAndClose(left);
  await settle();
  const result = await g.reload();
  assert.equal(result.reason, "checkpointed");
  assert.deepEqual(await g.reloadGate.reload({ acceptCheckpoints: true, reload() {} }), {
    ok: true,
  });
  // A deleted Page has nothing to keep.
  const deleted = new FakeSession("page-deleted");
  g.reloadGate.hold(deleted);
  const closing = g.reloadGate.drainAndClose(deleted);
  deleted.set({ deleted: true });
  await closing;
  await settle();
  assert.equal(g.reloadGate.closed.has("dev:page-deleted"), false);
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

test("moving a Page to Trash closes it through the gate: a held checkpoint blocks Reload", async () => {
  const g = gate();
  const trashed = new FakeSession("page-trashed");
  g.reloadGate.hold(trashed);
  let release;
  const close = trashed.close.bind(trashed);
  trashed.close = () =>
    new Promise((resolve) => {
      release = () => close().then(resolve);
    });
  const closing = closeTrashedSessions(g.reloadGate, [trashed, trashed]);
  trashed.set({ status: "Saved", pending: false });
  const result = g.reload();
  await settle();
  assert.equal(typeof release, "function", "the checkpoint close is in flight");
  assert.equal(g.reloaded(), 0, "Reload waits for the held checkpoint");
  release();
  await closing;
  assert.deepEqual(await result, { ok: true });
  assert.equal(g.reloaded(), 1);
});

test("a failed checkpoint while moving a Page to Trash offers its recovery export", async () => {
  const g = gate();
  const trashed = new FakeSession("page-trash-lost");
  trashed.checkpointFails = true;
  g.reloadGate.hold(trashed);
  const closing = closeTrashedSessions(g.reloadGate, [trashed]);
  trashed.set({ status: "Offline" });
  await closing;
  await settle();
  const result = await g.reload();
  assert.equal(result.reason, "unsaved");
  assert.equal(result.pages[0].pageId, "page-trash-lost");
  assert.equal(result.pages[0].markdown, "# Garden notes\n\nUnsent edit\n");
});

test("Reload waits for an access reload that closes its old replica", async () => {
  const g = gate();
  const reader = new FakeSession("page-restored");
  g.reloadGate.hold(reader);
  let finish;
  const reloading = new Promise((resolve) => {
    finish = resolve;
  });
  g.reloadGate.track(reader, reloading);
  const result = g.reload();
  await settle();
  assert.equal(g.reloaded(), 0);
  finish();
  assert.deepEqual(await result, { ok: true });
});

test("a failed access reload keeps its live session blocking Reload", async () => {
  const g = gate();
  const writer = new FakeSession("page-switch-failed");
  g.reloadGate.hold(writer);
  await g.reloadGate.track(writer, Promise.reject(Error("checkpoint failed"))).catch(() => {});
  await settle();
  const result = g.reload();
  await settle();
  assert.equal(g.reloaded(), 0, "unsent edits on the live session still block Reload");
  writer.set({ status: "Saved", pending: false });
  assert.deepEqual(await result, { ok: true });
  assert.equal(g.reloaded(), 1);
});
