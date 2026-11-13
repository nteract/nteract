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
 * else; and `signedIn`: the last answer applied named an account, which a
 * failed or unreachable answer leaves as it was:
 * - idle: no request and no renewal timer. The tab hasn't asked yet, or it is
 *   signed out. `keepAlive` says whether a failed request schedules the next
 *   renewal.
 * - scheduled: the renewal timer is pending. With `failingSince` set, the last
 *   renewal went unanswered and this one retries it.
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
 *   `signedOut` (no identity), `refused` (401 or 403), `unreachable` (no
 *   answer, isUnansweredFailure: a restart, a gateway error, a lost
 *   connection or the request deadline) or `failed` (anything else, such as
 *   a 500).
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
 * A failed or unreachable answer renews like `signedIn` while `keepAlive`.
 * Its `apply` carries `notice`, what the viewer says about it:
 * - `quiet`: nothing. An unreachable answer for a tab that is signed in,
 *   before the run of them has lasted OUTAGE_MS. The Page keeps working on
 *   the session it has, and the next renewal asks again.
 * - `outage`: one notice that the server can't be reached, once the run of
 *   unreachable answers has lasted OUTAGE_MS, until any other answer ends
 *   the run.
 * - `failure`: the error itself. Any `failed` answer, and an unreachable one
 *   for a tab with no account yet, which has nothing else on screen.
 * Page reconnects refresh the session too, so an open Page reaches the
 * threshold on its own cadence; a tab with only the renewal timer reaches it
 * on the next renewal.
 */
import { defineMachine, reject } from "../shared/machine.mjs";
import { OUTAGE_MS } from "./reconnect-machine.mjs";

export const RENEW_MS = 60_000;
export const REASONS = Object.freeze(["renew", "visible", "retry"]);
export const NOTICES = Object.freeze(["quiet", "outage", "failure"]);
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
const signedIn = (state) =>
  check(typeof state.signedIn === "boolean", "signedIn must be a boolean");
const tracked = (state) => {
  only(state, ["name", "signedIn", "failingSince"]);
  signedIn(state);
  failingSince(state);
};
const keepAlive = (state) => {
  only(state, ["name", "keepAlive", "signedIn", "failingSince"]);
  check(typeof state.keepAlive === "boolean", "keepAlive must be a boolean");
  signedIn(state);
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
      "unreachable-no-account",
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
        only(effect, ["type", "outcome", "notice"]);
        check(OUTCOMES.includes(effect.outcome), `outcome must be one of ${OUTCOMES.join(", ")}`);
        const failure = effect.outcome === "failed" || effect.outcome === "unreachable";
        check(failure === "notice" in effect, "only a failed or unreachable outcome has a notice");
        if (failure)
          check(NOTICES.includes(effect.notice), `notice must be one of ${NOTICES.join(", ")}`);
        if (effect.outcome === "failed")
          check(effect.notice === "failure", "a failed answer's notice is failure");
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

/** What the viewer says about a failed or unreachable answer (see NOTICES),
 * `failingFor` ms into the run of unreachable answers. */
function failureNotice(state, outcome, failingFor) {
  if (outcome === "failed") return "failure";
  if (failingFor >= OUTAGE_MS) return "outage";
  return state.signedIn ? "quiet" : "failure";
}

// `apply` comes last: the viewer's callback may refresh again, and that
// refresh must start from the settled state with the timer and waiters done.
function settle(state, { outcome, at }) {
  const unreachable = outcome === "unreachable";
  const failed = outcome === "failed" || unreachable;
  const since = unreachable ? (state.failingSince ?? at) : null;
  const signedIn = failed ? state.signedIn : outcome === "signedIn";
  const apply = failed
    ? { type: "apply", outcome, notice: failureNotice(state, outcome, at - since) }
    : { type: "apply", outcome };
  const renew = outcome === "signedIn" || (failed && state.keepAlive);
  if (renew)
    return {
      state: { name: "scheduled", signedIn, failingSince: since },
      effects: [{ ...SCHEDULE }, { type: "answer" }, apply],
    };
  return {
    state: { name: "idle", keepAlive: false, signedIn, failingSince: since },
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
        state: { ...state, name: "requesting" },
        effects: [{ type: "request" }],
      };
    case "scheduled":
      if (event.type === "stop")
        return { state: { name: "stopped" }, effects: [{ type: "cancelTimer" }] };
      return {
        state: { ...state, name: "requesting", keepAlive: true },
        effects: [{ type: "cancelTimer" }, { type: "request" }],
      };
    case "requesting":
      if (event.type === "stop") return { state: { name: "stopped" }, effects: [] };
      if (event.type === "settled") return settle(state, event);
      if (event.reason === "renew") return reject(state, REJECT.joined);
      return {
        state: { ...state, name: "superseded" },
        effects: [],
      };
    case "superseded":
      if (event.type === "stop") return { state: { name: "stopped" }, effects: [] };
      if (event.type === "refresh") return reject(state, REJECT.queued);
      // The stale answer is dropped, outage history included; waiters stay
      // for the fresh request.
      return {
        state: { ...state, name: "requesting" },
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
  initial: { name: "idle", keepAlive: true, signedIn: false, failingSince: null },
  transition,
});
