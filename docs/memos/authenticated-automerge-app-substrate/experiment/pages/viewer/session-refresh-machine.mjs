/**
 * The browser's session refreshes (browser-session.mjs) as a state machine.
 *
 * One session request is in flight at a time. A refresh that only renews the
 * cookie joins the request in flight. A refresh whose answer can differ from
 * the one in flight (the tab became visible, so another tab may have signed
 * in or out, or a caller asked again) queues one fresh request after it. The
 * request in flight is then superseded: its answer is dropped, and every
 * waiter gets the fresh request's answer instead.
 *
 * States, each but `stopped` carrying `failingSince`: when the first of the
 * current run of `unreachable` answers arrived (ms on the interpreter's
 * monotonic clock, monotonic.mjs), or null when the last answer was anything
 * else:
 * - idle: no request and no renewal timer. The tab hasn't asked yet, or it is
 *   signed out. `keepAlive` says whether a failed request schedules the next
 *   renewal.
 * - scheduled: signed in; the renewal timer is pending.
 * - requesting: one request is in flight. Carries `keepAlive`.
 * - superseded: one request is in flight, its answer is stale, and one fresh
 *   request follows it. Carries `keepAlive`.
 * - stopped: the viewer unmounted. A request still in flight answers its
 *   waiters and nothing else.
 *
 * Events:
 * - refresh: `reason` is `renew` (the renewal timer fired), `visible` (the tab
 *   became visible) or `retry` (a caller asked for the current session).
 * - settled: the request in flight answered. `outcome` is `signedIn`,
 *   `signedOut` (no identity), `refused` (401 or 403), `unreachable` (a
 *   transient failure, isTransientFailure: a restart, a gateway error, a lost
 *   connection) or `failed` (anything else, such as a timeout or a 500).
 *   `at` is when it answered, on the same monotonic clock; `unreachable`
 *   needs it. The machine only subtracts two `at`s, so a wall-clock change
 *   can't move an outage.
 * - stop: the viewer unmounted.
 *
 * Effects: `request` starts one session request; `cancelTimer` clears the
 * renewal timer; `schedule` arms it for `delayMs`; `apply` hands the settled
 * request's answer to the viewer by `outcome`; `answer` settles every waiter
 * with that answer.
 *
 * An `unreachable` answer renews like `failed`. Its `apply` carries `outage`:
 * true once the run of unreachable answers has lasted OUTAGE_MS, so the
 * viewer stays quiet through a restart and shows one notice for an outage,
 * until any other answer ends the run. Page reconnects refresh the session
 * too, so an open Page reaches the threshold on its own cadence; a tab with
 * only the renewal timer reaches it on the next renewal.
 */
import { defineMachine, reject } from "../shared/machine.mjs";
import { OUTAGE_MS } from "./reconnect-machine.mjs";

export const RENEW_MS = 60_000;
export const REASONS = Object.freeze(["renew", "visible", "retry"]);
export const OUTCOMES = Object.freeze([
  "signedIn",
  "signedOut",
  "refused",
  "unreachable",
  "failed",
]);

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const named = (value) => only(value, ["name"]);
const failingSince = (state) =>
  check(
    state.failingSince === null || (Number.isFinite(state.failingSince) && state.failingSince >= 0),
    "failingSince must be null or a time in ms",
  );
const tracked = (state) => {
  only(state, ["name", "failingSince"]);
  failingSince(state);
};
const keepAlive = (state) => {
  only(state, ["name", "keepAlive", "failingSince"]);
  check(typeof state.keepAlive === "boolean", "keepAlive must be a boolean");
  failingSince(state);
};
const typed = (keys) => (value) => only(value, ["type", ...keys]);
const oneOf = (key, values) => (value) => {
  only(value, ["type", key]);
  check(values.includes(value[key]), `${key} must be one of ${values.join(", ")}`);
};

