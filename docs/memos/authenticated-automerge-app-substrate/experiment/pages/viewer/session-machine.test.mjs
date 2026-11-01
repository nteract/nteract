// The viewer-session table, run through the pure machine and driven through
// PageSession. The drive builds a real session in each row's phase, delivers
// the event through the method that handles it, and reads `phase$` back. It
// observes effects on the instance methods they call, never on the machine's
// own effect list.
import test from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import "fake-indexeddb/auto";
import * as A from "@automerge/automerge";
import { generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import { PageSession } from "./session.mjs";
import { createPageData, initializePage } from "../model/page.mjs";
import { encodeSnapshot, writeLocalPage } from "./local-pages.mjs";
import { reject } from "../shared/machine.mjs";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import {
  REJECT,
  isLive,
  pauseOf,
  retirementOf,
  viewerSessionMachine,
  viewerSessionSpec,
} from "./session-machine.mjs";

const TABLE = new URL("../test/fixtures/machines/viewer-session.json", import.meta.url);

const DENIED = "You no longer have access to this Page. Your local copy is kept on this device.";
const TRASHED = "This Page is in its owner's Trash. Your local copy is kept on this device.";
const CHANGED =
  "Your permissions changed. Reload the current Page; unsynced edits remain available as a local draft.";

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
    flush: deferred(),
    persist: deferred(),
    retire: deferred(),
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
  const record = (name, method) => {
    const original = method.bind(session);
    return (...args) => {
      ctx.raw.push(name);
      return original(...args);
    };
  };
  session.drainBeforeClose = record("drain", session.drainBeforeClose);
  session.retireLocal = () => {
    ctx.raw.push("retire");
    // A failed archive's retry waits on a fresh write.
    if (ctx.retireFailed) ctx.retire = deferred();
    return ctx.retire.promise;
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
  if (!startable) {
    session.acceptAuthentication(auth);
    session.access = access(role);
    session.replicaKey = "1:writer";
    session.repo = repo;
    session.statusId = "saving";
    if (!opening) {
      session.handle = handle;
      session.localPage = { ...localPage };
      session.dispatch({ type: "opened", denied: false });
    }
    session.updateCapabilities();
  }
  return ctx;
}

function track(ctx, promise) {
  ctx.pending = Promise.resolve(promise);
  ctx.pending.catch(() => {});
}

function applyPause(ctx, { reason, auth }) {
  const session = ctx.session;
  if (reason === "access") session.pauseForAccess(DENIED, { denied: true });
  else if (reason === "trash") session.pauseForAccess(TRASHED, { trashed: true });
  else if (reason === "reload") session.pauseForAccess(CHANGED);
  if (reason === "auth" || auth) session.requireSignIn();
}

function endDrain(ctx, saved) {
  const session = ctx.session;
  if (saved) {
    session.savedHeads = A.getHeads(ctx.doc);
    session.localPage = { ...session.localPage, pending: false };
    session.statusId = "saved";
  } else session.statusId = "offline";
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
      track(ctx, session.leave({ drain: true }));
      if (state.reason) finish = () => applyPause(ctx, state);
      break;
    case "checkpointing":
      if (state.archive) {
        applyPause(ctx, { reason: "reload", auth: state.auth });
        track(ctx, session.reloadForAccess());
        await settle();
      } else if (state.drained) {
        track(ctx, session.leave({ drain: true }));
        endDrain(ctx, state.saved);
        await settle();
      } else track(ctx, session.close());
      break;
    case "closed":
      if (state.archived) {
        applyPause(ctx, { reason: "reload" });
        track(ctx, session.reloadForAccess());
      } else if (state.drained) {
        track(ctx, session.leave({ drain: true }));
        endDrain(ctx, state.saved);
        await settle();
      } else track(ctx, session.close());
      ctx.flush.resolve();
      if (state.checkpointWritten) ctx.persist.resolve();
      else ctx.persist.reject(Error("disk"));
      await ctx.pending.catch(() => {});
      await settle();
      break;
    case "retiring":
    case "retired":
    case "retireFailed": {
      if (state.released) {
        track(ctx, session.close());
        ctx.flush.resolve();
        ctx.persist.resolve();
        await ctx.pending.catch(() => {});
        await settle();
      }
      if (state.held) {
        // Serializing the live copy fails once; Try again captures it.
        const exportRecovery = session.exportRecovery.bind(session);
        let failures = 1;
        session.exportRecovery = (...args) => {
          if (failures-- > 0) throw Error("could not save the document");
          return exportRecovery(...args);
        };
      }
      const refusal = state.reason === "deleted" ? session.markDeleted() : session.revoke();
      track(ctx, refusal);
      if (state.name === "retired") ctx.retire.resolve();
      if (state.name === "retireFailed" && !state.held) {
        ctx.retire.reject(Error("quota"));
        ctx.retireFailed = true;
      }
      if (state.name !== "retiring") await ctx.pending.catch(() => {});
      await settle();
      break;
    }
  }
  return () => {
    finish();
    ctx.raw.length = 0;
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

/** Deliver the event through its handler. Returns a promise to await before
 * reading back, or nothing when the phase must be read in the same tick: a
 * drain in flight reacts to a pause on the next microtask. */
function deliver(ctx, event) {
  const session = ctx.session;
  const sync = session.phase$.snapshot().name === "draining";
  switch (event.type) {
    case "opened":
      return session.start().then(() => clearInterval(session.presenceTimer));
    case "accessChanged": {
      if (event.grant === "deleted") {
        void session.markDeleted().catch(() => {});
        return undefined;
      }
      // The host's page_access_denied, through the handler openConnection,
      // receipts and acceptPageAccess share.
      if (event.grant === "revoked") {
        void session.revoke().catch(() => {});
        return undefined;
      }
      // A refusal without a code keeps the copy (pauseForAccess).
      if (event.grant === "denied" && !event.tab) {
        session.pauseForAccess(DENIED, { denied: true });
        return undefined;
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
      return undefined;
    case "trash":
      // The /api/connect 403 page_trashed handler in openConnection.
      session.pauseForAccess(TRASHED, { trashed: true });
      return undefined;
    case "restore": {
      const closing = session.restore();
      if (closing) track(ctx, closing);
      return undefined;
    }
    case "reloadAccess": {
      const reloading = session.reloadForAccess();
      reloading.catch(() => {});
      if (session.phase$.snapshot().name === "checkpointing") track(ctx, reloading);
      return settle();
    }
    case "leave":
      track(ctx, session.leave({ drain: event.drain }));
      return undefined;
    case "drained":
      if (!pauseOf(session.phase$.snapshot()).auth && !session.phase$.snapshot().reason)
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
      // A deletion found by the checkpoint retires the copy; its archive
      // is still writing when the phase is read.
      return event.deleted ? settle().then(settle) : ctx.pending.catch(() => {}).then(settle);
    case "retireRetry":
      track(ctx, session.retryRetirement());
      return settle();
    case "retireOk":
      ctx.retire.resolve();
      return ctx.pending.catch(() => {}).then(settle);
    case "retireFail":
      // A capture failure reports inside the retire effect, before any
      // archive write: deliver its result as that effect would.
      if (event.held) {
        session.dispatch({ type: "retireFail", held: true });
        return settle();
      }
      ctx.retire.reject(Error("quota"));
      return ctx.pending.catch(() => {}).then(settle);
  }
  return undefined;
}

/** The flags PageSession still exposes must agree with its phase. */
function assertFlags(session, phase) {
  const pause = pauseOf(phase);
  assert.equal(session.alive, isLive(phase));
  const retirement = retirementOf(phase);
  assert.equal(session.deleted, retirement === "deleted");
  assert.equal(session.revoked, retirement === "access");
  assert.equal(session.hidden, retirement !== undefined);
  assert.equal(session.recoveryArchived, phase.name === "retired");
  assert.equal(session.retireFailed, phase.name === "retireFailed");
  assert.equal(session.authRequired, pause.auth);
  // An archived replica still needs its replacement: Reload stays offered.
  assert.equal(
    session.accessReloadRequired,
    pause.access === "reload" || (phase.name === "closed" && !!phase.archived),
  );
  if (phase.name !== "opening")
    assert.equal(
      session.accessDenied,
      pause.access === "access" || pause.access === "trash" || retirement === "access",
    );
  assert.equal(session.checkpointWritten, phase.name === "closed" && phase.checkpointWritten);
}

function effectsOf(ctx, event) {
  const checkpointResult = event.type === "checkpointOk" || event.type === "checkpointFail";
  const effects = [];
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

/** Calls that change nothing name the guard that refused them. */
function guardFor(state, event) {
  switch (state.name) {
    case "retiring":
    case "retired":
    case "retireFailed":
      if (event.type === "leave") return REJECT.alreadyClosing;
      return state.reason === "deleted" ? REJECT.deleted : REJECT.revoked;
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
  const next = ctx.session.phase$.snapshot();
  assertFlags(ctx.session, next);
  const effects = effectsOf(ctx, event);
  const reason = guardFor(state, event);
  if (reason && effects.length === 0 && isDeepStrictEqual(next, state))
    return reject(state, reason);
  return { state: next, effects };
}

const table = loadTable(TABLE);
const COUNTS = { rows: 102, pairs: 51, unreachable: 66, cases: 75 };

test("the viewer-session table runs through the pure machine", async () => {
  assert.deepEqual(await runTable(viewerSessionMachine, table), COUNTS);
});

test("the viewer-session table drives PageSession and its drain", async (t) => {
  PageSession.open = async () => {
    current.raw.push("reopen");
    return {};
  };
  t.after(() => {
    PageSession.open = openReplacement;
  });
  assert.deepEqual(await runTable(viewerSessionSpec, table, { drive }), COUNTS);
});
