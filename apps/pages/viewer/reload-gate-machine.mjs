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
 * Session entries: `phase` comes from the session's lifecycle, whoever started
 * the close. `held` sessions are opening, open or paused. `closing` sessions
 * are draining, checkpointing, or closed but not yet released. `alive`,
 * `pending`, `reason` (the session's pause), `save` (`saving`, `stalled` or
 * `failed`) and `savedHeads` come from the session's phase and receipt. A
 * closing session's final `sessionPhase` (`closed` or `deleted`) arrives once
 * its backend release settles; until then every attempt waits for it.
 *
 * Schema holds: a held session whose schema gate made it read-only with edits
 * the host won't accept carries `schema` and its `title`. The host refuses
 * those edits until a build with the feature opens the Page, so a receipt can
 * never settle them. Instead the attempt asks for a local checkpoint
 * (`checkpoint`), when it starts or when a waiting session first reports the
 * hold: `refused` (none written for the reload yet), then
 * `writing`, then `written` or `failed`. Read-only means the replica takes no
 * new local edits, so one written checkpoint covers them all. A written one
 * settles like a closed Page's checkpoint: it reloads when the attempt
 * accepts checkpoints, and otherwise blocks as `checkpointed`. A failed one
 * blocks and keeps the edits in the open tab; the next Reload writes again.
 *
 * Records are keyed `account:pageId`. A record with `checkpointWritten` waits
 * in IndexedDB and syncs on the next open, which supersedes it. A failed
 * checkpoint's record keeps the recovery Markdown and its heads, since that is
 * the only copy; only a covering receipt or "Discard" removes it. An
 * `explicit` record holds what no receipt can cover (a retired copy whose
 * archive failed, with comment drafts the document never saw): only
 * "Discard" removes it.
 *
 * Events: `reload` (the banner's Reload, Reload anyway, or Discard and
 * reload), `sessionPhase` (a session's new phase; `closed` and `deleted`
 * arrive when the host releases it), `navigate` (the visible Page changed),
 * `draft` (whether any comment draft is unsent) and `timeout`
 * (SAVE_BEFORE_RELOAD_MS elapsed).
 *
 * Effects: `pauseEdits` and `resumeEdits` hold and release the reload's edit
 * pause; `requestSave` asks a session for its receipt (`retry` retries a
 * stalled save like the Retry button); `checkpoint` asks a schema-held session
 * to write its local checkpoint; `startTimer` arms the attempt's timeout;
 * `reload` reloads the tab.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

const PHASES = new Set(["held", "closing"]);
const SAVES = new Set(["saving", "stalled", "failed"]);
const REASONS = new Set(["auth", "access", "trash", "reload"]);
const SCHEMA_HOLDS = new Set(["refused", "writing", "written", "failed"]);

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
  only(entry, [
    "id",
    "key",
    "phase",
    "alive",
    "pending",
    "save",
    "reason",
    "savedHeads",
    "schema",
    "title",
  ]);
  check(isString(entry.id) && isString(entry.key), "id and key are required");
  check(PHASES.has(entry.phase), "phase must be held or closing");
  check(isBoolean(entry.alive) && isBoolean(entry.pending), "alive and pending are booleans");
  check(
    entry.phase === "closing" || entry.alive,
    "a held session is live; a closed one is closing",
  );
  check(SAVES.has(entry.save), "save must be saving, stalled or failed");
  check(entry.reason === undefined || REASONS.has(entry.reason), "reason must be a pause reason");
  strings(entry.savedHeads, "savedHeads");
  check(entry.schema === undefined || SCHEMA_HOLDS.has(entry.schema), "schema must be a hold");
  check(
    (entry.schema === undefined) === (entry.title === undefined),
    "a schema hold names its title",
  );
  check(entry.schema === undefined || entry.phase === "held", "only a held session is held");
  if (entry.title !== undefined) check(typeof entry.title === "string", "title is a string");
}

