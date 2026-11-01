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
 * - saving: a receipt is outstanding for heads that include local edits.
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
 * `admitted`, `retrying` and `unreachable` (the connection events above).
 * Failed receipts retry at the same revision, so a later acknowledgement still
 * lands from `local` or `unsaved`.
 *
 * The machine has no effects. PageSession renders `statusLabel` after each
 * step; presentation (SaveStatus, a header icon) maps the label.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

export const LINKS = Object.freeze(["connecting", "connected", "reconnecting", "offline"]);
const RECEIPT_STATES = new Set(["syncing", "saving", "local", "unsaved"]);

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
function fields(state) {
  only(state, ["name", "revision", "pending", "link"]);
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
const typed = (keys) => (value) => only(value, ["type", ...keys]);

export const viewerSyncStatusSpec = Object.freeze({
  name: "viewer-sync-status",
  states: ["idle", "syncing", "saving", "saved", "local", "unsaved"],
  events: ["opened", "queued", "acknowledged", "stalled", "admitted", "retrying", "unreachable"],
  unreachable: ["syncing", "saving", "saved", "local", "unsaved"].map((state) => [
    state,
    "opened",
    "start() installs the replica once, before it queues any receipt",
  ]),
  cases: {
    "idle/queued": ["remote", "edit", "stale"],
    "syncing/queued": ["remote", "edit", "stale"],
    "saving/queued": ["remote", "edit", "stale"],
    "saved/queued": ["remote", "edit", "stale"],
    "local/queued": ["remote", "edit", "stale"],
    "unsaved/queued": ["remote", "edit", "stale"],
    "syncing/acknowledged": ["current", "stale"],
    "saving/acknowledged": ["current", "stale"],
    "local/acknowledged": ["current", "stale"],
    "unsaved/acknowledged": ["current", "stale"],
    "syncing/stalled": ["local-copy", "no-copy", "stale"],
    "saving/stalled": ["local-copy", "no-copy", "stale"],
    "saved/stalled": ["local-copy", "no-copy", "stale"],
    "local/stalled": ["local-copy", "no-copy", "stale"],
    "unsaved/stalled": ["local-copy", "no-copy", "stale"],
  },
  validate: {
    states: {
      idle: fields,
      syncing: clean,
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
      admitted: typed([]),
      retrying: typed([]),
      unreachable: typed([]),
    },
    effects: {},
  },
});

export const REJECT = Object.freeze({
  stale: "The receipt revision is stale",
  noReceipt: "No receipt is outstanding",
  acknowledged: "The receipt was already acknowledged",
});

const ok = (state) => ({ state, effects: [] });
const at = (name, { revision, pending, link }) => ({ name, revision, pending, link });
const LINK_EVENTS = { admitted: "connected", retrying: "reconnecting", unreachable: "offline" };

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
      const pending = state.pending || event.edit;
      return ok(
        at(pending ? "saving" : "syncing", { ...state, revision: event.revision, pending }),
      );
    }
    case "acknowledged":
      if (state.name === "idle") return reject(state, REJECT.noReceipt);
      if (event.revision !== state.revision) return reject(state, REJECT.stale);
      if (!RECEIPT_STATES.has(state.name)) return reject(state, REJECT.acknowledged);
      return ok(at("saved", { ...state, pending: false }));
    case "stalled":
      if (state.name === "idle") return reject(state, REJECT.noReceipt);
      if (event.revision !== state.revision) return reject(state, REJECT.stale);
      return ok(at(event.localCopy ? "local" : "unsaved", state));
  }
  throw new Error(`unknown event ${event.type}`);
}

export const viewerSyncStatusMachine = defineMachine({
  ...viewerSyncStatusSpec,
  initial: { name: "idle", revision: 0, pending: false, link: "connecting" },
  transition,
});

/**
 * The receipt and connection part of the status. `localCopy` says an
 * IndexedDB record holds this Page, so an idle or offline replica still has
 * its edits.
 *
 * Offline outranks everything but a local save, because the person should
 * know sync is down. Pending local edits outrank reconnecting: they are what
 * the person is waiting on, and the HTTP receipt can still land.
 */
export function syncStatusLabel(state, { localCopy = false } = {}) {
  const { name, link } = state;
  if (link === "offline")
    return name === "local" || (name === "idle" && localCopy) ? "Saved locally" : "Offline";
  if (name === "saving") return "Saving";
  if (link === "reconnecting") return "Reconnecting";
  switch (name) {
    case "idle":
      return link === "connected" ? "Connected" : localCopy ? "Saved locally" : "Connecting";
    case "syncing":
      return "Syncing";
    case "saved":
      return "Saved";
    case "local":
      return "Saved locally";
    case "unsaved":
      return "Unsaved";
  }
  throw new Error(`unknown state ${name}`);
}

/**
 * The whole status line: a phase pause or a failed local save outranks the
 * receipt, in this order. Each flag is a fact PageSession already holds.
 */
export function statusLabel(
  state,
  {
    deleted = false,
    accessDenied = false,
    accessReloadRequired = false,
    authRequired = false,
    localFailed = false,
    localCopy = false,
  } = {},
) {
  if (deleted) return "Deleted";
  if (accessDenied) return "Access removed";
  if (accessReloadRequired) return "Access changed";
  if (authRequired) return "Sign in to sync";
  if (localFailed) return "Local save failed";
  return syncStatusLabel(state, { localCopy });
}
