/**
 * A viewer's Page session as a state machine.
 *
 * One PageSession owns one Page replica in this tab: its IndexedDB checkpoint,
 * its native backend and identity lock, and its sockets. The phase says what
 * the session may still do with them.
 *
 * States:
 * - opening: start() is loading the replica; nothing is installed yet.
 * - open: syncing and, when access allows, editable.
 * - paused: the replica keeps its edits but stops syncing. `reason` is the
 *   strongest pause: `access` (the host denied this account), `trash` (the
 *   Page is in its owner's Trash), `reload` (the grant changed, so this replica
 *   must be archived and replaced), or `auth` (sign in again). `auth: true` on
 *   an access, trash or reload pause says sign-in is also required.
 * - draining: the session is being left. It keeps syncing until its receipt,
 *   a pause, or CLOSE_DRAIN_MS, so leaving never drops a save. It carries the
 *   same pause fields as `paused`.
 * - checkpointing: close() is writing the final IndexedDB checkpoint. With
 *   `archive: true` it is instead archiving a reload-required replica before
 *   retiring its key; the session stays live, and `reason`/`auth` are the pause
 *   it returns to if archiving fails.
 * - closed: the backend is released. `checkpointWritten` says an IndexedDB
 *   record holds every edit this replica accepted; `archived` says an access
 *   reload archived it and a replacement may be opened.
 * - deleted: the Page is gone. The local copy is forgotten; `closing` says the
 *   backend release has started.
 *
 * `drained` and `saved` record how a session was left: through the drain, and
 * whether the host had every edit when the drain ended. The reload gate keeps
 * a record of Pages left with unsaved edits.
 *
 * Events: `opened` (start() finished; `denied` when the cached access fact
 * denies reading), `accessChanged` (the host's or another tab's access fact:
 * `grant` same, changed, denied or deleted; `tab` when another tab already
 * wrote it), `signIn` (an authentication result), `trash` (the host answered
 * that the Page is in its owner's Trash), `restore` (the owner restored the
 * previewed Page, so the read-only preview leaves), `reloadAccess` (Reload
 * current Page), `leave` (the host releases the session, through the drain or
 * by closing at once), `drained`, `checkpointOk` and `checkpointFail`.
 *
 * Effects: `disconnect` closes sockets and stops reconnecting; `persistLocal`
 * writes the access fact and a checkpoint to IndexedDB; `drain` waits for the
 * receipt; `checkpoint` flushes and writes the final checkpoint; `archive`
 * keeps a recovery record and a reset marker before a key is retired;
 * `release` shuts the backend down and frees the identity lock; `reopen` opens
 * the replacement session; `forget` deletes the local copy; `rekey` moves an
 * opening session to the replica key the host's grant names.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

export const PAUSE_REASONS = Object.freeze(["auth", "access", "trash", "reload"]);
const ACCESS_PAUSES = new Set(["access", "trash", "reload"]);
const GRANTS = new Set(["same", "changed", "denied", "deleted"]);

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const isBoolean = (value) => typeof value === "boolean";
const flag = (value, field) =>
  check(value === undefined || value === true, `${field} is true or absent`);

function pauseFields(state, required) {
  if (required) check(PAUSE_REASONS.includes(state.reason), "reason must be a pause reason");
  else check(state.reason === undefined || PAUSE_REASONS.includes(state.reason), "bad reason");
  flag(state.auth, "auth");
  check(
    !state.auth || ACCESS_PAUSES.has(state.reason),
    "auth marks an access, trash or reload pause",
  );
}

function leaving(state) {
  check(isBoolean(state.drained), "drained must be a boolean");
  check(isBoolean(state.saved) === state.drained, "saved is recorded only for a drained session");
}

const fieldless = (value) => only(value, ["name"]);
const typed = (keys) => (value) => only(value, ["type", ...keys]);

export const viewerSessionSpec = Object.freeze({
  name: "viewer-session",
  states: ["opening", "open", "paused", "draining", "checkpointing", "closed", "deleted"],
  events: [
    "opened",
    "accessChanged",
    "signIn",
    "trash",
    "restore",
    "reloadAccess",
    "leave",
    "drained",
    "checkpointOk",
    "checkpointFail",
  ],
  unreachable: [
    ["opening", "restore", "Restore is offered only on an installed session"],
    ["opening", "reloadAccess", "Reload current Page is offered only on an installed session"],
    ["opening", "drained", "the interpreter delivers drained only while draining"],
    [
      "opening",
      "checkpointOk",
      "the interpreter delivers a checkpoint result only while checkpointing",
    ],
    [
      "opening",
      "checkpointFail",
      "the interpreter delivers a checkpoint result only while checkpointing",
    ],
    ["open", "opened", "start() reports opened once, before the session is installed"],
    ["open", "drained", "the interpreter delivers drained only while draining"],
    [
      "open",
      "checkpointOk",
      "the interpreter delivers a checkpoint result only while checkpointing",
    ],
    [
      "open",
      "checkpointFail",
      "the interpreter delivers a checkpoint result only while checkpointing",
    ],
    ["paused", "opened", "a pause while opening aborts start(), which then closes the session"],
    ["paused", "drained", "the interpreter delivers drained only while draining"],
    [
      "paused",
      "checkpointOk",
      "the interpreter delivers a checkpoint result only while checkpointing",
    ],
    [
      "paused",
      "checkpointFail",
      "the interpreter delivers a checkpoint result only while checkpointing",
    ],
    ["draining", "opened", "start() reports opened once, before the session is installed"],
    [
      "draining",
      "restore",
      "the host released a draining session; Restore acts on the installed one",
    ],
    [
      "draining",
      "reloadAccess",
      "the host released a draining session; Reload acts on the installed one",
    ],
    ["draining", "leave", "the host leaves a session once; deletion closes through accessChanged"],
    [
      "draining",
      "checkpointOk",
      "the interpreter delivers a checkpoint result only while checkpointing",
    ],
    [
      "draining",
      "checkpointFail",
      "the interpreter delivers a checkpoint result only while checkpointing",
    ],
    ["checkpointing", "opened", "start() reports opened once, before the session is installed"],
    ["checkpointing", "restore", "Restore is hidden while closing or while access is paused"],
    ["checkpointing", "drained", "the interpreter delivers drained only while draining"],
    ["closed", "opened", "start() reports opened once, before the session is installed"],
    ["closed", "restore", "a closed session is no longer installed"],
    ["closed", "drained", "the interpreter delivers drained only while draining"],
    [
      "closed",
      "checkpointOk",
      "the interpreter delivers a checkpoint result only while checkpointing",
    ],
    [
      "closed",
      "checkpointFail",
      "the interpreter delivers a checkpoint result only while checkpointing",
    ],
    ["deleted", "opened", "start() reports opened once, before the session is installed"],
    ["deleted", "restore", "the host can't restore a deleted Page"],
    ["deleted", "drained", "the interpreter delivers drained only while draining"],
    [
      "deleted",
      "checkpointOk",
      "the interpreter delivers a checkpoint result only while checkpointing",
    ],
    [
      "deleted",
      "checkpointFail",
      "the interpreter delivers a checkpoint result only while checkpointing",
    ],
  ],
  cases: {
    "opening/opened": ["readable", "denied"],
    "opening/accessChanged": ["same", "changed", "denied", "deleted"],
    "opening/signIn": ["ok", "failed"],
    "open/accessChanged": ["same", "changed", "denied", "deleted", "tab"],
    "open/signIn": ["ok", "failed"],
    "open/leave": ["drain", "close"],
    "paused/accessChanged": [
      "same-clears-access",
      "same-keeps-sign-in",
      "same-clears-reload",
      "changed",
      "denied-keeps-sign-in",
      "deleted",
      "tab",
    ],
    "paused/signIn": ["ok-resumes", "ok-keeps-access", "failed-repeats", "failed-adds-sign-in"],
    "paused/restore": ["sign-in", "access-paused"],
    "paused/reloadAccess": ["reload", "reload-with-sign-in", "not-reload"],
    "paused/leave": ["drain", "close"],
    "draining/accessChanged": ["same", "changed", "denied", "deleted"],
    "draining/signIn": ["ok", "failed"],
    "draining/drained": ["saved", "unsaved", "paused"],
    "checkpointing/accessChanged": ["closing", "archiving"],
    "checkpointing/signIn": ["closing", "archiving"],
    "checkpointing/checkpointOk": ["close", "drained", "archive"],
    "checkpointing/checkpointFail": ["error", "deleted", "archive"],
    "closed/reloadAccess": ["archived", "not-archived"],
    "deleted/leave": ["release", "already-closing"],
  },
  validate: {
    states: {
      opening: fieldless,
      open: fieldless,
      paused(state) {
        only(state, ["name", "reason", "auth"]);
        pauseFields(state, true);
      },
      draining(state) {
        only(state, ["name", "reason", "auth"]);
        pauseFields(state, false);
      },
      checkpointing(state) {
        only(state, ["name", "drained", "saved", "archive", "reason", "auth"]);
        leaving(state);
        flag(state.archive, "archive");
        if (state.archive) {
          check(!state.drained, "an archive is not a drained close");
          pauseFields(state, false);
        } else
          check(state.reason === undefined && state.auth === undefined, "only an archive pauses");
      },
      closed(state) {
        only(state, ["name", "checkpointWritten", "drained", "saved", "archived"]);
        check(isBoolean(state.checkpointWritten), "checkpointWritten must be a boolean");
        leaving(state);
        flag(state.archived, "archived");
        check(
          !state.archived || (state.checkpointWritten && !state.drained),
          "an archive wrote its record",
        );
      },
      deleted(state) {
        only(state, ["name", "closing"]);
        flag(state.closing, "closing");
      },
    },
    events: {
      opened(event) {
        only(event, ["type", "denied"]);
        check(isBoolean(event.denied), "denied must be a boolean");
      },
      accessChanged(event) {
        only(event, ["type", "grant", "tab"]);
        check(GRANTS.has(event.grant), "grant must be same, changed, denied or deleted");
        flag(event.tab, "tab");
        check(!event.tab || ["changed", "denied"].includes(event.grant), "a tab writes a pause");
      },
      signIn(event) {
        only(event, ["type", "ok"]);
        check(isBoolean(event.ok), "ok must be a boolean");
      },
      trash: typed([]),
      restore: typed([]),
      reloadAccess: typed([]),
      leave(event) {
        only(event, ["type", "drain"]);
        check(isBoolean(event.drain), "drain must be a boolean");
      },
      drained(event) {
        only(event, ["type", "saved"]);
        check(isBoolean(event.saved), "saved must be a boolean");
      },
      checkpointOk: typed([]),
      checkpointFail(event) {
        only(event, ["type", "deleted"]);
        check(isBoolean(event.deleted), "deleted must be a boolean");
      },
    },
    effects: {
      disconnect: typed([]),
      persistLocal: typed([]),
      drain: typed([]),
      checkpoint: typed([]),
      archive: typed([]),
      release: typed([]),
      reopen: typed([]),
      forget: typed([]),
      rekey: typed([]),
    },
  },
});

export const REJECT = Object.freeze({
  noReload: "No access reload is pending",
  restorePaused: "Restore needs a preview whose access isn't paused",
  closing: "The session is closing",
  closed: "The session is closed",
  deleted: "The Page is deleted",
  alreadyClosing: "The session is already closing",
  alreadyClosed: "The session is already closed",
  archiving: "An access reload is already archiving this replica",
});

/** The pause a state carries, as the access pause and whether sign-in is
 * also required. Only paused, draining and archiving states carry one. */
