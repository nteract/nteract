import { defineMachine, reject } from "../shared/machine.mjs";
import { pageState } from "./access.mjs";

/**
 * When a Subduction Page host converts its Page to plain Automerge sync.
 *
 * A Page converts only when nobody is using it: after a browser has had it
 * open on this object and the last socket closed, and no request has run for
 * a quiet window. Conversion never runs at boot or for a listing check that
 * booted the host, so the Pages that convert are the ones people use, one
 * session at a time.
 *
 * States:
 * - off: disabled by configuration/record, or paused after MAX_ATTEMPTS until
 *   a new browser session. Only the latter carries `retryOnSocket`.
 * - dormant: no browser has connected to this object yet.
 * - connected: a socket is open or a request is running.
 * - quiet: nobody is connected and nothing runs; the quiet timer is armed.
 * - converting: the conversion runs inside blockConcurrencyWhile, so no
 *   request or socket can start until it ends.
 * - backoff: the last attempt skipped or failed before the flip; the retry
 *   timer is armed without holding the object resident. `busy` says whether
 *   anyone was connected when it ended.
 * - retired: the record says plain. The interpreter refuses this object's
 *   storage writes, closes the native host and resets the object, so the
 *   next request boots plain.
 *
 * Events: `activity` ({ sockets, requests }: the counts after any change),
 * `elapsed` (the armed timer fired), `converted` (the flip was attempted:
 * whatever the put reported, the object resets and the next boot reads the
 * record), `skipped` ({ reason, retryMs? }: not quiet enough to convert;
 * nothing written) and `failed` (a step before the flip threw).
 *
 * Effects: `arm` ({ ms }), `disarm`, `convert`, `retire`.
 */
export const MIGRATION_STATES = Object.freeze([
  "off",
  "dormant",
  "connected",
  "quiet",
  "converting",
  "backoff",
  "retired",
]);
export const MIGRATION_EVENTS = Object.freeze([
  "activity",
  "elapsed",
  "converted",
  "skipped",
  "failed",
]);

/** How long a Page sits unused before it converts, unless the state says
 * otherwise (`quietMs`, from PAGES_MIGRATE_QUIET_MS). */
export const QUIET_MS = 30_000;
export const MAX_ATTEMPTS = 3;
export const SLOT_WAIT_MS = 5_000;
export const SLOT_MAX_AGE_MS = 60_000;
/** Retry waits after a skip or failure: doubling from the quiet window, at
 * most 6 h. */
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
export const backoffMs = (attempts, quietMs = QUIET_MS) =>
  Math.min(quietMs * 2 ** attempts, MAX_BACKOFF_MS);

const ended = ["converted", "skipped", "failed"];
const unreachable = [
  ...["off", "dormant", "connected", "quiet", "backoff", "retired"].flatMap((state) =>
    ended.map((event) => [state, event, "only a running conversion reports its end"]),
  ),
  ["off", "elapsed", "off arms no timer"],
  ["dormant", "elapsed", "dormant arms no timer"],
  ["retired", "elapsed", "retiring disarms every timer"],
];

const idle = (event) => event.sockets === 0 && event.requests === 0;

