// The viewer-session table, driven through PageSession and the reload gate's
// drain. Each row builds a session in the row's phase from flags and calls,
// delivers the event through the method that handles it today, and reads the
// phase back from the same flags.
import test from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import { generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import { PageSession } from "./session.mjs";
import { ReloadGate } from "./build-freshness.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { encodeSnapshot, writeLocalPage } from "./local-pages.mjs";
import { reject } from "../shared/machine.mjs";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import { viewerSessionSpec } from "./session-machine.mjs";

const TABLE = new URL("../test/fixtures/machines/viewer-session.json", import.meta.url);

const DENIED = "You no longer have access to this Page. Your local copy is kept on this device.";
const TRASHED = "This Page is in its owner's Trash. Your local copy is kept on this device.";
const CHANGED =
  "Your permissions changed. Reload the current Page; unsynced edits remain available as a local draft.";

// Guard names for calls that change nothing today.
const REJECT = {
  noReload: "No access reload is pending",
  restorePaused: "Restore needs a preview whose access isn't paused",
  closing: "The session is closing",
  closed: "The session is closed",
  deleted: "The Page is deleted",
  alreadyClosing: "The session is already closing",
  alreadyClosed: "The session is already closed",
  archiving: "An access reload is already archiving this replica",
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
  };
}
const access = (role = "editor", generation = 1) => ({
  role,
  generation,
  revision: generation,
  canRead: role !== "none",
  canWrite: ["owner", "editor"].includes(role),
  canComment: ["owner", "editor"].includes(role),
  canManageAccess: role === "owner",
  canDelete: role === "owner",
  canRestore: role !== "none",
});

let current;
const openReplacement = PageSession.open;

/** A PageSession with its storage, network and backend replaced by recorders
 * and held promises. `ctx.raw` lists the calls an event made. */
async function fixture({ opening = false, startable = false, role = "editor" } = {}) {
  const auth = {
    identity: { principal: crypto.randomUUID(), displayName: "Writer" },
    canWrite: true,
  };
  const pageId = crypto.randomUUID();
  const documentId = interpretAsDocumentId(generateAutomergeUrl());
  const doc = A.change(A.from(createPageData({ pageId, title: "Garden notes" })), initializePage);
  const now = new Date().toISOString();
  const localPage = {
    principal: auth.identity.principal,
    page_id: pageId,
    document_id: documentId,
    title: doc.title,
    created_at: now,
    updated_at: now,
    canWrite: role !== "none",
    access: access(role),
    replicaKey: "1:writer",
    registered: true,
    pending: true,
    snapshot: encodeSnapshot(A.save(doc)),
  };
  await writeLocalPage(auth.identity, localPage);
  const session = new PageSession(pageId, {
    authentication: auth,
    refreshSession: async () => auth,
  });
  const ctx = {
    session,
    auth,
    doc,
    raw: [],
    gate: new ReloadGate({ timers: manualTimers() }),
    flush: deferred(),
    persist: deferred(),
    opening: opening || startable,
  };
  current = ctx;
  const handle = { doc: () => doc, documentId, on() {} };
  const repo = {
    flush: () => {
      ctx.raw.push("flush");
      return ctx.flush.promise;
    },
    find: async () => handle,
  };
  session.disconnectSockets = () => {
    ctx.raw.push("disconnect");
    return Promise.resolve();
  };
  session.persistLocal = () => {
    ctx.raw.push("persistLocal");
    return ctx.persist.promise;
  };
  session.releaseLocal = async () => {
    ctx.raw.push("release");
  };
  session.initializeLocal = async (key) => {
    ctx.raw.push("initialize");
    session.replicaKey = key;
    session.repo = repo;
    session.backend = {
      open: () => ({
        events: (async function* () {
          yield { type: "local-load-complete" };
        })(),
        close: async () => {},
      }),
      storeSnapshot: async () => {},
    };
  };
  session.retryConnection = async () => {};
  const close = session.close.bind(session);
  session.close = () => {
    const first = !ctx.closeCalled;
    if (first) {
      ctx.closeCalled = true;
      if (ctx.drainCalled) {
        try {
          ctx.savedAtClose = !!session.deleted || !session.recoveryPending;
        } catch {
          ctx.savedAtClose = false;
        }
      }
    }
    const promise = close();
    if (first) {
      ctx.pending = promise;
      promise.then(
        () => (ctx.closeSettled = true),
        () => (ctx.closeSettled = true),
      );
    }
    return promise;
  };
  if (!startable) {
    session.acceptAuthentication(auth);
    session.access = access(role);
    session.replicaKey = "1:writer";
    session.repo = repo;
    session.status = "Saving";
    if (!opening) {
      session.handle = handle;
      session.localPage = { ...localPage };
    }
    session.updateCapabilities();
  }
  return ctx;
}

