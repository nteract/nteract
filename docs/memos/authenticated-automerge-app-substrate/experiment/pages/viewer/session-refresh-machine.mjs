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
 * States:
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
 *   `signedOut` (no identity), `refused` (401 or 403) or `failed` (anything
 *   else, such as a timeout or 5xx).
 * - stop: the viewer unmounted.
 *
 * Effects: `request` starts one session request; `cancelTimer` clears the
 * renewal timer; `schedule` arms it for `delayMs`; `apply` hands the settled
 * request's answer to the viewer by `outcome`; `answer` settles every waiter
 * with that answer.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

export const RENEW_MS = 60_000;
export const REASONS = Object.freeze(["renew", "visible", "retry"]);
export const OUTCOMES = Object.freeze(["signedIn", "signedOut", "refused", "failed"]);

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const named = (value) => only(value, ["name"]);
const keepAlive = (state) => {
  only(state, ["name", "keepAlive"]);
  check(typeof state.keepAlive === "boolean", "keepAlive must be a boolean");
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
    "requesting/settled": ["signedIn", "signedOut", "refused", "failed-keep-alive", "failed-idle"],
  },
  validate: {
    states: {
      idle: keepAlive,
      scheduled: named,
      requesting: keepAlive,
      superseded: keepAlive,
      stopped: named,
    },
    events: {
      refresh: oneOf("reason", REASONS),
      settled: oneOf("outcome", OUTCOMES),
      stop: typed([]),
    },
    effects: {
      request: typed([]),
      cancelTimer: typed([]),
      schedule: (effect) => {
        only(effect, ["type", "delayMs"]);
        check(effect.delayMs === RENEW_MS, `delayMs must be ${RENEW_MS}`);
      },
      apply: oneOf("outcome", OUTCOMES),
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
function settle(state, outcome) {
  const apply = { type: "apply", outcome };
  const renew = outcome === "signedIn" || (outcome === "failed" && state.keepAlive);
  if (renew)
    return { state: { name: "scheduled" }, effects: [{ ...SCHEDULE }, { type: "answer" }, apply] };
  return { state: { name: "idle", keepAlive: false }, effects: [{ type: "answer" }, apply] };
}

function transition(state, event) {
  switch (state.name) {
    case "idle":
      if (event.type === "stop") return { state: { name: "stopped" }, effects: [] };
      // event.type === "refresh"; settled is unreachable.
      if (event.reason === "renew") return reject(state, REJECT.noRenewal);
      return {
        state: { name: "requesting", keepAlive: state.keepAlive },
        effects: [{ type: "request" }],
      };
    case "scheduled":
      if (event.type === "stop")
        return { state: { name: "stopped" }, effects: [{ type: "cancelTimer" }] };
      return {
        state: { name: "requesting", keepAlive: true },
        effects: [{ type: "cancelTimer" }, { type: "request" }],
      };
    case "requesting":
      if (event.type === "stop") return { state: { name: "stopped" }, effects: [] };
      if (event.type === "settled") return settle(state, event.outcome);
      if (event.reason === "renew") return reject(state, REJECT.joined);
      return { state: { name: "superseded", keepAlive: state.keepAlive }, effects: [] };
    case "superseded":
      if (event.type === "stop") return { state: { name: "stopped" }, effects: [] };
      if (event.type === "refresh") return reject(state, REJECT.queued);
      // The stale answer is dropped; waiters stay for the fresh request.
      return {
        state: { name: "requesting", keepAlive: state.keepAlive },
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
  initial: { name: "idle", keepAlive: true },
  transition,
});