export const recordStorageMigration = defineMachine({
  name: "record-storage-migration",
  states: MIGRATION_STATES,
  events: MIGRATION_EVENTS,
  unreachable,
  cases: {
    "off/activity": ["disabled", "no-socket", "socket"],
    "dormant/activity": ["socket", "no-socket"],
    "connected/activity": ["idle", "busy"],
    "quiet/activity": ["idle", "busy"],
    "backoff/activity": ["socket", "no-socket"],
    "backoff/elapsed": ["idle", "busy"],
    "converting/skipped": ["retry", "exhausted"],
    "converting/failed": ["retry", "exhausted"],
  },
  validate: {
    events: {
      activity: (event) => {
        if (!Number.isSafeInteger(event.sockets) || !Number.isSafeInteger(event.requests))
          throw Error("activity carries socket and request counts");
      },
      skipped: (event) => {
        if (typeof event.reason !== "string") throw Error("a skip names its reason");
      },
    },
    effects: {
      arm: (effect) => {
        if (!Number.isSafeInteger(effect.ms) || effect.ms < 1) throw Error("arm needs ms");
      },
      disarm: () => {},
      convert: () => {},
      retire: () => {},
    },
  },
  initial: { name: "dormant", attempts: 0, quietMs: QUIET_MS },
  transition(state, event) {
    const attempts = state.attempts ?? 0;
    const quietMs = state.quietMs ?? QUIET_MS;
    // What every state but `retired` carries forward.
    const keep = (name, extra = {}) => ({ name, attempts, quietMs, ...extra });
    switch (state.name) {
      case "off":
        if (state.retryOnSocket) {
          if (event.sockets > 0) return { state: keep("connected", { attempts: 0 }), effects: [] };
          return reject(state, "only a new browser session retries exhausted attempts");
        }
        return reject(state, "this object never converts");
      case "retired":
        return reject(state, "the record already says plain");
      case "dormant":
        if (event.sockets > 0) return { state: keep("connected"), effects: [] };
        return reject(state, "only a browser session makes a Page eligible");
      case "connected":
        if (event.type === "elapsed") return reject(state, "a stale timer");
        if (idle(event))
          return {
            state: keep("quiet"),
            effects: [{ type: "arm", ms: quietMs }],
          };
        return { state, effects: [] };
      case "quiet":
        if (event.type === "elapsed")
          return { state: keep("converting"), effects: [{ type: "convert" }] };
        if (idle(event)) return { state, effects: [] };
        return { state: keep("connected"), effects: [{ type: "disarm" }] };
      case "converting":
        switch (event.type) {
          case "activity":
            // blockConcurrencyWhile holds requests and sockets; a count that
            // still arrives says who is waiting once the conversion ends.
            return { state: { ...state, busy: !idle(event) }, effects: [] };
          case "elapsed":
            return reject(state, "a stale timer");
          case "converted":
            return {
              state: { name: "retired" },
              effects: [{ type: "retire" }],
            };
          default: {
            if (attempts + 1 >= MAX_ATTEMPTS)
              return {
                state: keep("off", { attempts: attempts + 1, retryOnSocket: true }),
                effects: [{ type: "disarm" }],
              };
            const ms = Math.max(event.retryMs ?? 0, backoffMs(attempts, quietMs));
            return {
              state: {
                name: "backoff",
                attempts: attempts + 1,
                quietMs,
                busy: !!state.busy,
              },
              effects: [{ type: "arm", ms }],
            };
          }
        }
      case "backoff":
        if (event.type === "activity") {
          if (event.sockets > 0) return { state: keep("connected"), effects: [{ type: "disarm" }] };
          return { state: { ...state, busy: !idle(event) }, effects: [] };
        }
        if (state.busy) return { state: keep("connected"), effects: [] };
        return {
          state: keep("quiet"),
          effects: [{ type: "arm", ms: quietMs }],
        };
    }
  },
});

/** The state a booted host starts in: `off` unless both switches are on and
 * its record is an installed, live Subduction Page. */
export function migrationStart(env, metadata) {
  const due =
    env.PAGES_MIGRATE_RECORD_STORAGE === "true" &&
    env.PAGES_RECORD_STORAGE === "automerge" &&
    !!metadata?.documentId &&
    [undefined, "local", "buffered"].includes(metadata.recordStorage) &&
    ["active", "trashed"].includes(pageState(metadata));
  if (!due) return { name: "off" };
  const quietMs = Number(env.PAGES_MIGRATE_QUIET_MS);
  return {
    name: "dormant",
    attempts: 0,
    quietMs: Number.isSafeInteger(quietMs) && quietMs > 0 ? quietMs : QUIET_MS,
  };
}

/** One conversion at a time per isolate: this module's slot is shared by its
 * Page objects, not by other isolates on the node. Each conversion holds a
 * native host, two snapshots and their plain write in memory. A timed-out
 * waiter never takes the slot or runs later. An occupant older than 60 s can
 * be replaced, beyond blockConcurrencyWhile's 30 s deadline. This only
 * relaxes the memory limit: different Pages convert in separate objects. */
let slot;
export async function migrationSlot(work, { timeoutMs = SLOT_WAIT_MS, now = Date.now } = {}) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs);
  });
  try {
    while (slot) {
      if (now() - slot.started > SLOT_MAX_AGE_MS) break;
      if (await Promise.race([slot.settled, expired]))
        return { type: "skipped", reason: "slot_timeout" };
    }
  } finally {
    clearTimeout(timer);
  }
  let release;
  const occupant = {
    started: now(),
    settled: new Promise((resolve) => (release = resolve)),
  };
  slot = occupant;
  try {
    return await work();
  } finally {
    if (slot === occupant) slot = undefined;
    release(false);
  }
}

/** The error requests on a retired object get: the next request reaches the
 * new object, which boots plain. */
export function recordStorageMigrated() {
  return Object.assign(Error("This Page moved to plain sync. Try again."), {
    status: 503,
    code: "record_storage_migrated",
  });
}