export const sessionRefreshSpec = Object.freeze({
  name: "session-refresh",
  states: ["idle", "scheduled", "requesting", "superseded", "stopped"],
  events: ["refresh", "settled", "stop"],
  unreachable: [
    ["idle", "settled", "idle has no request in flight"],
    ["scheduled", "settled", "scheduled has no request in flight"],
  ],
  cases: {
    "idle/refresh": ["renew", "visible", "retry"],
    "requesting/refresh": ["renew", "visible", "retry"],
    "requesting/settled": [
      "signedIn",
      "signedOut",
      "refused",
      "failed-keep-alive",
      "failed-idle",
      "unreachable-first",
      "unreachable-brief",
      "unreachable-outage",
      "unreachable-idle",
    ],
  },
  validate: {
    states: {
      idle: keepAlive,
      scheduled: tracked,
      requesting: keepAlive,
      superseded: keepAlive,
      stopped: named,
    },
    events: {
      refresh: oneOf("reason", REASONS),
      settled(event) {
        only(event, ["type", "outcome", "at"]);
        check(OUTCOMES.includes(event.outcome), `outcome must be one of ${OUTCOMES.join(", ")}`);
        if (event.outcome === "unreachable" || "at" in event)
          check(Number.isFinite(event.at) && event.at >= 0, "at must be a time in ms");
      },
      stop: typed([]),
    },
    effects: {
      request: typed([]),
      cancelTimer: typed([]),
      schedule: (effect) => {
        only(effect, ["type", "delayMs"]);
        check(effect.delayMs === RENEW_MS, `delayMs must be ${RENEW_MS}`);
      },
      apply(effect) {
        only(effect, ["type", "outcome", "outage"]);
        check(OUTCOMES.includes(effect.outcome), `outcome must be one of ${OUTCOMES.join(", ")}`);
        check(
          (effect.outcome === "unreachable") === (typeof effect.outage === "boolean"),
          "only an unreachable outcome says whether it is an outage",
        );
      },
      answer: typed([]),
    },
  },
});

export const REJECT = Object.freeze({
  noRenewal: "No renewal is scheduled",
  joined: "Joined the request in flight",
  queued: "A fresh request is already queued",
  stopped: "Session maintenance stopped",
});

const SCHEDULE = Object.freeze({ type: "schedule", delayMs: RENEW_MS });

// `apply` comes last: the viewer's callback may refresh again, and that
// refresh must start from the settled state with the timer and waiters done.
function settle(state, { outcome, at }) {
  const unreachable = outcome === "unreachable";
  const since = unreachable ? (state.failingSince ?? at) : null;
  const apply = unreachable
    ? { type: "apply", outcome, outage: at - since >= OUTAGE_MS }
    : { type: "apply", outcome };
  const failed = outcome === "failed" || unreachable;
  const renew = outcome === "signedIn" || (failed && state.keepAlive);
  if (renew)
    return {
      state: { name: "scheduled", failingSince: since },
      effects: [{ ...SCHEDULE }, { type: "answer" }, apply],
    };
  return {
    state: { name: "idle", keepAlive: false, failingSince: since },
    effects: [{ type: "answer" }, apply],
  };
}

function transition(state, event) {
  switch (state.name) {
    case "idle":
      if (event.type === "stop") return { state: { name: "stopped" }, effects: [] };
      // event.type === "refresh"; settled is unreachable.
      if (event.reason === "renew") return reject(state, REJECT.noRenewal);
      return {
        state: { name: "requesting", keepAlive: state.keepAlive, failingSince: state.failingSince },
        effects: [{ type: "request" }],
      };
    case "scheduled":
      if (event.type === "stop")
        return { state: { name: "stopped" }, effects: [{ type: "cancelTimer" }] };
      return {
        state: { name: "requesting", keepAlive: true, failingSince: state.failingSince },
        effects: [{ type: "cancelTimer" }, { type: "request" }],
      };
    case "requesting":
      if (event.type === "stop") return { state: { name: "stopped" }, effects: [] };
      if (event.type === "settled") return settle(state, event);
      if (event.reason === "renew") return reject(state, REJECT.joined);
      return {
        state: { name: "superseded", keepAlive: state.keepAlive, failingSince: state.failingSince },
        effects: [],
      };
    case "superseded":
      if (event.type === "stop") return { state: { name: "stopped" }, effects: [] };
      if (event.type === "refresh") return reject(state, REJECT.queued);
      // The stale answer is dropped, outage history included; waiters stay
      // for the fresh request.
      return {
        state: { name: "requesting", keepAlive: state.keepAlive, failingSince: state.failingSince },
        effects: [{ type: "request" }],
      };
    case "stopped":
      if (event.type === "settled") return { state, effects: [{ type: "answer" }] };
      return reject(state, REJECT.stopped);
  }
  throw new Error(`unknown state ${state.name}`);
}

export const sessionRefreshMachine = defineMachine({
  ...sessionRefreshSpec,
  initial: { name: "idle", keepAlive: true, failingSince: null },
  transition,
});
