// The reload-gate table, driven through ReloadGate and BuildUpdate's outcome
// rule. Each row builds FakeSessions and gate membership from the row's
// state, delivers the event through hold, drainAndClose, track, session
// changes or reload, and reads the gate's state back.
import test from "node:test";
import assert from "node:assert/strict";
import { ReloadGate } from "./build-freshness.mjs";
import { reject } from "../shared/machine.mjs";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import { reloadGateSpec } from "./reload-gate-machine.mjs";

const TABLE = new URL("../test/fixtures/machines/reload-gate.json", import.meta.url);
const SAVE_BEFORE_RELOAD_MS = 15_000;
const NOTHING_SAVING = "No held Page is still saving";
const SAVE_TIMEOUT =
  "Your latest edits haven't saved yet, so Pages won't reload. Check your connection and try again.";
const unsavable = {
  "Sign in to sync": "Sign in again so your latest edits can save, then reload.",
  "Access removed":
    "Your latest edits can't be saved to this Page. Download the local draft before reloading.",
  "Access changed":
    "Your latest edits can't be saved to this Page. Download the local draft before reloading.",
  "Local save failed": "Your latest edits couldn't be saved on this device, so Pages won't reload.",
};

const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, fail;
  const promise = new Promise((ok, no) => {
    resolve = ok;
    fail = no;
  });
  promise.catch(() => {});
  return { promise, resolve, reject: fail };
}

/** The status string today's gate reads for an entry's facts. */
function statusOf({ save, reason, pending }) {
  if (save === "failed") return "Local save failed";
  if (reason === "auth") return "Sign in to sync";
  if (reason === "reload") return "Access changed";
  if (reason) return "Access removed";
  if (!pending) return "Saved";
  return save === "stalled" ? "Offline" : "Saving";
}

class FakeSession {
  deleted = false;
  checkpointWritten = false;
  listeners = new Map();
  doc = { title: "Garden notes" };
  heads = ["h1"];
  constructor(ctx, entry) {
    this.ctx = ctx;
    this.id = entry.id;
    const split = entry.key.indexOf(":");
    this.identity = { principal: entry.key.slice(0, split) };
    this.pageId = entry.key.slice(split + 1);
    this.closed = deferred();
    this.apply(entry);
  }
  apply({ alive, pending, save, reason, savedHeads }) {
    Object.assign(this, { alive, pending, save, reason, savedHeads: [...savedHeads] });
    this.status = statusOf(this);
  }
  get recoveryPending() {
    return this.pending;
  }
  subscribe(fn) {
    const tag = this.ctx.tag;
    this.listeners.set(fn, tag);
    return () => {
      if (!this.listeners.delete(fn) || tag !== "save") return;
      // saveBeforeReload finished: latch what it saw.
      this.ctx.results.set(
        this.id,
        !this.alive || this.deleted || !this.pending
          ? "ok"
          : (unsavable[this.status] ?? SAVE_TIMEOUT),
      );
    };
  }
  emit() {
    for (const fn of this.listeners.keys()) fn();
  }
  pauseEdits(reason, paused = true) {
    if (reason === "reload") this.ctx.calls.push([paused ? "pause" : "resume", this.id]);
  }
  retryConnection() {
    this.ctx.calls.push(["save", this.id, true]);
  }
  queueSaved() {
    this.ctx.calls.push(["save", this.id, false]);
  }
  exportRecovery() {
    return { markdown: `# ${this.doc.title}\n\nUnsent edit\n`, heads: [...this.heads] };
  }
  close() {
    this.alive = false;
    return this.closed.promise;
  }
}

function harness() {
  const ctx = {
    calls: [],
    results: new Map(),
    sessions: new Map(),
    order: [],
    via: new Map(),
    tracks: new Map(),
    drafts: false,
    timers: new Set(),
  };
  ctx.gate = new ReloadGate({
    timers: {
      setTimeout: (fn, ms) => {
        const timer = { fn, ms };
        ctx.timers.add(timer);
        if (ms === SAVE_BEFORE_RELOAD_MS) ctx.calls.push(["timer"]);
        return timer;
      },
      clearTimeout: (timer) => ctx.timers.delete(timer),
    },
  });
  ctx.gate.watchDrafts(() => ctx.drafts);
  return ctx;
}

