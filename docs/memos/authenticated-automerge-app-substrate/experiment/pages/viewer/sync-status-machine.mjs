/**
 * What a viewer session's sync status says, as a state machine.
 *
 * A receipt asks the host to acknowledge the replica's current heads. Heads
 * move for two reasons: this person edited, or another peer's changes
 * arrived. Both need a receipt, but only the first is saving. Catching up on
 * remote changes after a Page reopens is syncing, and the status must say so.
 *
 * The state name is the receipt's progress. Each state carries:
 * - `revision`: the receipt revision the state is about. PageSession bumps it
 *   for each new receipt, and a reply for any other revision is stale.
 * - `pending`: this replica holds edits the host has not acknowledged. A
 *   local edit sets it, and an acknowledgement of the current revision clears
 *   it: that receipt's heads include every edit made before it was queued.
 *   Remote changes never set it.
 * - `link`: the native connection. `connecting` until a socket is first
 *   admitted, then `connected`, `reconnecting` after a socket closes or sync
 *   resumes after sign-in, and `offline` after an attempt fails.
 *
 * States:
 * - idle: no receipt yet. The replica is opening or waiting for a connection.
 * - syncing: a receipt is outstanding and no local edit is pending.
 * - quiet: a receipt is outstanding for heads that include local edits, and
 *   it started less than SLOW_SAVE_MS ago. Most saves end here, so the status
 *   shows nothing. Entering it arms the slow-save timer.
 * - saving: the same, but the receipt is still outstanding after
 *   SLOW_SAVE_MS, or it follows a failed receipt. The status shows Saving.
 * - saved: the host acknowledged `revision`.
 * - local: the receipt stopped at the local checkpoint: there is no host
 *   connection yet, or the host failed and the IndexedDB copy has the edits.
 * - unsaved: the receipt failed and no local checkpoint holds the edits.
 *
 * Events: `opened` (start() installed the replica; `pending` when its
 * checkpoint may hold edits the host never acknowledged), `queued` (a receipt
 * for `revision` started; `edit` when a local edit queued it), `acknowledged`
 * (the host acknowledged `revision`), `stalled` (the receipt for `revision`
 * stopped short of the host; `localCopy` when IndexedDB has the edits),
 * `elapsed` (the slow-save timer for `revision` fired), and `admitted`,
 * `retrying` and `unreachable` (the connection events above).
 * Failed receipts retry at the same revision, so a later acknowledgement still
 * lands from `local` or `unsaved`.
 *
 * The slow-save threshold measures the current receipt. Each new revision in
 * `quiet` re-arms it: an older receipt's acknowledgement is stale, and typing
 * keeps the 300 ms receipt debounce from ever sending one, so measuring from
 * the first pending edit would show Saving through every long sentence. Once
 * Saving shows it stays until the receipt is acknowledged or stalls. After
 * `unsaved`, the next save shows at once: going quiet would read as the
 * failure clearing.
 *
 * Effects: `startTimer` arms the slow-save timer for `revision` (replacing any
 * armed one) and `cancelTimer` disarms it. They are the only effects.
 * PageSession runs them, feeds `elapsed` back, and renders `fullStatus` after
 * each step; presentation (SaveStatus, the phone header dot) maps its key.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

export const LINKS = Object.freeze(["connecting", "connected", "reconnecting", "offline"]);
/** How long a save stays quiet before the status shows Saving. */
export const SLOW_SAVE_MS = 2000;
const RECEIPT_STATES = new Set(["syncing", "quiet", "saving", "local", "unsaved"]);

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const isBoolean = (value) => typeof value === "boolean";
const revision = (value) =>
  check(
    Number.isSafeInteger(value.revision) && value.revision >= 0,
    "revision must be a non-negative integer",
  );
