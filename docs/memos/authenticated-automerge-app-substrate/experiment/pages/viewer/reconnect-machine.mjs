/**
 * A viewer session's automatic reconnects as a state machine.
 *
 * The session-machine phase says whether a session may sync at all. This
 * machine says what the session does after a sync attempt or socket fails
 * while it may: wait and retry, or stop until a person acts.
 *
 * States, each carrying `attempts` (retries scheduled since the last stable
 * connection or resume; it picks the backoff step) and `refusals` (attempts
 * in a row that the host's native admission closed with an admission code
 * before the socket proved stable):
 * - ready: no retry is pending. The session is connecting, connected, or
 *   stopped by its phase (sign-in, access, closing).
 * - waiting: a backoff timer is pending.
 * - refused: the host refused this tab's signing key (`retry: "stop"`).
 *   Reconnecting with the same key can't succeed.
 * - paused: REFUSAL_LIMIT refusals in a row. The host keeps answering
 *   discovery but refusing the socket, so retrying on a timer only repeats
 *   the refusal.
 *
 * Events: `failed` (an attempt or socket ended and the phase still allows
 * sync; `refused` when an admission close code ended a socket that never
 * proved stable), `keyRefused` (an admission close with `retry: "stop"`),
 * `stable` (a socket stayed admitted for STABLE_CONNECTION_MS), `timer` (the
 * backoff timer fired), `resume` (an explicit Retry, an `online` event, a
 * re-authentication or a first open), and `halt` (the phase stopped sync, so
 * a pending retry is dropped).
 *
 * Effects: `schedule` starts the backoff timer for `step` ms (the
 * interpreter applies reconnectDelay's jitter), `cancel` clears it,
 * `pauseSync` tells the person sync stopped and Retry resumes it, and
 * `reportOutage` tells the person the host has been unreachable for a while.
 * Retries continue after `reportOutage`; it repeats on each later transient
 * failure, so the interpreter shows it idempotently.
 *
 * Transient failures (no status, 5xx, a socket close without an admission
 * code) never count as refusals and never clear them: a flaky host between
 * refusals has not shown the refusal went away. From the OUTAGE_ATTEMPTS-th
 * failure in a row, a transient failure also reports an outage. A refusal
 * never does: the host answered.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

export const BASE_STEP_MS = 500;
export const MAX_STEP_MS = 60_000;
export const REFUSAL_LIMIT = 6;
// The failure in a row that reports an outage. The backoff before it sleeps
// 0.5 + 1 + … + 16 s before jitter, so a host restart that takes under about
// 15 s never shows one.
export const OUTAGE_ATTEMPTS = 7;
// The same threshold as elapsed time, for failures that don't follow this
// backoff: session refreshes and save receipts, which edits and other callers
// also trigger. Inside the window the seventh reconnect failure lands in.
export const OUTAGE_MS = 20_000;

/** The backoff step before jitter for a retry after `attempts` earlier ones:
 * 0.5 s doubling to a 60 s cap. */
export const backoffStep = (attempts) => Math.min(MAX_STEP_MS, BASE_STEP_MS * 2 ** attempts);

/** Equal jitter: half the step, plus a random share of the other half, so
 * tabs dropped together spread out but never retry sooner than step / 2.
 * `random` is in [0, 1), as from Math.random. */
export const reconnectDelay = (step, random) => Math.round(step / 2 + random * (step / 2));

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const count = (value, key, max = Number.MAX_SAFE_INTEGER) =>
  check(
    Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= max,
    `${key} must be an integer from 0 to ${max}`,
  );
function counters(state) {
  only(state, ["name", "attempts", "refusals"]);
  count(state, "attempts");
  count(state, "refusals", REFUSAL_LIMIT);
}
const typed = (keys) => (value) => only(value, ["type", ...keys]);