export function pauseOf(state) {
  const carries =
    state.name === "paused" ||
    state.name === "draining" ||
    (state.name === "checkpointing" && state.archive);
  const reason = carries ? state.reason : undefined;
  if (!reason) return { access: "none", auth: false };
  if (reason === "auth") return { access: "none", auth: true };
  return { access: reason, auth: state.auth === true };
}

/** The pause a phase reports, strongest first, or undefined. */
export const pauseReason = (state) => {
  const { access, auth } = pauseOf(state);
  if (access !== "none") return access;
  return auth ? "auth" : undefined;
};

/** Whether the session still owns a live replica: it can receive changes,
 * write checkpoints and be paused. */
export const isLive = (state) =>
  state.name === "opening" ||
  state.name === "open" ||
  state.name === "paused" ||
  state.name === "draining" ||
  (state.name === "checkpointing" && state.archive === true);

function fields({ access, auth }) {
  if (access !== "none") return auth ? { reason: access, auth: true } : { reason: access };
  return auth ? { reason: "auth" } : {};
}
/** Shape a live state: `open` becomes paused when a pause remains. */
function liveState(name, pause) {
  const f = fields(pause);
  if (name === "open") return f.reason ? { name: "paused", ...f } : { name: "open" };
  if (name === "archive") return { name: "checkpointing", drained: false, archive: true, ...f };
  return { name, ...f };
}
const ok = (state, ...effects) => ({ state, effects: effects.map((type) => ({ type })) });