function record(value) {
  check(isObject(value), "a record is an object");
  only(value, [
    "key",
    "account",
    "pageId",
    "title",
    "checkpointWritten",
    "heads",
    "markdown",
    "explicit",
  ]);
  check(value.key === `${value.account}:${value.pageId}`, "records are keyed account:pageId");
  check(isString(value.title) && isBoolean(value.checkpointWritten), "title and checkpointWritten");
  if (value.checkpointWritten)
    check(value.heads === undefined, "a written checkpoint keeps no copy");
  else {
    strings(value.heads, "heads");
    check(typeof value.markdown === "string", "a failed checkpoint keeps its Markdown");
  }
  check(value.explicit === undefined || value.explicit === true, "explicit is true or absent");
  check(!value.explicit || !value.checkpointWritten, "only a lost copy is explicit");
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
      only(event.recovery, ["markdown", "heads", "explicit"]);
      check(typeof event.recovery.markdown === "string", "recovery Markdown");
      strings(event.recovery.heads, "recovery heads");
      check(
        event.recovery.explicit === undefined || event.recovery.explicit === true,
        "explicit is true or absent",
      );
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
      "receipt-keeps-explicit",
      "deleted-releasing",
      "schema-checkpoints",
      "schema-failed-retries",
      "schema-written-accepted",
      "schema-written-not-accepted",
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
      "closed-explicit-kept",
      "closed-archive",
      "closed-direct",
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
      "direct-close",
      "direct-close-failed",
      "deleted-released",
      "deleted-still-releasing",
      "late-deletion",
      "schema-writing",
      "schema-written-reloads",
      "schema-failed-blocks",
      "schema-refused-mid-attempt",
      "schema-refused-again",
    ],
    "waiting/timeout": ["live-waiting", "closing-still", "none-waiting", "schema-checkpoint-slow"],
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
      checkpoint(effect) {
        only(effect, ["type", "id"]);
        check(isString(effect.id), "checkpoint names a session");
      },
      startTimer(effect) {
        only(effect, ["type", "ms"]);
        check(Number.isSafeInteger(effect.ms) && effect.ms > 0, "ms must be positive");
      },
      reload: typed([]),
    },
  },
});

export const SAVE_BEFORE_RELOAD_MS = 15_000;
export const UNSENT_COMMENT = "You have an unsent comment. Send or discard it before reloading.";
export const SAVE_TIMEOUT =
  "Your latest edits haven't saved yet, so this tab won't reload. Check your connection and try again.";
export const BLOCKED = Object.freeze({
  auth: "Sign in again so your latest edits can save, then reload.",
  access:
    "Your latest edits can't be saved to this Page. Download the local draft before reloading.",
  failed: "Your latest edits couldn't be saved on this device, so this tab won't reload.",
});
export const NOTHING_SAVING = "No held Page is still saving";
export const SCHEMA_CHECKPOINT_FAILED =
  "Your edits on this Page couldn't be saved in this browser, so this tab won't reload. Keep this tab open and try Reload again.";
// A live result: the session's edits wait in a written local checkpoint.
const KEPT = "checkpointed";

