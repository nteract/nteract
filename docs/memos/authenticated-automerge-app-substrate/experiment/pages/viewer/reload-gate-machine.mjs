/**
 * The tab's reload gate as a state machine.
 *
 * A reload replaces every Page this tab holds, so it waits for the held Pages'
 * receipts, for Pages being left to finish closing, and for unsent comment
 * drafts. The gate keeps what it needs as plain data: one entry per session
 * the tab owns, and a record for each Page that was left with edits the host
 * never acknowledged.
 *
 * States:
 * - idle: no reload attempt.
 * - waiting: an attempt holds every held Page's edits (`pauseEdits`) and waits.
 *   `attempt.live` lists the held sessions it waits on, each with its latched
 *   `result` (null while waiting, "ok", or the message that blocks it);
 *   `attempt.closing` lists sessions that were already closing. A change in
 *   which sessions the tab holds sets `navigated`, which cancels the attempt
 *   once everything settles.
 * - blocked: the last attempt stopped; `outcome` is what the banner shows.
 * - cancelled: navigation changed what the last attempt covered.
 * - reloading: the gate asked the browser to reload.
 *
 * Session entries: `phase` is `held` (installed) or `closing` (left; `drain`
 * says it left through the drain rather than an access reload). `alive`,
 * `pending`, `reason` (the session's pause), `save` (`saving`, `stalled` or
 * `failed`) and `savedHeads` come from the session's phase and receipt.
 *
 * Records are keyed `account:pageId`. A record with `checkpointWritten` waits
 * in IndexedDB and syncs on the next open, which supersedes it. A failed
 * checkpoint's record keeps the recovery Markdown and its heads, since that is
 * the only copy; only a covering receipt or "Discard" removes it.
 *
 * Events: `reload` (the banner's Reload, Reload anyway, or Discard and
 * reload), `sessionPhase` (a session's new phase; `closed` and `deleted`
 * arrive when the host releases it), `navigate` (the visible Page changed),
 * `draft` (whether any comment draft is unsent) and `timeout`
 * (SAVE_BEFORE_RELOAD_MS elapsed).
 *
 * Effects: `pauseEdits` and `resumeEdits` hold and release the reload's edit
 * pause; `requestSave` asks a session for its receipt (`retry` retries a
 * stalled save like the Retry button); `startTimer` arms the attempt's
 * timeout; `reload` reloads the tab.
 */
import { defineAlphabet } from "../shared/machine.mjs";

const PHASES = new Set(["held", "closing"]);
const SAVES = new Set(["saving", "stalled", "failed"]);
const REASONS = new Set(["auth", "access", "trash", "reload"]);

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isString = (value) => typeof value === "string" && value !== "";
const isBoolean = (value) => typeof value === "boolean";
const strings = (value, field) =>
  check(
    Array.isArray(value) && value.every((item) => typeof item === "string"),
    `${field}: strings`,
  );

function sessionEntry(entry) {
  check(isObject(entry), "a session entry is an object");
  only(entry, ["id", "key", "phase", "drain", "alive", "pending", "save", "reason", "savedHeads"]);
  check(isString(entry.id) && isString(entry.key), "id and key are required");
  check(PHASES.has(entry.phase), "phase must be held or closing");
  check((entry.phase === "closing") === isBoolean(entry.drain), "drain marks a closing entry");
  check(isBoolean(entry.alive) && isBoolean(entry.pending), "alive and pending are booleans");
  check(SAVES.has(entry.save), "save must be saving, stalled or failed");
  check(entry.reason === undefined || REASONS.has(entry.reason), "reason must be a pause reason");
  strings(entry.savedHeads, "savedHeads");
}

function record(value) {
  check(isObject(value), "a record is an object");
  only(value, ["key", "account", "pageId", "title", "checkpointWritten", "heads", "markdown"]);
  check(value.key === `${value.account}:${value.pageId}`, "records are keyed account:pageId");
  check(isString(value.title) && isBoolean(value.checkpointWritten), "title and checkpointWritten");
  if (value.checkpointWritten)
    check(value.heads === undefined, "a written checkpoint keeps no copy");
  else {
    strings(value.heads, "heads");
    check(typeof value.markdown === "string", "a failed checkpoint keeps its Markdown");
  }
}

function common(state, extra = []) {
  only(state, ["name", "sessions", "records", "drafts", ...extra]);
  check(Array.isArray(state.sessions), "sessions must be an array");
  state.sessions.forEach(sessionEntry);
  check(new Set(state.sessions.map((s) => s.id)).size === state.sessions.length, "unique ids");
  check(Array.isArray(state.records), "records must be an array");
  state.records.forEach(record);
  check(
    new Set(state.records.map((r) => r.key)).size === state.records.length,
    "one record per key",
  );
  check(isBoolean(state.drafts), "drafts must be a boolean");
}

function attempt(value) {
  check(isObject(value), "attempt is an object");
  only(value, ["acceptCheckpoints", "navigated", "live", "closing"]);
  check(isBoolean(value.acceptCheckpoints) && isBoolean(value.navigated), "attempt flags");
  check(Array.isArray(value.live), "attempt.live must be an array");
  for (const entry of value.live) {
    only(entry, ["id", "key", "result", "savedHeads"]);
    check(isString(entry.id) && isString(entry.key), "live entries name their session");
    check(entry.result === null || isString(entry.result), "result is null, ok or a message");
    strings(entry.savedHeads, "savedHeads");
  }
  strings(value.closing, "attempt.closing");
}