function fields(state, extra = []) {
  only(state, ["name", "revision", "pending", "link", ...extra]);
  revision(state);
  check(isBoolean(state.pending), "pending must be a boolean");
  check(LINKS.includes(state.link), "link must be a link state");
}
const clean = (state) => {
  fields(state);
  check(!state.pending, `a ${state.name} receipt has no pending local edit`);
};
const dirty = (state) => {
  fields(state);
  check(state.pending, "a saving receipt has a pending local edit");
};
// `armed` is the revision whose edit armed the slow-save timer. A remote
// change moves `revision` on without re-arming it.
const quiet = (state) => {
  fields(state, ["armed"]);
  check(state.pending, "a quiet receipt has a pending local edit");
  check(
    Number.isSafeInteger(state.armed) && state.armed >= 0 && state.armed <= state.revision,
    "armed must be a revision no newer than the receipt",
  );
};
const typed = (keys) => (value) => only(value, ["type", ...keys]);

export const viewerSyncStatusSpec = Object.freeze({
  name: "viewer-sync-status",
  states: ["idle", "syncing", "quiet", "saving", "saved", "local", "unsaved"],
  events: [
    "opened",
    "queued",
    "acknowledged",
    "stalled",
    "elapsed",
    "admitted",
    "retrying",
    "unreachable",
  ],
  unreachable: ["syncing", "quiet", "saving", "saved", "local", "unsaved"].map((state) => [
    state,
    "opened",
    "start() installs the replica once, before it queues any receipt",
  ]),
  cases: {
    "idle/queued": ["remote", "edit", "stale"],
    "syncing/queued": ["remote", "edit", "stale"],
    "quiet/queued": ["remote", "edit", "stale"],
    "saving/queued": ["remote", "edit", "stale"],
    "saved/queued": ["remote", "edit", "stale"],
    "local/queued": ["remote", "edit", "stale"],
    "unsaved/queued": ["remote", "edit", "stale"],
    "syncing/acknowledged": ["current", "stale"],
    "quiet/acknowledged": ["current", "stale"],
    "saving/acknowledged": ["current", "stale"],
    "local/acknowledged": ["current", "stale"],
    "unsaved/acknowledged": ["current", "stale"],
    "syncing/stalled": ["local-copy", "no-copy", "stale"],
    "quiet/stalled": ["local-copy", "no-copy", "stale"],
    "saving/stalled": ["local-copy", "no-copy", "stale"],
    "saved/stalled": ["local-copy", "no-copy", "stale"],
    "local/stalled": ["local-copy", "no-copy", "stale"],
    "unsaved/stalled": ["local-copy", "no-copy", "stale"],
    "quiet/elapsed": ["current", "stale"],
  },
  validate: {
    states: {
      idle: fields,
      syncing: clean,
      quiet,
      saving: dirty,
      saved: clean,
      local: fields,
      unsaved: fields,
    },
    events: {
      opened(event) {
        only(event, ["type", "pending"]);
        check(isBoolean(event.pending), "pending must be a boolean");
      },
      queued(event) {
        only(event, ["type", "revision", "edit"]);
        revision(event);
        check(isBoolean(event.edit), "edit must be a boolean");
      },
      acknowledged(event) {
        only(event, ["type", "revision"]);
        revision(event);
      },
      stalled(event) {
        only(event, ["type", "revision", "localCopy"]);
        revision(event);
        check(isBoolean(event.localCopy), "localCopy must be a boolean");
      },
      elapsed(event) {
        only(event, ["type", "revision"]);
        revision(event);
      },
      admitted: typed([]),
      retrying: typed([]),
      unreachable: typed([]),
    },
    effects: {
      startTimer(effect) {
        only(effect, ["type", "revision", "ms"]);
        revision(effect);
        check(effect.ms === SLOW_SAVE_MS, "the slow-save timer waits SLOW_SAVE_MS");
      },
      cancelTimer: typed([]),
    },
  },
});

export const REJECT = Object.freeze({
  stale: "The receipt revision is stale",
  noReceipt: "No receipt is outstanding",
  acknowledged: "The receipt was already acknowledged",
  notQuiet: "No quiet save is waiting on the slow-save timer",
});

