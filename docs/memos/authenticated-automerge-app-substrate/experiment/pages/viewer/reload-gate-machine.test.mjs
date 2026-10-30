// The reload-gate table, run through the pure machine and driven through
// ReloadGate following a SessionHost. The drive builds fake sessions that the
// host installs, leaves or reloads for access, delivers the event through the
// host, a session or the gate's API, and reads the gate's store back. Effects
// are observed on the sessions, the reload callback and the scheduler.
import test from "node:test";
import assert from "node:assert/strict";
import { VirtualTimeScheduler } from "rxjs";
import { ReloadGate } from "./build-freshness.mjs";
import { SessionHost } from "./session-host.mjs";
import { FakeSession, deferred, manualTimers } from "./session-fixture.mjs";
import { reject } from "../shared/machine.mjs";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import {
  NOTHING_SAVING,
  SAVE_BEFORE_RELOAD_MS,
  reloadGateMachine,
  reloadGateSpec,
} from "./reload-gate-machine.mjs";

const TABLE = new URL("../test/fixtures/machines/reload-gate.json", import.meta.url);

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** The receipt status a session would show for an entry's facts. */
function statusOf({ save, pending }) {
  if (save === "failed") return "Local save failed";
  if (save === "stalled") return "Offline";
  return pending ? "Saving" : "Saved";
}

function harness() {
  const scheduler = new VirtualTimeScheduler();
  const host = new SessionHost();
  const gate = new ReloadGate({ scheduler, idOf: (session) => session.rowId });
  gate.watch(host);
  return {
    scheduler,
    host,
    gate,
    timers: manualTimers(),
    calls: [],
    sessions: new Map(),
    drafts: gate.watchDrafts(),
  };
}

function apply(session, entry) {
  Object.assign(session, {
    pending: entry.pending,
    status: statusOf(entry),
    savedHeads: [...entry.savedHeads],
  });
  if (entry.reason && session.phase$.snapshot().reason !== entry.reason)
    session.pause(entry.reason);
  else session.emit();
}

/** Own a session the way the app does: install it, then leave it through
 * the host's drain, close it directly or reload it for access. Its final checkpoint, and an
 * access reload's replacement, wait for the event that closes it. */
function own(ctx, entry, event, { install = true } = {}) {
  const split = entry.key.indexOf(":");
  const session = new FakeSession(entry.key.slice(split + 1), {
    principal: entry.key.slice(0, split),
    timers: ctx.timers,
  });
  session.rowId = entry.id;
  session.closeGate = deferred();
  if (event?.id === entry.id && event.phase === "closed") {
    session.doc.title = event.title;
    session.heads = event.recovery?.heads ?? ["h1"];
  }
  session.pauseEdits = (reason, paused = true) => {
    if (reason === "reload") ctx.calls.push([paused ? "pause" : "resume", entry.id]);
  };
  session.retryConnection = () => ctx.calls.push(["save", entry.id, true]);
  session.queueSaved = () => ctx.calls.push(["save", entry.id, false]);
  ctx.sessions.set(entry.id, session);
  Object.assign(session, {
    pending: entry.pending,
    status: statusOf(entry),
    savedHeads: [...entry.savedHeads],
  });
  if (entry.reason) session.step(pauseEvent(entry.reason));
  if (install) ctx.host.install(session, ctx.host.generation, session.identity.principal);
  else
    // Installing would also change the visible Page, which is `navigate`.
    ctx.host.store.update((state) => ({
      ...state,
      owned: [...state.owned, { session, held: true }],
    }));
  if (entry.phase === "closing") {
    // A closing session with a reload pause belongs to an access reload,
    // another live one is draining, and one no longer alive is writing its
    // final checkpoint after a direct close.
    if (entry.reason === "reload") {
      ctx.install = deferred();
      void ctx.host.reloadAccess(session, { install: () => ctx.install.promise });
      // Archived and waiting for its release.
      if (!entry.alive) session.finishArchive(undefined, null);
    } else if (entry.alive) leave(ctx, session);
    else void ctx.host.close(session);
  }
  return session;
}

const pauseEvent = (reason) =>
  ({
    auth: { type: "signIn", ok: false },
    access: { type: "accessChanged", grant: "denied" },
    trash: { type: "trash" },
    reload: { type: "accessChanged", grant: "changed" },
  })[reason];

