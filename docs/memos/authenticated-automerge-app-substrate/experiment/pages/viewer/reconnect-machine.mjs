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
 * - ready: no retry is pending. The session is discovering, connected, or
 *   stopped by its phase (sign-in, access, closing).
 * - handshaking: a sync socket is open and its authenticated handshake has
 *   not finished. The handshake timer is armed: a host that accepts the
 *   socket and then says nothing must count as a failed attempt, or the
 *   session waits on it forever with its edits unsent.
 * - waiting: a backoff timer is pending.
 * - refused: the host refused this tab's signing key (`retry: "stop"`).
 *   Reconnecting with the same key can't succeed.
 * - paused: REFUSAL_LIMIT refusals in a row. The host keeps answering
 *   discovery but refusing the socket, so retrying on a timer only repeats
 *   the refusal.
 *
 * Events: `handshake` (a socket opened and its handshake started),
 * `admitted` (the host admitted the socket in time), `handshakeEnded` (the
 * handshake failed or the attempt dropped its socket; the caller then
 * classifies the failure, so this only clears the deadline),
 * `handshakeTimeout` (the handshake timer fired), `failed` (an attempt or
 * socket ended and the phase still allows sync; `refused` when an admission
 * close code ended a socket that never proved stable), `keyRefused` (an
 * admission close with `retry: "stop"`), `stable` (a socket stayed admitted
 * for STABLE_CONNECTION_MS), `timer` (the backoff timer fired), `resume` (an
 * explicit Retry, an `online` event, a re-authentication or a first open),
 * and `halt` (the phase stopped sync, so a pending retry is dropped).
 *
 * Effects: `armHandshake` starts the handshake timer for `ms`,
 * `disarmHandshake` clears it, `abandonHandshake` closes the socket whose
 * handshake is pending (its attempt then fails like any closed socket),
 * `schedule` starts the backoff timer for `step` ms (the interpreter applies
 * reconnectDelay's jitter), `cancel` clears it, `pauseSync` tells the person
 * sync stopped and Retry resumes it, and `reportOutage` tells the person the
 * host has been unreachable for a while. Retries continue after
 * `reportOutage`; it repeats on each later transient failure, so the
 * interpreter shows it idempotently.
 *
 * A handshake timeout is a transient failure: it schedules the same backoff
 * as a closed socket and counts toward an outage, never toward refusals.
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
// How long an open socket may take to finish its authenticated handshake. A
// host restart or a proxy that holds the socket without answering shows up
// as a silent open socket; past this the attempt fails and backs off.
export const HANDSHAKE_TIMEOUT_MS = 10_000;

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
  states: ["ready", "handshaking", "waiting", "refused", "paused"],
  events: [
    "handshake",
    "admitted",
    "handshakeEnded",
    "handshakeTimeout",
    "failed",
    "keyRefused",
    "stable",
    "timer",
    "resume",
    "halt",
  ],
  cases: {
    "ready/failed": ["transient", "outage", "refusal", "last-refusal"],
    "handshaking/failed": ["transient", "outage", "refusal", "last-refusal"],
    "handshaking/handshakeTimeout": ["transient", "outage"],
  },
  validate: {
    states: {
      ready(state) {
        counters(state);
        check(state.refusals < REFUSAL_LIMIT, "a ready session is below the refusal limit");
      },
      handshaking(state) {
        counters(state);
        check(state.refusals < REFUSAL_LIMIT, "a handshaking session is below the refusal limit");
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
      handshake: typed([]),
      admitted: typed([]),
      handshakeEnded: typed([]),
      handshakeTimeout: typed([]),
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
      armHandshake(effect) {
        only(effect, ["type", "ms"]);
        check(effect.ms === HANDSHAKE_TIMEOUT_MS, "the handshake timer is fixed");
      },
      disarmHandshake: typed([]),
      abandonHandshake: typed([]),
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
  noHandshake: "No handshake is in progress",
  handshaking: "A handshake is in progress",
});

const ok = (state, ...effects) => ({ state, effects });
const fresh = () => ({ name: "ready", attempts: 0, refusals: 0 });
const keep = (name, { attempts, refusals }) => ({ name, attempts, refusals });

/** A failed attempt from `state`: back off, or pause at the refusal limit.
 * `before` runs ahead of the backoff effects. */
function fail(state, refused, before = []) {
  const refusals = state.refusals + (refused ? 1 : 0);
  if (refusals >= REFUSAL_LIMIT)
    return ok(keep("paused", { attempts: state.attempts, refusals }), ...before, {
      type: "pauseSync",
    });
  const attempts = state.attempts + 1;
  const schedule = { type: "schedule", step: backoffStep(state.attempts) };
  if (!refused && attempts >= OUTAGE_ATTEMPTS)
    return ok(keep("waiting", { attempts, refusals }), ...before, schedule, {
      type: "reportOutage",
    });
  return ok(keep("waiting", { attempts, refusals }), ...before, schedule);
}

function transition(state, event) {
  // Resume clears both counters from any state and starts one attempt now. A
  // handshake still pending is abandoned so the new attempt replaces it.
  if (event.type === "resume") {
    if (state.name === "waiting") return ok(fresh(), { type: "cancel" });
    if (state.name === "handshaking")
      return ok(fresh(), { type: "disarmHandshake" }, { type: "abandonHandshake" });
    return ok(fresh());
  }
  switch (state.name) {
    case "ready":
      switch (event.type) {
        case "handshake":
          return ok(keep("handshaking", state), {
            type: "armHandshake",
            ms: HANDSHAKE_TIMEOUT_MS,
          });
        case "failed":
          return fail(state, event.refused);
        case "keyRefused":
          return ok(keep("refused", state));
        case "stable":
          return ok(fresh());
        case "admitted":
        case "handshakeEnded":
        case "handshakeTimeout":
          return reject(state, REJECT.noHandshake);
        default:
          return reject(state, REJECT.noTimer);
      }
    case "handshaking":
      switch (event.type) {
        case "handshake":
          return reject(state, REJECT.handshaking);
        case "admitted":
        case "handshakeEnded":
          return ok(keep("ready", state), { type: "disarmHandshake" });
        case "handshakeTimeout":
          // The timer fired, so nothing is left to disarm. Closing the socket
          // ends the attempt; its failure finds the retry already scheduled.
          return fail(state, false, [{ type: "abandonHandshake" }]);
        case "failed":
          return fail(state, event.refused, [{ type: "disarmHandshake" }]);
        case "keyRefused":
          return ok(keep("refused", state), { type: "disarmHandshake" });
        case "stable":
          return reject(state, REJECT.unstable);
        case "timer":
          return reject(state, REJECT.noTimer);
        case "halt":
          return ok(keep("ready", state), { type: "disarmHandshake" });
      }
      break;
    case "waiting":
      switch (event.type) {
        case "handshake":
          return reject(state, REJECT.scheduled);
        case "admitted":
        case "handshakeEnded":
        case "handshakeTimeout":
          return reject(state, REJECT.noHandshake);
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
      if (["admitted", "handshakeEnded", "handshakeTimeout"].includes(event.type))
        return reject(state, REJECT.noHandshake);
      return reject(state, REJECT.refused);
    case "paused":
      if (event.type === "keyRefused") return ok(keep("refused", state));
      if (event.type === "stable") return reject(state, REJECT.unstable);
      if (event.type === "timer" || event.type === "halt") return reject(state, REJECT.noTimer);
      if (["admitted", "handshakeEnded", "handshakeTimeout"].includes(event.type))
        return reject(state, REJECT.noHandshake);
      return reject(state, REJECT.paused);
  }
  throw new Error(`unknown state ${state.name}`);
}

export const viewerReconnectMachine = defineMachine({
  ...viewerReconnectSpec,
  initial: { name: "ready", attempts: 0, refusals: 0 },
  transition,
});