export const viewerReconnectSpec = Object.freeze({
  name: "viewer-reconnect",
  states: ["ready", "waiting", "refused", "paused"],
  events: ["failed", "keyRefused", "stable", "timer", "resume", "halt"],
  cases: {
    "ready/failed": ["transient", "outage", "refusal", "last-refusal"],
  },
  validate: {
    states: {
      ready(state) {
        counters(state);
        check(state.refusals < REFUSAL_LIMIT, "a ready session is below the refusal limit");
      },
      waiting(state) {
        counters(state);
        check(state.attempts > 0, "a waiting session has scheduled a retry");
        check(state.refusals < REFUSAL_LIMIT, "a waiting session is below the refusal limit");
      },
      refused: counters,
      paused(state) {
        counters(state);
        check(state.refusals === REFUSAL_LIMIT, "a paused session reached the refusal limit");
      },
    },
    events: {
      failed(event) {
        only(event, ["type", "refused"]);
        check(typeof event.refused === "boolean", "refused must be a boolean");
      },
      keyRefused: typed([]),
      stable: typed([]),
      timer: typed([]),
      resume: typed([]),
      halt: typed([]),
    },
    effects: {
      schedule(effect) {
        only(effect, ["type", "step"]);
        check(
          Number.isSafeInteger(effect.step) && effect.step > 0 && effect.step <= MAX_STEP_MS,
          "step must be a positive integer no greater than the cap",
        );
      },
      cancel: typed([]),
      pauseSync: typed([]),
      reportOutage: typed([]),
    },
  },
});

export const REJECT = Object.freeze({
  scheduled: "A reconnect is already scheduled",
  noTimer: "No reconnect is scheduled",
  refused: "The host refused this tab's signing key",
  paused: "Sync is paused until Retry",
  unstable: "No socket stayed admitted",
});

const ok = (state, ...effects) => ({ state, effects });
const fresh = () => ({ name: "ready", attempts: 0, refusals: 0 });
const keep = (name, { attempts, refusals }) => ({ name, attempts, refusals });

function transition(state, event) {
  // Resume clears both counters from any state and starts one attempt now.
  if (event.type === "resume")
    return state.name === "waiting" ? ok(fresh(), { type: "cancel" }) : ok(fresh());
  switch (state.name) {
    case "ready":
      switch (event.type) {
        case "failed": {
          const refusals = state.refusals + (event.refused ? 1 : 0);
          if (refusals >= REFUSAL_LIMIT)
            return ok(keep("paused", { attempts: state.attempts, refusals }), {
              type: "pauseSync",
            });
          const attempts = state.attempts + 1;
          const schedule = { type: "schedule", step: backoffStep(state.attempts) };
          if (!event.refused && attempts >= OUTAGE_ATTEMPTS)
            return ok(keep("waiting", { attempts, refusals }), schedule, { type: "reportOutage" });
          return ok(keep("waiting", { attempts, refusals }), schedule);
        }
        case "keyRefused":
          return ok(keep("refused", state));
        case "stable":
          return ok(fresh());
        default:
          return reject(state, REJECT.noTimer);
      }
    case "waiting":
      switch (event.type) {
        case "failed":
          return reject(state, REJECT.scheduled);
        case "keyRefused":
          return ok(keep("refused", state), { type: "cancel" });
        case "stable":
          return reject(state, REJECT.unstable);
        case "timer":
          return ok(keep("ready", state));
        case "halt":
          return ok(keep("ready", state), { type: "cancel" });
      }
      break;
    case "refused":
      if (event.type === "stable") return reject(state, REJECT.unstable);
      if (event.type === "timer" || event.type === "halt") return reject(state, REJECT.noTimer);
      return reject(state, REJECT.refused);
    case "paused":
      if (event.type === "keyRefused") return ok(keep("refused", state));
      if (event.type === "stable") return reject(state, REJECT.unstable);
      if (event.type === "timer" || event.type === "halt") return reject(state, REJECT.noTimer);
      return reject(state, REJECT.paused);
  }
  throw new Error(`unknown state ${state.name}`);
}

export const viewerReconnectMachine = defineMachine({
  ...viewerReconnectSpec,
  initial: { name: "ready", attempts: 0, refusals: 0 },
  transition,
});
