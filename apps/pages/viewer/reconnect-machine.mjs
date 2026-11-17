/**
 * A viewer session's automatic reconnects as a state machine.
 *
 * The session-machine phase says whether a session may sync at all. This
 * machine says what the session does after a sync attempt or socket fails
 * while it may: wait and retry, or stop until a person acts.
 *
 * States, each carrying `attempts` (retries scheduled since the last stable
 * connection or resume; it picks the backoff step) and `refusals` (attempts
 * in a row that the host's native admission refused before the socket proved
 * stable; a `temporarily_unavailable` close is transient, not a refusal, see
 * session.mjs countsAsRefusal):
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
 * - parked: the tab stayed hidden for PARK_AFTER_MS with everything synced,
 *   so the session closed its socket on purpose. No socket, no retry and no
 *   backoff: the Page's Durable Object can sleep. Showing the tab again, or a
 *   local change that needs the host, reconnects at once.
 *
 * Every state but `parked` may also carry `park: true`: the tab has been
 * hidden for PARK_AFTER_MS, but parking waits for this replica's edits to
 * reach the host. The flag survives the other transitions, so a hidden tab
 * that is retrying, refused or paused still parks once it is synced, and
 * showing the tab clears it.
 *
 * Events: `handshake` (a socket opened and its handshake started),
 * `admitted` (the host admitted the socket in time), `handshakeEnded` (the
 * handshake failed or the attempt dropped its socket; the caller then
 * classifies the failure, so this only clears the deadline),
 * `handshakeTimeout` (the handshake timer fired), `failed` (an attempt or
 * socket ended and the phase still allows sync; `refused` when an admission
 * close code ended a socket that never proved stable; `retryAfterMs` when the
 * host's answer said how long to wait), `keyRefused` (an
 * admission close with `retry: "stop"`), `stable` (a socket stayed admitted
 * for STABLE_CONNECTION_MS), `timer` (the backoff timer fired), `resume` (an
 * explicit Retry, an `online` event, a re-authentication or a first open),
 * and `halt` (the phase stopped sync, so a pending retry is dropped).
 * `leaseExpired` is an admitted socket's scheduled Project deadline: retry
 * at the base step without counting a healthy lease cycle as an outage.
 * `hiddenTimeout` is the tab staying hidden for PARK_AFTER_MS; its `synced`
 * says the host has acknowledged every edit this replica holds. `synced` and
 * `unsynced` report that fact changing while it matters: a state waiting to
 * park became synced, or a parked one took a local change. `visible` is the
 * tab shown again. Parking is deliberate, so none of these count as failures
 * or move the backoff, and a parked session ignores `resume`: an `online`
 * event or a session renewal while hidden doesn't reconnect it.
 *
 * Effects: `armHandshake` starts the handshake timer for `ms`,
 * `disarmHandshake` clears it, `abandonHandshake` ends the pending handshake
 * and closes its socket, with the `reason` the interpreter answers the
 * attempt with (`timeout`: a transient failure that takes the backoff;
 * `resume`: the new attempt replaces it; `halt`: the phase stopped sync, so
 * nothing follows; `failed`: the socket's own outcome already ended the
 * attempt, so the retry or refusal it carries is all that follows; `park`:
 * the hidden tab parked, so nothing follows until it shows). The
 * attempt always settles, so a stalled setup can't hold the session's one
 * in-flight connect past the state that abandoned it,
 * `schedule` starts the backoff timer for `step` ms (the interpreter applies
 * reconnectDelay's jitter, and waits at least `minMs` when present: a
 * Retry-After the host sent, capped at MAX_STEP_MS), `cancel` clears it, `pauseSync` tells the person
 * sync stopped and Retry resumes it, and `reportOutage` tells the person the
 * host has been unreachable for a while. `park` closes the session's
 * sockets the way leaving the Page does, and `unpark` starts a connection
 * attempt. Retries continue after
 * `reportOutage`; it repeats on each later transient failure, so the
 * interpreter shows it idempotently.
 *
 * A handshake timeout is a transient failure: it schedules the same backoff
 * as a closed socket and counts toward an outage, never toward refusals.
 *
 * Transient failures (no status, 5xx, a 4xx the session doesn't treat as
 * definitive, a socket close without an admission code or with
 * `temporarily_unavailable`) never count as refusals and never clear them:
 * a flaky host between
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
// How long a tab stays hidden before a synced session parks. A fixed rule,
// not a setting.
export const PARK_AFTER_MS = 5 * 60_000;
export const ABANDON_REASONS = Object.freeze(["timeout", "resume", "halt", "failed", "park"]);

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
  only(state, ["name", "attempts", "refusals", "park"]);
  count(state, "attempts");
  count(state, "refusals", REFUSAL_LIMIT);
  check(state.park === undefined || state.park === true, "park is true or absent");
}
const typed = (keys) => (value) => only(value, ["type", ...keys]);

export const viewerReconnectSpec = Object.freeze({
  name: "viewer-reconnect",
  states: ["ready", "handshaking", "waiting", "refused", "paused", "parked"],
  events: [
    "handshake",
    "admitted",
    "handshakeEnded",
    "handshakeTimeout",
    "failed",
    "keyRefused",
    "stable",
    "leaseExpired",
    "timer",
    "resume",
    "halt",
    "hiddenTimeout",
    "synced",
    "unsynced",
    "visible",
  ],
  cases: {
    "ready/failed": ["transient", "outage", "refusal", "last-refusal", "retry-after"],
    "handshaking/failed": ["transient", "outage", "refusal", "last-refusal", "retry-after"],
    "handshaking/handshakeTimeout": ["transient", "outage"],
    ...Object.fromEntries(
      ["ready", "handshaking", "waiting"].flatMap((state) => [
        [`${state}/hiddenTimeout`, ["synced", "unsynced", "parking"]],
        [`${state}/synced`, ["parking", "not-parking"]],
        [`${state}/visible`, ["parking", "not-parking"]],
      ]),
    ),
    ...Object.fromEntries(
      ["refused", "paused"].flatMap((state) => [
        [`${state}/hiddenTimeout`, ["hidden", "parking"]],
        [`${state}/visible`, ["parking", "not-parking"]],
      ]),
    ),
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
      parked: (state) => only(state, ["name"]),
    },
    events: {
      handshake: typed([]),
      admitted: typed([]),
      handshakeEnded: typed([]),
      handshakeTimeout: typed([]),
      failed(event) {
        only(event, ["type", "refused", "retryAfterMs"]);
        check(typeof event.refused === "boolean", "refused must be a boolean");
        if ("retryAfterMs" in event)
          check(
            Number.isSafeInteger(event.retryAfterMs) && event.retryAfterMs > 0,
            "retryAfterMs must be a positive integer",
          );
      },
      keyRefused: typed([]),
      stable: typed([]),
      leaseExpired: typed([]),
      timer: typed([]),
      resume: typed([]),
      halt: typed([]),
      hiddenTimeout(event) {
        only(event, ["type", "synced"]);
        check(typeof event.synced === "boolean", "synced must be a boolean");
      },
      synced: typed([]),
      unsynced: typed([]),
      visible: typed([]),
    },
    effects: {
      armHandshake(effect) {
        only(effect, ["type", "ms"]);
        check(effect.ms === HANDSHAKE_TIMEOUT_MS, "the handshake timer is fixed");
      },
      disarmHandshake: typed([]),
      abandonHandshake(effect) {
        only(effect, ["type", "reason"]);
        check(ABANDON_REASONS.includes(effect.reason), "reason names what ended the handshake");
      },
      schedule(effect) {
        only(effect, ["type", "step", "minMs"]);
        check(
          Number.isSafeInteger(effect.step) && effect.step > 0 && effect.step <= MAX_STEP_MS,
          "step must be a positive integer no greater than the cap",
        );
        if ("minMs" in effect)
          check(
            Number.isSafeInteger(effect.minMs) && effect.minMs > 0 && effect.minMs <= MAX_STEP_MS,
            "minMs must be a positive integer no greater than the cap",
          );
      },
      cancel: typed([]),
      pauseSync: typed([]),
      reportOutage: typed([]),
      park: typed([]),
      unpark: typed([]),
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
  parking: "The hidden tab already waits to park",
  notParking: "The tab isn't waiting to park",
  parked: "The hidden tab is parked until it shows",
  notParked: "The session isn't parked",
  noSocket: "No socket to park",
});

const ok = (state, ...effects) => ({ state, effects });
// Every transition but showing the tab or parking keeps the park flag.
const parkOf = (state) => (state.park ? { park: true } : {});
const fresh = (state) => ({ name: "ready", attempts: 0, refusals: 0, ...parkOf(state) });
const keep = (name, state) => ({
  name,
  attempts: state.attempts,
  refusals: state.refusals,
  ...parkOf(state),
});
const unflag = ({ park, ...state }) => state;
const PARKED = Object.freeze({ name: "parked" });
const PARK = Object.freeze({ type: "park" });
// What a state drops on its way to `parked`: its pending retry or
// handshake, then its sockets. Refused and paused hold neither.
const LEAVE_FOR_PARK = Object.freeze({
  ready: [PARK],
  waiting: [{ type: "cancel" }, PARK],
  handshaking: [{ type: "disarmHandshake" }, { type: "abandonHandshake", reason: "park" }, PARK],
});

/** The tab's hidden events on every state but `parked`, or undefined. */
function hiddenStep(state, event) {
  const leave = LEAVE_FOR_PARK[state.name];
  switch (event.type) {
    case "hiddenTimeout":
      if (state.park) return reject(state, REJECT.parking);
      // With no socket, the flag waits: if a resume connects this session
      // while it's still hidden, it parks once synced.
      if (!leave || !event.synced) return ok({ ...state, park: true });
      return { state: PARKED, effects: [...leave] };
    case "synced":
      if (!leave) return reject(state, REJECT.noSocket);
      if (!state.park) return reject(state, REJECT.notParking);
      return { state: PARKED, effects: [...leave] };
    case "unsynced":
      return reject(state, REJECT.notParked);
    case "visible":
      return state.park ? ok(unflag(state)) : reject(state, REJECT.notParking);
  }
  return undefined;
}