/** Access and sign-in answers on a live session, shaped as `name`. */
function pauseStep(event, name, pause) {
  switch (event.type) {
    case "accessChanged": {
      if (event.grant === "deleted") return ok({ name: "deleted" }, "forget");
      if (event.grant === "same") return ok(liveState(name, { ...pause, access: "none" }));
      const access = event.grant === "denied" ? "access" : "reload";
      // Another tab already wrote the fact; recovery stays in its checkpoint.
      const effects = event.tab ? ["disconnect"] : ["disconnect", "persistLocal"];
      return ok(liveState(name, { ...pause, access }), ...effects);
    }
    case "trash":
      return ok(liveState(name, { ...pause, access: "trash" }), "disconnect", "persistLocal");
    case "signIn":
      return event.ok
        ? ok(liveState(name, { ...pause, auth: false }))
        : ok(liveState(name, { ...pause, auth: true }), "disconnect");
  }
  return undefined;
}

function closedState(state, checkpointWritten) {
  const closed = { name: "closed", checkpointWritten, drained: state.drained };
  if (state.drained) closed.saved = state.saved;
  return closed;
}

function transition(state, event) {
  switch (state.name) {
    case "opening": {
      if (event.type === "opened")
        return ok(event.denied ? { name: "paused", reason: "access" } : { name: "open" });
      // First remote opening: no history exists yet, so pick the grant's key.
      if (event.type === "accessChanged" && event.grant === "changed" && !event.tab)
        return ok(state, "rekey");
      if (event.type === "accessChanged" && event.grant === "same") return ok(state);
      if (event.type === "signIn" && event.ok) return ok(state);
      const paused = pauseStep(event, "open", pauseOf(state));
      if (paused) return paused;
      // leave: a failed start() closes at once.
      return ok({ name: "checkpointing", drained: false }, "checkpoint");
    }
    case "open":
    case "paused": {
      const pause = pauseOf(state);
      const paused = pauseStep(event, "open", pause);
      if (paused) return paused;
      if (event.type === "restore")
        return pause.access === "none"
          ? ok(liveState("draining", pause), "drain")
          : reject(state, REJECT.restorePaused);
      if (event.type === "reloadAccess")
        return pause.access === "reload"
          ? ok(liveState("archive", pause), "archive")
          : reject(state, REJECT.noReload);
      return event.drain
        ? ok(liveState("draining", pause), "drain")
        : ok({ name: "checkpointing", drained: false }, "checkpoint");
    }
    case "draining": {
      const paused = pauseStep(event, "draining", pauseOf(state));
      if (paused) return paused;
      return ok({ name: "checkpointing", drained: true, saved: event.saved }, "checkpoint");
    }
    case "checkpointing": {
      if (event.type === "checkpointOk")
        return state.archive
          ? ok(
              { name: "closed", checkpointWritten: true, drained: false, archived: true },
              "release",
              "reopen",
            )
          : ok(closedState(state, true), "release");
      if (event.type === "checkpointFail") {
        // A failed archive leaves the replica live, still blocking Reload.
        if (state.archive) return ok(liveState("open", pauseOf(state)));
        if (event.deleted) return ok({ name: "deleted", closing: true }, "release");
        return ok(closedState(state, false), "release");
      }
      if (state.archive) {
        const paused = pauseStep(event, "archive", pauseOf(state));
        if (paused) return paused;
        return reject(state, event.type === "reloadAccess" ? REJECT.archiving : REJECT.closing);
      }
      // A late 404 still forgets the local copy; the release follows.
      if (event.type === "accessChanged" && event.grant === "deleted")
        return ok({ name: "deleted" }, "forget");
      return reject(state, event.type === "leave" ? REJECT.alreadyClosing : REJECT.closing);
    }
    case "closed":
      if (event.type === "accessChanged" && event.grant === "deleted")
        return ok({ name: "deleted", closing: true }, "forget");
      if (event.type === "reloadAccess")
        return state.archived ? ok(state, "reopen") : reject(state, REJECT.closed);
      return reject(state, event.type === "leave" ? REJECT.alreadyClosed : REJECT.closed);
    case "deleted":
      if (event.type !== "leave") return reject(state, REJECT.deleted);
      return state.closing
        ? reject(state, REJECT.alreadyClosing)
        : ok({ name: "deleted", closing: true }, "release");
  }
  throw new Error(`unknown state ${state.name}`);
}

export const viewerSessionMachine = defineMachine({
  ...viewerSessionSpec,
  initial: "opening",
  transition,
});