function leave(ctx, session) {
  if (ctx.host.current === session) ctx.host.detach();
  void ctx.host.leave(session);
}

async function prepare(state, event) {
  const ctx = harness();
  for (const entry of state.sessions) own(ctx, entry, event);
  await settle();
  const records = structuredClone(state.records);
  ctx.gate.store.update((gate) => ({ ...gate, records }));
  if (state.name === "waiting") {
    ctx.attempt = ctx.gate
      .reload({
        reload: () => ctx.calls.push(["reload"]),
        acceptCheckpoints: state.attempt.acceptCheckpoints,
      })
      .then((result) => (ctx.result = result));
    if (state.attempt.navigated) ctx.host.detach();
  } else if (state.name !== "idle")
    ctx.gate.store.update(({ sessions, records: kept, drafts }) => ({
      name: state.name,
      sessions,
      records: kept,
      drafts,
      ...(state.outcome ? { outcome: state.outcome } : {}),
    }));
  ctx.drafts.set(state.drafts);
  await settle();
  ctx.calls.length = 0;
  return ctx;
}

async function deliver(ctx, event) {
  switch (event.type) {
    case "reload":
      void ctx.gate.reload({
        reload: () => ctx.calls.push(["reload"]),
        acceptCheckpoints: event.acceptCheckpoints,
        discard: event.discard,
      });
      break;
    case "navigate":
      ctx.host.detach();
      break;
    case "draft":
      ctx.drafts.set(event.present);
      break;
    case "timeout":
      ctx.fired = ctx.scheduler.actions.filter((a) => a.delay === SAVE_BEFORE_RELOAD_MS).length;
      ctx.scheduler.flush();
      break;
    case "sessionPhase": {
      const session = ctx.sessions.get(event.id);
      const phase = session?.phase$.snapshot();
      if (event.phase === "held" || event.phase === "closing") {
        if (!session) own(ctx, event, undefined, { install: false });
        else if (event.phase === "closing" && phase.name === "open") {
          apply(session, event);
          if (event.alive) leave(ctx, session);
          else void ctx.host.close(session);
        } else if (event.phase === "held" && phase.archive)
          session.finishArchive(new Error("archive failed"));
        else apply(session, event);
        break;
      }
      if (phase.name === "draining") {
        if (event.phase === "closed" && event.saved) session.pending = false;
        session.status = event.phase === "closed" && event.saved ? "Saved" : "Offline";
        session.emit();
        await settle();
      }
      if (event.phase === "deleted") void session.markDeleted();
      session.checkpointFails = event.checkpointWritten === false;
      session.savedHeads = [...event.savedHeads];
      if (phase.archive) session.finishArchive(undefined, null);
      session.closeGate.resolve();
      ctx.install?.resolve(false);
      break;
    }
  }
  await settle();
}

function effectsOf(ctx, timersBefore) {
  const pauses = [];
  const saves = [];
  const resumes = [];
  let reload = false;
  for (const [kind, id, retry] of ctx.calls) {
    if (kind === "pause") pauses.push(id);
    else if (kind === "resume") resumes.push(id);
    else if (kind === "save") saves.push({ type: "requestSave", id, retry });
    else if (kind === "reload") reload = true;
  }
  const timer = ctx.armed > timersBefore;
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
  // Count timers as they are armed: a timer can be armed and cancelled
  // within one event.
  ctx.armed = 0;
  const schedule = ctx.scheduler.schedule.bind(ctx.scheduler);
  ctx.scheduler.schedule = (work, delay, value) => {
    if (delay === SAVE_BEFORE_RELOAD_MS) ctx.armed++;
    return schedule(work, delay, value);
  };
  await deliver(ctx, event);
  if (event.type === "timeout" && !ctx.fired) return reject(state, NOTHING_SAVING);
  return { state: ctx.gate.store.snapshot(), effects: effectsOf(ctx, 0) };
}

const table = loadTable(TABLE);
const COUNTS = { rows: 61, pairs: 19, unreachable: 6, cases: 47 };

test("the reload-gate table runs through the pure machine", async () => {
  assert.deepEqual(await runTable(reloadGateMachine, table), COUNTS);
});

test("the reload-gate table drives ReloadGate through a SessionHost", async () => {
  assert.deepEqual(await runTable(reloadGateSpec, table, { drive }), COUNTS);
});