/** A parked session: only showing the tab or a local change reconnects it. */
function parkedStep(state, event) {
  switch (event.type) {
    case "visible":
      return ok(fresh({}), { type: "unpark" });
    case "unsynced":
      // The edit must reach the host, so connect; park again once it has.
      return ok(fresh({ park: true }), { type: "unpark" });
    case "halt":
      // The phase stopped sync, so showing the tab reconnects nothing.
      return ok(fresh({}));
    case "handshake":
    case "admitted":
    case "handshakeEnded":
    case "handshakeTimeout":
      return reject(state, REJECT.noHandshake);
    case "stable":
      return reject(state, REJECT.unstable);
    case "timer":
      return reject(state, REJECT.noTimer);
    default:
      // hiddenTimeout, synced, resume, and a late failed, keyRefused or
      // leaseExpired from an attempt that started before parking.
      return reject(state, REJECT.parked);
  }
}

/** A failed attempt from `state`: back off, or pause at the refusal limit.
 * `retryAfterMs` is the host's requested wait; the retry waits at least that,
 * up to the backoff cap. `before` runs ahead of the backoff effects. */
function fail(state, refused, before = [], retryAfterMs) {
  const refusals = state.refusals + (refused ? 1 : 0);
  if (refusals >= REFUSAL_LIMIT)
    return ok(keep("paused", { ...state, refusals }), ...before, {
      type: "pauseSync",
    });
  const attempts = state.attempts + 1;
  const schedule = {
    type: "schedule",
    step: backoffStep(state.attempts),
    ...(retryAfterMs !== undefined && { minMs: Math.min(retryAfterMs, MAX_STEP_MS) }),
  };
  if (!refused && attempts >= OUTAGE_ATTEMPTS)
    return ok(keep("waiting", { ...state, attempts, refusals }), ...before, schedule, {
      type: "reportOutage",
    });
  return ok(keep("waiting", { ...state, attempts, refusals }), ...before, schedule);
}