const names = (pages) => {
  const titles = pages.map((page) => page.title);
  return titles.length === 1 ? titles[0] : `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
};
export const checkpointedMessage = (pages) =>
  `Edits on ${names(pages)} haven't reached the server yet. They're saved in this browser and sync when you open ${pages.length === 1 ? "that Page" : "those Pages"} again.`;
export const unsavedMessage = (pages) =>
  `Edits on ${names(pages)} couldn't be saved in this browser and haven't reached the server. Download them before reloading, or they'll be lost.`;

function blockedMessage(entry) {
  if (entry.save === "failed") return BLOCKED.failed;
  if (entry.reason === "auth") return BLOCKED.auth;
  if (entry.reason) return BLOCKED.access;
  return undefined;
}
/** A live session's result: "ok", KEPT, a blocking message, or null while it
 * waits. A schema hold waits on its checkpoint, never on a receipt. */
function resultFor(entry) {
  if (!entry.alive || !entry.pending) return "ok";
  if (entry.schema === "written") return KEPT;
  if (entry.schema === "failed") return SCHEMA_CHECKPOINT_FAILED;
  if (entry.schema) return null;
  return blockedMessage(entry) ?? null;
}
const splitKey = (key) => {
  const at = key.lastIndexOf(":");
  return { account: key.slice(0, at), pageId: key.slice(at + 1) };
};

function entryOf(event) {
  const { type: _, ...entry } = event;
  return entry;
}

// A receipt clears a lost copy it covers; an explicit one waits for Discard.
const acknowledge = (records, key, savedHeads) =>
  records.filter(
    (record) =>
      !(
        record.key === key &&
        !record.checkpointWritten &&
        !record.explicit &&
        record.heads.length > 0 &&
        record.heads.every((head) => savedHeads.includes(head))
      ),
  );

function recordClosed(records, sessions, event) {
  const { key, account, pageId } = event;
  const previous = records.find((record) => record.key === key);
  const title = event.title.trim() || "Untitled";
  if (event.checkpointWritten) {
    // A newer session superseded this checkpoint; a failed record stays.
    if (previous || sessions.some((s) => s.phase === "held" && s.key === key)) return records;
    return [...records, { key, account, pageId, title, checkpointWritten: true }];
  }
  // Each failed checkpoint is its own lost copy: keep every one.
  const lost = previous && !previous.checkpointWritten ? previous : undefined;
  const next = {
    key,
    account,
    pageId,
    title,
    checkpointWritten: false,
    heads: [...(lost?.heads ?? []), ...(event.recovery?.heads ?? [])],
    markdown: [lost?.markdown, event.recovery?.markdown ?? ""]
      .filter((part) => part !== undefined)
      .join("\n---\n\n"),
    ...((lost?.explicit || event.recovery?.explicit) && { explicit: true }),
  };
  return previous
    ? records.map((record) => (record.key === key ? next : record))
    : [...records, next];
}

/** Track a session's phase. Returns whether the held/closing set moved. */
function bookkeep(state, event) {
  let { sessions, records } = state;
  const index = sessions.findIndex((s) => s.id === event.id);
  const previous = sessions[index];
  if (event.phase === "held" || event.phase === "closing") {
    const entry = entryOf(event);
    if (!previous) {
      if (entry.phase === "held")
        records = records.filter((r) => !(r.key === entry.key && r.checkpointWritten));
      return { sessions: [...sessions, entry], records, moved: true };
    }
    return {
      sessions: sessions.map((s, i) => (i === index ? entry : s)),
      records,
      moved: previous.phase !== entry.phase,
    };
  }
  if (previous) sessions = sessions.filter((_, i) => i !== index);
  // Every close keeps its record until release, a direct close included. An
  // access reload reports saved: it keeps its own recovery.
  if (previous?.phase === "closing") {
    records = acknowledge(records, event.key, event.savedHeads);
    if (event.phase === "closed" && !event.saved) records = recordClosed(records, sessions, event);
  }
  return { sessions, records, moved: false };
}

const base = ({ sessions, records, drafts }) => ({ sessions, records, drafts });

function complete(state, effects) {
  const { attempt } = state;
  const ids = attempt.live.map((entry) => entry.id);
  const resume = ids.length ? [{ type: "resumeEdits", ids }] : [];
  const blocked = (outcome, records = state.records) => ({
    state: { name: "blocked", ...base({ ...state, records }), outcome },
    effects: [...effects, ...resume],
  });
  if (attempt.navigated)
    return { state: { name: "cancelled", ...base(state) }, effects: [...effects, ...resume] };
  if (state.drafts) return blocked({ message: UNSENT_COMMENT });
  const failed = attempt.live.find((entry) => entry.result !== "ok" && entry.result !== KEPT);
  if (failed) return blocked({ message: failed.result });
  let records = state.records;
  for (const entry of attempt.live) records = acknowledge(records, entry.key, entry.savedHeads);
  const unsaved = records.filter((record) => !record.checkpointWritten);
  if (unsaved.length)
    return blocked(
      { reason: "unsaved", pages: unsaved, message: unsavedMessage(unsaved) },
      records,
    );
  // Open Pages whose edits wait in a schema checkpoint, listed like records.
  const kept = attempt.live
    .filter((entry) => entry.result === KEPT)
    .map((entry) => {
      const title = state.sessions.find((s) => s.id === entry.id)?.title.trim() || "Untitled";
      return { key: entry.key, ...splitKey(entry.key), title, checkpointWritten: true };
    })
    .filter((page) => !records.some((record) => record.key === page.key));
  const waiting = [...records, ...kept];
  if (waiting.length && !attempt.acceptCheckpoints)
    return blocked(
      { reason: "checkpointed", pages: waiting, message: checkpointedMessage(waiting) },
      records,
    );
  return {
    state: { name: "reloading", ...base({ ...state, records }) },
    effects: [...effects, { type: "reload" }],
  };
}

function settleAttempt(state, effects = []) {
  const { attempt } = state;
  if (attempt.closing.length || attempt.live.some((entry) => entry.result === null))
    return { state, effects };
  return complete(state, effects);
}

function start(state, event) {
  const records = state.records.filter((record) => !event.discard.includes(record.key));
  const next = { ...base(state), records };
  if (state.drafts)
    return {
      state: { name: "blocked", ...next, outcome: { message: UNSENT_COMMENT } },
      effects: [],
    };
  const live = state.sessions.filter((s) => s.phase === "held" && s.alive);
  const effects = [];
  if (live.length) effects.push({ type: "pauseEdits", ids: live.map((s) => s.id) });
  const entries = live.map((s) => ({
    id: s.id,
    key: s.key,
    result: resultFor(s),
    savedHeads: s.savedHeads,
  }));
  for (const s of live)
    if (resultFor(s) === null && !s.schema)
      effects.push({ type: "requestSave", id: s.id, retry: s.save === "stalled" });
  // A schema hold writes a checkpoint for this attempt; a failed one retries.
  for (const s of live)
    if (s.alive && s.pending && (s.schema === "refused" || s.schema === "failed"))
      effects.push({ type: "checkpoint", id: s.id });
  for (const entry of entries) if (entry.result === SCHEMA_CHECKPOINT_FAILED) entry.result = null;
  if (entries.some((entry) => entry.result === null))
    effects.push({ type: "startTimer", ms: SAVE_BEFORE_RELOAD_MS });
  const attempt = {
    acceptCheckpoints: event.acceptCheckpoints,
    navigated: false,
    live: entries,
    closing: state.sessions.filter((s) => s.phase === "closing").map((s) => s.id),
  };
  return settleAttempt({ name: "waiting", ...next, attempt }, effects);
}

function transition(state, event) {
  switch (event.type) {
    case "reload":
      return start(state, event);
    case "draft":
      return { state: { ...state, drafts: event.present }, effects: [] };
    case "navigate":
      if (state.name === "waiting")
        return { state: { ...state, attempt: { ...state.attempt, navigated: true } }, effects: [] };
      if (state.name === "reloading") return { state, effects: [] };
      return { state: { name: "idle", ...base(state) }, effects: [] };
    case "sessionPhase": {
      const { sessions, records, moved } = bookkeep(state, event);
      if (state.name !== "waiting") return { state: { ...state, sessions, records }, effects: [] };
      const entry = sessions.find((s) => s.id === event.id);
      const previous = state.sessions.find((s) => s.id === event.id);
      const item = state.attempt.live.find((candidate) => candidate.id === event.id);
      // A refusal that arrives mid-attempt starts its checkpoint here: a
      // receipt can no longer settle this session.
      const effects =
        item?.result === null &&
        entry?.phase === "held" &&
        entry.alive &&
        entry.pending &&
        entry.schema === "refused" &&
        previous?.schema !== "refused"
          ? [{ type: "checkpoint", id: event.id }]
          : [];
      const live = state.attempt.live.map((item) => {
        if (item.id !== event.id) return item;
        const savedHeads = event.savedHeads;
        if (item.result !== null) return { ...item, savedHeads };
        return { ...item, result: entry ? resultFor(entry) : "ok", savedHeads };
      });
      const closing =
        entry?.phase === "closing"
          ? state.attempt.closing
          : state.attempt.closing.filter((id) => id !== event.id);
      return settleAttempt(
        {
          ...state,
          sessions,
          records,
          attempt: {
            ...state.attempt,
            navigated: state.attempt.navigated || moved,
            live,
            closing,
          },
        },
        effects,
      );
    }
    case "timeout": {
      if (!state.attempt.live.some((entry) => entry.result === null))
        return reject(state, NOTHING_SAVING);
      const live = state.attempt.live.map((entry) =>
        entry.result === null ? { ...entry, result: SAVE_TIMEOUT } : entry,
      );
      return settleAttempt({ ...state, attempt: { ...state.attempt, live } });
    }
  }
  throw new Error(`unknown event ${event.type}`);
}

export const reloadGateMachine = defineMachine({
  ...reloadGateSpec,
  initial: { name: "idle", sessions: [], records: [], drafts: false },
  transition,
});