const ok = (state, effects = []) => ({ state, effects });
const at = (name, { revision, pending, link }) => ({ name, revision, pending, link });
const LINK_EVENTS = { admitted: "connected", retrying: "reconnecting", unreachable: "offline" };
const startTimer = (revision) => ({ type: "startTimer", revision, ms: SLOW_SAVE_MS });
// Leaving `quiet` disarms its timer.
const leave = (state) => (state.name === "quiet" ? [{ type: "cancelTimer" }] : []);

/** The state a fresh receipt for `revision` moves to, with its effects. */
function queue(state, revision, edit) {
  const pending = state.pending || edit;
  const next = { ...state, revision, pending };
  if (!pending) return ok(at("syncing", next));
  switch (state.name) {
    case "saving":
      return ok(at("saving", next));
    case "unsaved":
      return ok(at("saving", next));
    case "quiet":
      // A local edit restarts the threshold; a remote change keeps it.
      return edit
        ? ok({ ...at("quiet", next), armed: revision }, [startTimer(revision)])
        : ok({ ...at("quiet", next), armed: state.armed });
    default:
      return ok({ ...at("quiet", next), armed: revision }, [startTimer(revision)]);
  }
}

function transition(state, event) {
  const link = LINK_EVENTS[event.type];
  if (link) return state.link === link ? ok(state) : ok({ ...state, link });
  switch (event.type) {
    case "opened":
      // Only idle reaches here; the spec declares the rest unreachable.
      return ok({ ...state, pending: event.pending });
    case "queued": {
      // Idle accepts its own revision: a receipt can start before any bump.
      const fresh =
        event.revision > state.revision ||
        (state.name === "idle" && event.revision === state.revision);
      if (!fresh) return reject(state, REJECT.stale);
      return queue(state, event.revision, event.edit);
    }
    case "acknowledged":
      if (state.name === "idle") return reject(state, REJECT.noReceipt);
      if (event.revision !== state.revision) return reject(state, REJECT.stale);
      if (!RECEIPT_STATES.has(state.name)) return reject(state, REJECT.acknowledged);
      return ok(at("saved", { ...state, pending: false }), leave(state));
    case "stalled":
      if (state.name === "idle") return reject(state, REJECT.noReceipt);
      if (event.revision !== state.revision) return reject(state, REJECT.stale);
      return ok(at(event.localCopy ? "local" : "unsaved", state), leave(state));
    case "elapsed":
      if (state.name !== "quiet") return reject(state, REJECT.notQuiet);
      if (event.revision !== state.armed) return reject(state, REJECT.stale);
      return ok(at("saving", state));
  }
  throw new Error(`unknown event ${event.type}`);
}

export const viewerSyncStatusMachine = defineMachine({
  ...viewerSyncStatusSpec,
  initial: { name: "idle", revision: 0, pending: false, link: "connecting" },
  transition,
});

/**
 * Presentation keys. Each status is a `{ label, key }` pair: the label is
 * the English text people read, and the key is what presentation branches
 * on, so rewording a label never changes how it is drawn. Each status also
 * carries an `id` (one of STATUS_IDS): the stable value PageSession, the
 * reload gate and the close drain read. Labels are free to change; ids are
 * not.
 * - connecting: no admitted socket yet, or reconnecting after one closed.
 * - connected: a socket is admitted and no receipt has started.
 * - syncing: a receipt for remote changes is outstanding.
 * - quiet: a receipt for this person's own edits started under SLOW_SAVE_MS
 *   ago. Drawn as nothing; its id is still `saving`, so the reload gate
 *   waits for it.
 * - saving: a receipt for this person's own edits is still outstanding.
 *
 * People see "Syncing" for both remote catch-up and their own edits. The
 * #4607 split survives in the key and id: `syncing` is catch-up, drawn as a
 * still dot; `saving` is this person's edits, drawn as a pulsing dot.
 * - saved: the host acknowledged the current receipt.
 * - attention: sync is paused or local-only; the edits are not lost.
 * - failed: edits may be lost.
 */