function outcome(value) {
  check(isObject(value), "outcome is an object");
  only(value, ["message", "reason", "pages"]);
  check(isString(value.message), "an outcome says why");
  check(value.reason === undefined || ["unsaved", "checkpointed"].includes(value.reason), "reason");
  check((value.reason === undefined) === (value.pages === undefined), "pages come with a reason");
  if (value.pages) value.pages.forEach(record);
}

function sessionPhase(event) {
  check(isString(event.id) && isString(event.key), "sessionPhase names its session");
  if (event.phase === "held" || event.phase === "closing") {
    const { type: _, ...entry } = event;
    sessionEntry(entry);
  } else if (event.phase === "closed") {
    only(event, [
      "type",
      "id",
      "key",
      "phase",
      "saved",
      "checkpointWritten",
      "savedHeads",
      "account",
      "pageId",
      "title",
      "recovery",
    ]);
    check(isBoolean(event.saved) && isBoolean(event.checkpointWritten), "closed outcome");
    check(event.key === `${event.account}:${event.pageId}`, "closed sessions name account:pageId");
    check(typeof event.title === "string", "title is a string");
    strings(event.savedHeads, "savedHeads");
    if (event.recovery !== undefined) {
      only(event.recovery, ["markdown", "heads"]);
      check(typeof event.recovery.markdown === "string", "recovery Markdown");
      strings(event.recovery.heads, "recovery heads");
    }
  } else {
    check(event.phase === "deleted", "phase must be held, closing, closed or deleted");
    only(event, ["type", "id", "key", "phase", "savedHeads"]);
    strings(event.savedHeads, "savedHeads");
  }
}

const typed = (keys) => (value) => only(value, ["type", ...keys]);

export const reloadGateSpec = Object.freeze({
  name: "reload-gate",
  states: ["idle", "waiting", "blocked", "reloading", "cancelled"],
  events: ["reload", "sessionPhase", "navigate", "draft", "timeout"],
  unreachable: [
    ["idle", "timeout", "only a waiting attempt arms the timer"],
    ["waiting", "reload", "the banner disables Reload while an attempt waits"],
    ["blocked", "timeout", "leaving waiting cancels the timer"],
    ["cancelled", "timeout", "leaving waiting cancels the timer"],
    [
      "reloading",
      "reload",
      "after reload() the banner keeps Reload disabled while the tab unloads",
    ],
    ["reloading", "timeout", "leaving waiting cancels the timer"],
  ],
  cases: {
    "idle/reload": [
      "nothing-to-wait",
      "drafts",
      "wait",
      "stalled-retries",
      "blocked-at-once",
      "closing",
      "unsaved",
      "checkpointed",
      "accept-checkpoints",
      "discard",
      "receipt-acknowledges",
    ],
    "idle/sessionPhase": [
      "held-new",
      "held-supersedes",
      "held-keeps-failed",
      "held-update",
      "leaves",
      "closed-saved",
      "closed-checkpointed",
      "closed-checkpointed-reopened",
      "closed-failed",
      "closed-failed-again",
      "closed-other-account",
      "closed-acknowledged",
      "closed-archive",
      "closed-held",
      "deleted",
      "archive-fails",
    ],
    "idle/draft": ["present", "absent"],
    "waiting/sessionPhase": [
      "saved-completes",
      "saved-others-wait",
      "blocked-mid-wait",
      "closing-closes",
      "closing-records",
      "navigated-completes",
      "drafts-at-end",
      "archive-fails",
      "held-new",
      "left-mid-wait",
    ],
    "waiting/timeout": ["live-waiting", "closing-still", "none-waiting"],
  },
  validate: {
    states: {
      idle: (state) => common(state),
      waiting(state) {
        common(state, ["attempt"]);
        attempt(state.attempt);
      },
      blocked(state) {
        common(state, ["outcome"]);
        outcome(state.outcome);
      },
      reloading: (state) => common(state),
      cancelled: (state) => common(state),
    },
    events: {
      reload(event) {
        only(event, ["type", "acceptCheckpoints", "discard"]);
        check(isBoolean(event.acceptCheckpoints), "acceptCheckpoints must be a boolean");
        strings(event.discard, "discard");
      },
      sessionPhase,
      navigate: typed([]),
      draft(event) {
        only(event, ["type", "present"]);
        check(isBoolean(event.present), "present must be a boolean");
      },
      timeout: typed([]),
    },
    effects: {
      pauseEdits(effect) {
        only(effect, ["type", "ids"]);
        strings(effect.ids, "ids");
      },
      resumeEdits(effect) {
        only(effect, ["type", "ids"]);
        strings(effect.ids, "ids");
      },
      requestSave(effect) {
        only(effect, ["type", "id", "retry"]);
        check(isString(effect.id) && isBoolean(effect.retry), "requestSave names a session");
      },
      startTimer(effect) {
        only(effect, ["type", "ms"]);
        check(Number.isSafeInteger(effect.ms) && effect.ms > 0, "ms must be positive");
      },
      reload: typed([]),
    },
  },
});

export const reloadGateAlphabet = defineAlphabet(reloadGateSpec);