/** Leave through the reload gate, as the app does when navigating away. */
function leaveThroughGate(ctx) {
  if (ctx.closeCalled || ctx.drainCalled) return;
  ctx.drainCalled = true;
  ctx.raw.push("drain");
  ctx.gate.hold(ctx.session);
  void ctx.gate.drainAndClose(ctx.session).catch(() => {});
}

function reloadForAccess(ctx) {
  const reloading = ctx.session.reloadForAccess();
  ctx.archiving = true;
  ctx.pending = reloading;
  reloading.then(
    () => (ctx.archiving = false),
    () => (ctx.archiving = false),
  );
  return reloading;
}

function applyPause(ctx, { reason, auth }) {
  const session = ctx.session;
  if (reason === "access") session.pauseForAccess(DENIED, { denied: true });
  else if (reason === "trash") session.pauseForAccess(TRASHED, { denied: true });
  else if (reason === "reload") session.pauseForAccess(CHANGED);
  if (reason === "auth" || auth) session.requireSignIn();
}

function endDrain(ctx, saved) {
  const session = ctx.session;
  if (saved) {
    session.savedHeads = A.getHeads(ctx.doc);
    session.localPage = { ...session.localPage, pending: false };
    session.status = "Saved";
  } else session.status = "Offline";
  session.emit();
}

/** Build the row's state. Returns a function that finishes it synchronously:
 * a pause while draining ends the drain on the next microtask, so the event
 * has to arrive in the same tick. */
async function prepare(state, event) {
  const startable = event.type === "opened";
  const role = startable && event.denied ? "none" : "editor";
  const ctx = await fixture({ opening: state.name === "opening", startable, role });
  const session = ctx.session;
  let finish = () => {};
  switch (state.name) {
    case "opening":
    case "open":
      break;
    case "paused":
      applyPause(ctx, state);
      break;
    case "draining":
      leaveThroughGate(ctx);
      if (state.reason) finish = () => applyPause(ctx, state);
      break;
    case "checkpointing":
      if (state.archive) {
        applyPause(ctx, { reason: "reload", auth: state.auth });
        void reloadForAccess(ctx).catch(() => {});
        await settle();
        if (state.reason !== "reload") applyPause(ctx, state);
      } else if (state.drained) {
        leaveThroughGate(ctx);
        endDrain(ctx, state.saved);
        await settle();
      } else void session.close();
      break;
    case "closed":
      if (state.archived) {
        applyPause(ctx, { reason: "reload" });
        void reloadForAccess(ctx).catch(() => {});
      } else if (state.drained) {
        leaveThroughGate(ctx);
        endDrain(ctx, state.saved);
        await settle();
      } else void session.close();
      ctx.flush.resolve();
      if (state.checkpointWritten) ctx.persist.resolve();
      else ctx.persist.reject(Error("disk"));
      await ctx.pending.catch(() => {});
      await settle();
      break;
    case "deleted":
      if (state.closing) await session.markDeleted();
      else void session.markDeleted();
      break;
  }
  return () => {
    finish();
    ctx.raw.length = 0;
    ctx.wasDeleted = !!session.deleted;
    return ctx;
  };
}

/** Access the host would answer: the same key, a new generation, or none. */
function grantFor(session, grant) {
  const generation = session.access?.generation ?? 1;
  if (grant === "denied") return access("none", generation + 1);
  if (grant === "changed") return access("editor", generation + 1);
  return access("editor", generation);
}

/** Deliver the event through today's handler. Returns a promise to await
 * before reading back, or nothing when the phase must be read in the same
 * tick: a drain in flight reacts to a pause on the next microtask. */