/** Add a session to the gate the way the app does: hold it when installed,
 * drain it when left, or track an access reload's own close. */
function own(ctx, entry, event) {
  const session = new FakeSession(ctx, entry);
  if (event?.id === entry.id && event.phase === "closed") {
    session.doc.title = event.title;
    session.heads = event.recovery?.heads ?? ["h1"];
  }
  ctx.sessions.set(entry.id, session);
  ctx.order.push(entry.id);
  ctx.gate.hold(session);
  if (entry.phase === "closing") leave(ctx, session, entry);
  return session;
}

function leave(ctx, session, entry) {
  if (entry.drain) {
    ctx.via.set(session.id, "drain");
    // A closing session that is no longer alive has finished draining.
    if (!entry.alive) session.status = "Offline";
    ctx.tag = "drain";
    void ctx.gate.drainAndClose(session).catch(() => {});
    ctx.tag = undefined;
  } else {
    ctx.via.set(session.id, "archive");
    const closing = deferred();
    ctx.tracks.set(session.id, closing);
    void ctx.gate.track(session, closing.promise).catch(() => {});
    if (!entry.alive) session.alive = false;
  }
}

function startReload(ctx, { acceptCheckpoints = false } = {}) {
  const gate = ctx.gate;
  ctx.epochAtStart = gate.epoch;
  ctx.acceptCheckpoints = acceptCheckpoints;
  ctx.live = [...gate.sessions].filter((s) => s.alive && !s.deleted);
  ctx.closingAtStart = ctx.order.filter((id) => ctx.via.has(id) && !ctx.removed?.has(id));
  ctx.tag = "save";
  const attempt = gate.reload({ reload: () => ctx.calls.push(["reload"]), acceptCheckpoints });
  ctx.tag = undefined;
  for (const session of ctx.live)
    if (![...session.listeners.values()].includes("save"))
      ctx.results.set(
        session.id,
        !session.alive || session.deleted || !session.pending ? "ok" : unsavable[session.status],
      );
  ctx.result = undefined;
  ctx.attempt = attempt.then((result) => (ctx.result = result));
}

async function prepare(state, event) {
  const ctx = harness();
  ctx.removed = new Set();
  for (const entry of state.sessions) own(ctx, entry, event);
  await settle();
  for (const record of state.records) ctx.gate.closed.set(record.key, structuredClone(record));
  if (state.name === "waiting") {
    startReload(ctx, state.attempt);
    if (state.attempt.navigated) ctx.gate.epoch++;
    await settle();
  } else if (state.name !== "idle") ctx.outcome = { name: state.name, outcome: state.outcome };
  ctx.drafts = state.drafts;
  ctx.calls.length = 0;
  return ctx;
}

async function deliver(ctx, event) {
  const gate = ctx.gate;
  switch (event.type) {
    case "reload":
      for (const key of event.discard) gate.discard({ key });
      ctx.outcome = undefined;
      startReload(ctx, event);
      break;
    case "navigate":
      gate.epoch++;
      // BuildUpdate drops its answer when the visible Page changes.
      if (ctx.outcome?.name !== "reloading") ctx.outcome = undefined;
      break;
    case "draft":
      ctx.drafts = event.present;
      break;
    case "timeout": {
      const due = [...ctx.timers].filter((timer) => timer.ms === SAVE_BEFORE_RELOAD_MS);
      ctx.fired = due.length;
      for (const timer of due) {
        ctx.timers.delete(timer);
        timer.fn();
      }
      break;
    }
    case "sessionPhase": {
      const session = ctx.sessions.get(event.id);
      if (event.phase === "held" || event.phase === "closing") {
        if (!session) {
          own(ctx, event);
          break;
        }
        const wasHeld = gate.sessions.has(session);
        session.apply(event);
        if (wasHeld && event.phase === "closing") leave(ctx, session, event);
        else if (!wasHeld && event.phase === "held") {
          ctx.via.delete(session.id);
          ctx.tracks.get(session.id).reject(Error("archive failed"));
        } else session.emit();
        break;
      }
      const via = ctx.via.get(event.id);
      if (event.phase === "deleted") session.deleted = true;
      if (via === "drain") {
        if (session.alive) {
          if (event.phase === "closed" && event.saved) session.pending = false;
          session.status = event.phase === "closed" && event.saved ? "Saved" : "Offline";
          session.emit();
          await settle();
        }
        session.checkpointWritten = event.checkpointWritten === true;
        session.savedHeads = [...event.savedHeads];
        session.closed.resolve();
      } else if (via === "archive") {
        session.alive = false;
        ctx.tracks.get(event.id).resolve();
      } else session.alive = false;
      ctx.removed.add(event.id);
      ctx.order = ctx.order.filter((id) => id !== event.id);
      break;
    }
  }
  await settle();
}