function transition(state, event) {
  if (state.name === "parked") return parkedStep(state, event);
  const hidden = hiddenStep(state, event);
  if (hidden) return hidden;
  if (event.type === "leaseExpired")
    return state.name === "ready" ? fail(fresh(state), false) : reject(state, REJECT.unstable);
  // Resume clears both counters from any state and starts one attempt now. A
  // handshake still pending is abandoned so the new attempt replaces it.
  if (event.type === "resume") {
    if (state.name === "waiting") return ok(fresh(state), { type: "cancel" });
    if (state.name === "handshaking")
      return ok(
        fresh(state),
        { type: "disarmHandshake" },
        { type: "abandonHandshake", reason: "resume" },
      );
    return ok(fresh(state));
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
          return fail(state, event.refused, [], event.retryAfterMs);
        case "keyRefused":
          return ok(keep("refused", state));
        case "stable":
          return ok(fresh(state));
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
          return fail(state, false, [{ type: "abandonHandshake", reason: "timeout" }]);
        case "failed":
          // The socket closed under a pending setup (its disconnect callback,
          // not a rejection). Settle the attempt too, or it holds connect().
          return fail(
            state,
            event.refused,
            [{ type: "disarmHandshake" }, { type: "abandonHandshake", reason: "failed" }],
            event.retryAfterMs,
          );
        case "keyRefused":
          return ok(
            keep("refused", state),
            { type: "disarmHandshake" },
            { type: "abandonHandshake", reason: "failed" },
          );
        case "stable":
          return reject(state, REJECT.unstable);
        case "timer":
          return reject(state, REJECT.noTimer);
        case "halt":
          // Closing the sockets alone may leave the setup pending; the attempt
          // must settle so the session can connect again after sign-in.
          return ok(
            keep("ready", state),
            { type: "disarmHandshake" },
            { type: "abandonHandshake", reason: "halt" },
          );
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
