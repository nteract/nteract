import test from "node:test";
import assert from "node:assert/strict";
import { VirtualTimeScheduler } from "rxjs";
import {
  BUILD_CHECK_INTERVAL_MS,
  BuildMonitor,
  VISIBLE_RECHECK_MS,
  ReloadGate,
  UNSENT_COMMENT,
} from "./build-freshness.mjs";
import * as Automerge from "@automerge/automerge";
import { observeResponses, request } from "./request.mjs";
import { CLOSE_DRAIN_MS, PageSession } from "./session.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { SessionHost } from "./session-host.mjs";
import { FakeSession, deferred, manualTimers } from "./session-fixture.mjs";
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

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A reload gate following a SessionHost. Fake sessions drain on `timers`;
 * the gate's own timeout runs on `scheduler`. */
function gate() {
  const timers = manualTimers();
  const scheduler = new VirtualTimeScheduler();
  const host = new SessionHost();
  const reloadGate = new ReloadGate({ scheduler });
  reloadGate.watch(host);
  let reloaded = 0;
  return {
    timers,
    scheduler,
    host,
    reloadGate,
    reloaded: () => reloaded,
    reload: (options) => reloadGate.reload({ reload: () => reloaded++, ...options }),
    session: (pageId, options) => new FakeSession(pageId, { timers, ...options }),
    hold: (session) => host.install(session, host.generation, session.identity.principal),
    records: () => reloadGate.store.snapshot().records,
    record: (key) => reloadGate.store.snapshot().records.find((record) => record.key === key),
    owned: () => reloadGate.store.snapshot().sessions,
  };
}
const timeouts = (scheduler) => scheduler.actions.map((action) => action.delay);

test("reload waits for accepted edits to be saved on the host", async () => {
  const g = gate();
  const session = g.session();
  g.hold(session);
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
  assert.deepEqual(timeouts(g.scheduler), []);
});

test("reload is immediate with nothing to save, and retries a stalled save", async () => {
  assert.deepEqual(await gate().reload(), { ok: true });
  const g = gate();
  const saved = g.session();
  saved.set({ pending: false, status: "Saved" });
  g.hold(saved);
  assert.deepEqual(await g.reload(), { ok: true });
  assert.equal(g.reloaded(), 1);

  const h = gate();
  const offline = h.session();
  offline.status = "Offline";
  h.hold(offline);
  const result = h.reload();
  assert.deepEqual(offline.calls, [["retry", { retryReceipt: true }]]);
  offline.set({ status: "Saved", pending: false });
  assert.deepEqual(await result, { ok: true });
});

test("edits that can't be saved block the reload and say why", async () => {
  for (const reason of ["auth", "access", "failed"]) {
    const g = gate();
    const session = g.session();
    if (reason === "failed") session.status = "Local save failed";
    else session.pause(reason);
    g.hold(session);
    const result = await g.reload();
    assert.equal(result.ok, false, reason);
    assert.match(result.message, /edits/);
    assert.equal(g.reloaded(), 0);
    assert.equal(session.editsPaused, false, "editing resumes after a voluntary attempt");
  }
  // A save that fails mid-wait stops the attempt too.
  const g = gate();
  const session = g.session();
  g.hold(session);
  const failing = g.reload();
  session.set({ status: "Local save failed" });
  assert.equal((await failing).ok, false);
  assert.equal(g.reloaded(), 0);
});