export const STATUS_KEYS = Object.freeze([
  "connecting",
  "connected",
  "syncing",
  "quiet",
  "saving",
  "saved",
  "attention",
  "failed",
]);
/**
 * Stable status ids. The reload gate and close drain branch on these, never
 * on labels.
 */
export const STATUS_IDS = Object.freeze([
  "connecting",
  "reconnecting",
  "connected",
  "syncing",
  "saving",
  "saved",
  "saved-locally",
  "offline",
  "unsaved",
  "deleted",
  "access-removed",
  "access-changed",
  "sign-in",
  "local-failed",
]);
/** Status ids whose problem the header's Retry button retries. */
export const RETRYABLE_STATUS = Object.freeze(["unsaved", "offline", "saved-locally"]);
const status = (label, key, id) => ({ label, key, id });

/**
 * The statuses that outrank the receipt, in rank order. Each flag is a fact
 * PageSession already holds; PageSession also shows these directly when the
 * fact changes, through `overlayStatus`.
 */
const OVERLAYS = Object.freeze({
  deleted: status("Deleted", "attention", "deleted"),
  accessDenied: status("Access removed", "attention", "access-removed"),
  accessReloadRequired: status("Access changed", "attention", "access-changed"),
  authRequired: status("Sign in to sync", "attention", "sign-in"),
  localFailed: status("Local save failed", "failed", "local-failed"),
});

export const OVERLAY_FLAGS = Object.freeze(Object.keys(OVERLAYS));

/** The status for one overlay flag (one of OVERLAY_FLAGS). */
export function overlayStatus(flag) {
  const value = OVERLAYS[flag];
  if (!value) throw new Error(`unknown status overlay ${flag}`);
  return value;
}

/**
 * The receipt and connection part of the status. `localCopy` says an
 * IndexedDB record holds this Page, so an idle or offline replica still has
 * its edits.
 *
 * Offline outranks everything but a local save, because the person should
 * know sync is down. Pending local edits outrank reconnecting: they are what
 * the person is waiting on, and the HTTP receipt can still land. A quiet save
 * outranks it too, so a brief reconnect under a fast save stays quiet.
 */
export function syncStatus(state, { localCopy = false } = {}) {
  const { name, link } = state;
  if (link === "offline")
    return name === "local" || (name === "idle" && localCopy)
      ? status("Saved locally", "attention", "saved-locally")
      : status("Offline", "attention", "offline");
  if (name === "quiet") return status("Syncing", "quiet", "saving");
  if (name === "saving") return status("Syncing", "saving", "saving");
  if (link === "reconnecting") return status("Reconnecting", "connecting", "reconnecting");
  switch (name) {
    case "idle":
      return link === "connected"
        ? status("Connected", "connected", "connected")
        : localCopy
          ? status("Saved locally", "attention", "saved-locally")
          : status("Connecting", "connecting", "connecting");
    case "syncing":
      return status("Syncing", "syncing", "syncing");
    case "saved":
      return status("Saved", "saved", "saved");
    case "local":
      return status("Saved locally", "attention", "saved-locally");
    case "unsaved":
      return status("Not saved", "failed", "unsaved");
  }
  throw new Error(`unknown state ${name}`);
}

export const syncStatusLabel = (state, options) => syncStatus(state, options).label;

/**
 * The whole status line: a phase pause or a failed local save outranks the
 * receipt, in OVERLAYS order.
 */
export function fullStatus(state, { localCopy = false, ...flags } = {}) {
  for (const [flag, value] of Object.entries(OVERLAYS)) if (flags[flag]) return value;
  return syncStatus(state, { localCopy });
}

export const statusLabel = (state, flags) => fullStatus(state, flags).label;