function entryOf(ctx, session) {
  const held = ctx.gate.sessions.has(session);
  const entry = {
    id: session.id,
    key: `${session.identity.principal}:${session.pageId}`,
    phase: held ? "held" : "closing",
    alive: session.alive,
    pending: session.pending,
    save: session.save,
    savedHeads: [...session.savedHeads],
  };
  if (!held) entry.drain = ctx.via.get(session.id) === "drain";
  if (session.reason) entry.reason = session.reason;
  return entry;
}

function read(ctx) {
  const gate = ctx.gate;
  const common = {
    sessions: ctx.order.map((id) => entryOf(ctx, ctx.sessions.get(id))),
    records: [...gate.closed.values()].map((record) => structuredClone(record)),
    drafts: gate.hasDrafts(),
  };
  if (ctx.attempt && ctx.result === undefined)
    return {
      name: "waiting",
      ...common,
      attempt: {
        acceptCheckpoints: ctx.acceptCheckpoints,
        navigated: gate.epoch !== ctx.epochAtStart,
        live: ctx.live.map((session) => ({
          id: session.id,
          key: `${session.identity.principal}:${session.pageId}`,
          result: ctx.results.has(session.id) ? ctx.results.get(session.id) : null,
          savedHeads: [...session.savedHeads],
        })),
        closing: ctx.closingAtStart.filter(
          (id) => !ctx.removed.has(id) && !gate.sessions.has(ctx.sessions.get(id)),
        ),
      },
    };
  if (ctx.result) {
    const { ok, cancelled, ...outcome } = ctx.result;
    if (ok) return { name: "reloading", ...common };
    if (cancelled) return { name: "cancelled", ...common };
    return { name: "blocked", ...common, outcome };
  }
  if (ctx.outcome)
    return {
      name: ctx.outcome.name,
      ...common,
      ...(ctx.outcome.outcome ? { outcome: ctx.outcome.outcome } : {}),
    };
  return { name: "idle", ...common };
}

function effectsOf(ctx) {
  const pauses = [],
    saves = [],
    resumes = [];
  let timer = false,
    reload = false;
  for (const [kind, id, retry] of ctx.calls) {
    if (kind === "pause") pauses.push(id);
    else if (kind === "resume") resumes.push(id);
    else if (kind === "save") saves.push({ type: "requestSave", id, retry });
    else if (kind === "timer") timer = true;
    else if (kind === "reload") reload = true;
  }
  return [
    ...(pauses.length ? [{ type: "pauseEdits", ids: pauses }] : []),
    ...saves,
    ...(timer ? [{ type: "startTimer", ms: SAVE_BEFORE_RELOAD_MS }] : []),
    ...(resumes.length ? [{ type: "resumeEdits", ids: resumes }] : []),
    ...(reload ? [{ type: "reload" }] : []),
  ];
}

async function drive(state, event) {
  const ctx = await prepare(state, event);
  await deliver(ctx, event);
  const effects = effectsOf(ctx);
  if (event.type === "timeout" && !ctx.fired) return reject(state, NOTHING_SAVING);
  return { state: read(ctx), effects };
}

test("the reload-gate table drives ReloadGate and BuildUpdate's outcome", async () => {
  const result = await runTable(reloadGateSpec, loadTable(TABLE), { drive });
  assert.deepEqual(result, { rows: 56, pairs: 19, unreachable: 6, cases: 42 });
});