test("a raised floor during a failed reload keeps edits paused", async () => {
  const g = gate();
  const session = g.session();
  g.hold(session);
  const result = g.reload();
  // The floor rises while the optional reload is waiting for its receipt.
  session.pauseEdits("protocol");
  assert.deepEqual(timeouts(g.scheduler), [15_000]);
  g.scheduler.flush();
  const { ok, message } = await result;
  assert.equal(ok, false);
  assert.match(message, /haven't saved yet/);
  assert.deepEqual([...session.pauses], ["protocol"], "only the reload's pause is released");
  assert.equal(session.editsPaused, true);
});

test("unsent comment drafts block the reload until sent or discarded", async () => {
  const g = gate();
  const drafts = g.reloadGate.watchDrafts();
  drafts.set(true);
  assert.deepEqual(await g.reload(), { ok: false, message: UNSENT_COMMENT });
  // A draft typed while edits wait to save also blocks.
  drafts.set(false);
  const session = g.session();
  g.hold(session);
  const waiting = g.reload();
  drafts.set(true);
  session.set({ status: "Saved", pending: false });
  assert.deepEqual(await waiting, { ok: false, message: UNSENT_COMMENT });
  assert.equal(session.editsPaused, false);
  drafts.set(false);
  assert.deepEqual(await g.reload(), { ok: true });
  drafts.stop();
  assert.equal(g.reloadGate.hasDrafts(), false);
});

test("a Page being left keeps saving, and Reload waits for its receipt", async () => {
  const g = gate();
  const left = g.session();
  g.hold(left);
  const closed = g.host.release();
  assert.deepEqual(left.calls, [], "still open while its receipt is in flight");
  assert.equal([...g.timers.pending][0].ms, CLOSE_DRAIN_MS);
  const result = g.reload();
  await settle();
  assert.equal(g.reloaded(), 0);
  left.set({ status: "Saved", pending: false });
  await closed;
  assert.deepEqual(left.calls, ["close"]);
  assert.deepEqual(await result, { ok: true });
  assert.deepEqual(g.owned(), []);
  assert.deepEqual(g.records(), []);
});

/** Leave a Page that goes offline before its receipt: the drain ends and
 * close writes the IndexedDB checkpoint (or fails to). */
async function leaveUnsaved(g, session) {
  g.hold(session);
  const closed = g.host.release();
  session.set({ status: "Offline" });
  await closed;
  await settle();
}

test("a closed Page keeps only metadata, never its session", async () => {
  const g = gate();
  const left = g.session("page-left");
  await leaveUnsaved(g, left);
  assert.deepEqual(left.calls, ["close"]);
  assert.equal(left.listeners.size, 0, "no listener keeps the session alive");
  assert.deepEqual(g.owned(), []);
  assert.deepEqual(g.host.store.snapshot().owned, []);
  assert.deepEqual(g.records(), [
    {
      key: "dev:page-left",
      account: "dev",
      pageId: "page-left",
      title: "Garden notes",
      checkpointWritten: true,
    },
  ]);
  // Plain data only: nothing the gate retains reaches the session or its doc.
  const seen = new Set();
  (function walk(value) {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    assert.notEqual(value, left);
    assert.notEqual(value, left.doc);
    seen.add(value);
    for (const child of Object.values(value)) walk(child);
  })(g.reloadGate.store.snapshot());
  // A saved leave keeps nothing at all.
  const saved = g.session();
  g.hold(saved);
  const closing = g.host.release();
  saved.set({ status: "Saved", pending: false });
  await closing;
  await settle();
  assert.equal(g.records().length, 1);
});

test("the gate releases a closed session for garbage collection", async () => {
  const g = gate();
  let left = g.session("page-gc");
  const ref = new WeakRef(left);
  await leaveUnsaved(g, left);
  left = null;
  await settle();
  gc();
  assert.equal(ref.deref(), undefined);
  assert.equal(g.records().length, 1);
});

test("Reload names closed Pages waiting in IndexedDB and asks before reloading", async () => {
  const g = gate();
  await leaveUnsaved(g, g.session("page-left"));
  const second = g.session("page-two");
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
  const reopened = g.session("page-left");
  g.hold(reopened);
  const waiting = g.reload();
  reopened.set({ status: "Saved", pending: false });
  const again = await waiting;
  assert.equal(
    again.message,
    "Edits on Plans haven't reached the server yet. They're saved in this browser and sync when you open that Page again.",
  );
  // Reload anyway: the checkpoints stay in IndexedDB for the next open.
  assert.deepEqual(await g.reload({ acceptCheckpoints: true }), { ok: true });
});

test("a failed checkpoint blocks Reload until its Markdown is downloaded or discarded", async () => {
  const g = gate();
  const left = g.session("page-lost");
  left.checkpointFails = true;
  await leaveUnsaved(g, left);
  await leaveUnsaved(g, g.session("page-kept"));
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
  assert.equal((await g.reload({ acceptCheckpoints: true })).reason, "unsaved");
  assert.equal(g.reloaded(), 0);
  // Discard and reload drops only that record.
  assert.equal((await g.reload({ discard: [result.pages[0].key] })).reason, "checkpointed");
  // A close that throws keeps the export too.
  const broken = g.session("page-broken");
  broken.checkpointFails = true;
  broken.closeError = new Error("disk");
  const errors = [];
  g.hold(broken);
  const closing = g.host.release({ onError: (error) => errors.push(error.message) });
  broken.set({ status: "Offline" });
  await closing;
  await settle();
  assert.deepEqual(errors, ["disk"]);
  assert.equal(g.record("dev:page-broken").checkpointWritten, false);
});

test("reopening never clears a failed checkpoint; only a covering receipt or discard does", async () => {
  const g = gate();
  const left = g.session("page-lost");
  left.checkpointFails = true;
  left.heads = ["lost-1", "lost-2"];
  await leaveUnsaved(g, left);
  // The reopened replica lacks the lost edits, so its receipt covers other heads.
  const reopened = g.session("page-lost");
  reopened.heads = ["server"];
  g.hold(reopened);
  assert.equal(g.record("dev:page-lost").checkpointWritten, false);
  let waiting = g.reload();
  reopened.set({ status: "Saved", pending: false, savedHeads: ["server"] });
  assert.equal((await waiting).reason, "unsaved", "a receipt for other heads keeps the record");
  // Leaving again with a written checkpoint, or fully saved, keeps it too.
  await g.host.release();
  await settle();
  assert.equal(g.record("dev:page-lost").checkpointWritten, false);
  // A second failed checkpoint adds its copy instead of replacing the first.
  const again = g.session("page-lost");
  again.checkpointFails = true;
  again.heads = ["lost-3"];
  await leaveUnsaved(g, again);
  const record = g.record("dev:page-lost");
  assert.deepEqual(record.heads, ["lost-1", "lost-2", "lost-3"]);
  assert.equal(record.markdown.split("# Garden notes").length, 3);
  // A receipt that includes every recorded head clears it.
  const synced = g.session("page-lost");
  g.hold(synced);
  waiting = g.reload();
  synced.set({ status: "Saved", pending: false, savedHeads: ["lost-1", "lost-2", "lost-3"] });
  assert.deepEqual(await waiting, { ok: true });
});

test("closed records are keyed by account and Page id", async () => {
  const g = gate();
  const first = g.session("shared-page");
  first.checkpointFails = true;
  await leaveUnsaved(g, first);
  const other = g.session("shared-page", { principal: "other" });
  other.checkpointFails = true;
  await leaveUnsaved(g, other);
  const { pages } = await g.reload();
  assert.deepEqual(
    pages.map((page) => page.key),
    ["dev:shared-page", "other:shared-page"],
  );
  assert.deepEqual(
    (await g.reload({ discard: [pages[0].key] })).pages.map((page) => page.key),
    ["other:shared-page"],
  );
});

test("a closed Page whose access was removed never traps Reload", async () => {
  const g = gate();
  const left = g.session("page-revoked");
  g.hold(left);
  // Access removal stops the drain at once; close still writes the checkpoint.
  left.pause("access");
  await g.host.release();
  await settle();
  const result = await g.reload();
  assert.equal(result.reason, "checkpointed");
  assert.deepEqual(await g.reload({ acceptCheckpoints: true }), { ok: true });
  // A deleted Page has nothing to keep.
  const h = gate();
  const deleted = h.session("page-deleted");
  h.hold(deleted);
  const closing = h.host.release();
  void deleted.markDeleted();
  await closing;
  await settle();
  assert.equal(h.record("dev:page-deleted"), undefined);
});

test("navigation during the wait cancels the reload", async () => {
  const g = gate();
  const first = g.session();
  g.hold(first);
  const result = g.reload();
  void g.host.release();
  const second = g.session();
  second.set({ pending: false, status: "Saved" });
  g.hold(second);
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

test("moving a Page to Trash closes it through the host: a held checkpoint blocks Reload", async () => {
  const g = gate();
  const trashed = g.session("page-trashed");
  g.hold(trashed);
  trashed.closeGate = deferred();
  g.host.detach();
  const closing = closeTrashedSessions(g.host, [trashed, trashed]);
  trashed.set({ status: "Saved", pending: false });
  const result = g.reload();
  await settle();
  assert.deepEqual(trashed.calls, ["close"], "the checkpoint close is in flight");
  assert.equal(g.reloaded(), 0, "Reload waits for the held checkpoint");
  trashed.closeGate.resolve();
  await closing;
  assert.deepEqual(await result, { ok: true });
  assert.equal(g.reloaded(), 1);
});

test("a failed checkpoint while moving a Page to Trash offers its recovery export", async () => {
  const g = gate();
  const trashed = g.session("page-trash-lost");
  trashed.checkpointFails = true;
  g.hold(trashed);
  g.host.detach();
  const closing = closeTrashedSessions(g.host, [trashed]);
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
  const reader = g.session("page-restored");
  reader.pause("reload");
  g.hold(reader);
  const reloading = g.host.reloadAccess(reader, { install: async () => false });
  const result = g.reload();
  await settle();
  assert.equal(g.reloaded(), 0);
  reader.finishArchive(undefined, g.session("page-restored"));
  await reloading;
  assert.deepEqual(await result, { ok: true });
});

test("a failed access reload keeps its live session blocking Reload", async () => {
  const g = gate();
  const writer = g.session("page-switch-failed");
  writer.pause("reload");
  g.hold(writer);
  const errors = [];
  const reloading = g.host.reloadAccess(writer, {
    install: async () => true,
    onError: (error) => errors.push(error.message),
  });
  writer.finishArchive(new Error("checkpoint failed"));
  await reloading;
  await settle();
  assert.deepEqual(errors, ["checkpoint failed"]);
  const result = g.reload();
  await settle();
  assert.equal(g.reloaded(), 0, "unsent edits on the live session still block Reload");
  assert.match((await result).message, /can't be saved/);
});

/** A real PageSession saving an unacknowledged edit, whose final checkpoint
 * waits for `flush` and `persist`. */
function closingSession() {
  const pageId = crypto.randomUUID();
  const doc = Automerge.change(
    Automerge.from(createPageData({ pageId, title: "Garden notes" })),
    initializePage,
  );
  const session = new PageSession(pageId);
  const flush = deferred();
  const persist = deferred();
  session.identity = { principal: "dev" };
  session.handle = { doc: () => doc };
  session.repo = { flush: () => flush.promise };
  session.localPage = { pending: true };
  session.persistLocal = (_, options) =>
    options?.allowClosed ? persist.promise : Promise.resolve();
  session.releaseLocal = async () => {};
  session.disconnectSockets = async () => {};
  session.queueSaved = () => {};
  session.status = "Saving";
  session.dispatch({ type: "opened", denied: false });
  return { session, flush, persist };
}

test("a direct close during Reload never reloads before its final checkpoint", async () => {
  const g = gate();
  const { session, flush, persist } = closingSession();
  g.hold(session);
  const waiting = g.reload();
  // Sign-out and unmount close at once, without the drain.
  const closed = g.host.close(session);
  assert.equal(session.phase$.snapshot().name, "checkpointing");
  assert.deepEqual(await waiting, { ok: false, cancelled: true });
  assert.equal(g.reloaded(), 0);
  // A new attempt waits for the checkpoint, then names the Page.
  const again = g.reload();
  await settle();
  assert.equal(g.reloaded(), 0, "Reload waits for the final checkpoint");
  flush.resolve();
  persist.resolve();
  await closed;
  const outcome = await again;
  assert.equal(outcome.reason, "checkpointed");
  assert.deepEqual(
    outcome.pages.map((page) => page.pageId),
    [session.pageId],
  );
  assert.equal(g.reloaded(), 0);
});

test("a direct close whose checkpoint fails keeps its recovery export", async () => {
  const g = gate();
  const { session, flush, persist } = closingSession();
  g.hold(session);
  const closed = g.host.close(session);
  const result = g.reload();
  await settle();
  assert.equal(g.reloaded(), 0, "Reload waits while the checkpoint is in flight");
  flush.resolve();
  persist.reject(new Error("disk"));
  await closed;
  const outcome = await result;
  assert.equal(outcome.reason, "unsaved");
  const [page] = outcome.pages;
  assert.equal(page.pageId, session.pageId);
  assert.equal(page.checkpointWritten, false);
  assert.match(page.markdown, /Garden notes/);
  assert.ok(page.heads.length > 0, "the export names the heads it holds");
  assert.equal(g.reloaded(), 0);
});