function deliver(ctx, event) {
  const session = ctx.session;
  const sync = ctx.drainCalled && !ctx.closeCalled;
  switch (event.type) {
    case "opened":
      return session.start().then(() => clearInterval(session.presenceTimer));
    case "accessChanged": {
      if (event.grant === "deleted") {
        void session.markDeleted().catch(() => {});
        return;
      }
      if (event.tab) {
        const next = grantFor(session, event.grant);
        return writeLocalPage(ctx.auth.identity, { ...session.localPage, access: next }).then(() =>
          session.localAccessChanged(),
        );
      }
      const accepting = session.acceptPageAccess(grantFor(session, event.grant));
      accepting.catch(() => {});
      return sync ? undefined : accepting.catch(() => {});
    }
    case "signIn":
      session.acceptAuthentication(event.ok ? ctx.auth : { identity: null });
      return;
    case "trash":
      // The /api/connect 403 page_trashed handler in openConnection.
      session.pauseForAccess(TRASHED, { denied: true });
      return;
    case "restore":
      // The preview's Restore button, shown when canRestore, reopens the Page;
      // the app leaves the preview through the gate first.
      if (session.canRestore) leaveThroughGate(ctx);
      return;
    case "reloadAccess": {
      const before = ctx.raw.length;
      reloadForAccess(ctx).catch(() => {});
      return settle().then(() => {
        if (ctx.raw.length === before) ctx.archiving = false;
      });
    }
    case "leave":
      if (event.drain) leaveThroughGate(ctx);
      else void session.close().catch(() => {});
      return;
    case "drained":
      if (!session.accessDenied && !session.accessReloadRequired && !session.authRequired)
        endDrain(ctx, event.saved);
      return settle();
    case "checkpointOk":
      ctx.flush.resolve();
      ctx.persist.resolve();
      return ctx.pending.catch(() => {}).then(settle);
    case "checkpointFail":
      ctx.flush.resolve();
      ctx.persist.reject(
        event.deleted
          ? Object.assign(Error("Page was deleted"), { code: "LOCAL_PAGE_DELETED" })
          : Error("disk"),
      );
      return ctx.pending.catch(() => {}).then(settle);
  }
}

function pauseFromFlags(session) {
  let reason;
  if (session.accessDenied) reason = session.accessProblem === TRASHED ? "trash" : "access";
  else if (session.accessReloadRequired) reason = "reload";
  if (reason) return session.authRequired ? { reason, auth: true } : { reason };
  return session.authRequired ? { reason: "auth" } : {};
}

/** Today's phase, spread across PageSession flags and the gate's membership. */
function phaseOf(ctx) {
  const session = ctx.session;
  if (session.deleted)
    return ctx.closeCalled ? { name: "deleted", closing: true } : { name: "deleted" };
  if (ctx.closeCalled) {
    const leaving = ctx.drainCalled
      ? { drained: true, saved: ctx.savedAtClose }
      : { drained: false };
    if (!ctx.closeSettled) return { name: "checkpointing", ...leaving };
    return {
      name: "closed",
      checkpointWritten: session.checkpointWritten === true,
      ...leaving,
      ...(session.skipCloseCheckpoint ? { archived: true } : {}),
    };
  }
  const pause = pauseFromFlags(session);
  if (ctx.archiving) return { name: "checkpointing", drained: false, archive: true, ...pause };
  if (ctx.drainCalled) return { name: "draining", ...pause };
  if (ctx.opening && !pause.reason && !session.handle) return { name: "opening" };
  return pause.reason ? { name: "paused", ...pause } : { name: "open" };
}

function effectsOf(ctx, event) {
  const checkpointResult = event.type === "checkpointOk" || event.type === "checkpointFail";
  const effects = [];
  if (event.type === "accessChanged" && event.grant === "deleted" && !ctx.wasDeleted)
    effects.push("forget");
  for (const call of ctx.raw) {
    if (call === "flush") {
      if (!checkpointResult) effects.push(event.type === "reloadAccess" ? "archive" : "checkpoint");
    } else if (call === "persistLocal") {
      if (!checkpointResult) effects.push("persistLocal");
    } else if (call === "release") {
      effects.push(ctx.raw.includes("initialize") ? "rekey" : "release");
    } else if (call !== "initialize") effects.push(call);
  }
  return effects.map((type) => ({ type }));
}

function guardFor(state, event) {
  switch (state.name) {
    case "deleted":
      return event.type === "leave" ? REJECT.alreadyClosing : REJECT.deleted;
    case "closed":
      return event.type === "leave" ? REJECT.alreadyClosed : REJECT.closed;
    case "checkpointing":
      if (state.archive) return event.type === "reloadAccess" ? REJECT.archiving : undefined;
      return event.type === "leave" ? REJECT.alreadyClosing : REJECT.closing;
    default:
      if (event.type === "reloadAccess") return REJECT.noReload;
      if (event.type === "restore") return REJECT.restorePaused;
      return undefined;
  }
}

async function drive(state, event) {
  const finish = await prepare(state, event);
  const ctx = finish();
  const pending = deliver(ctx, event);
  if (pending) await pending;
  const next = phaseOf(ctx);
  const effects = effectsOf(ctx, event);
  const reason = guardFor(state, event);
  if (reason && effects.length === 0 && isDeepStrictEqual(next, state))
    return reject(state, reason);
  return { state: next, effects };
}

test("the viewer-session table drives PageSession and the reload gate's drain", async (t) => {
  PageSession.open = async () => {
    current.raw.push("reopen");
    return {};
  };
  t.after(() => {
    PageSession.open = openReplacement;
  });
  const result = await runTable(viewerSessionSpec, loadTable(TABLE), { drive });
  assert.deepEqual(result, { rows: 76, pairs: 38, unreachable: 32, cases: 58 });
});
