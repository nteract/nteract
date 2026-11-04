/**
 * What the shell does when the server refuses a tool call as signed out (a
 * structured 401, request.mjs observeSignedOut), or answers one for another
 * account than the tab's (another window signed in), as a state machine.
 *
 * Every refusal forgets what the tab remembers for the account at once. An
 * answer for another account forgets nothing: nothing remembers it (the
 * listing cache, ProjectList and the Browse picker each refuse it). Either
 * way a recovery then asks the session check who is signed in and, when it
 * is the same account, asks for the account's Projects again (`check`). One
 * check runs at a time. A refusal or another account's answer while one runs
 * (its own list_projects, or any other request) sets `rearm`: a refusal
 * forgets again, which may drop the Projects the running check asked for, so
 * when the check settles, it runs once more. Reruns are capped at
 * RECOVERY_RERUNS in a row, so a server that keeps refusing, or keeps
 * answering for someone else, costs at most 1 + RECOVERY_RERUNS checks before
 * the machine is idle again; only a new refusal or answer starts another
 * recovery.
 *
 * Each check has a `generation`, one more than the check before it, so a
 * caller can tell a check that started after its own evidence from one
 * already running (the Browse picker, picker-walk.mjs).
 *
 * States:
 * - idle: no check in flight. `generation` is the last check's, 0 before any.
 * - recovering: check `generation` is in flight. `rearm` says a refusal or
 *   another account's answer arrived since it started; `reruns` counts the
 *   checks run again in this recovery.
 *
 * Events: `refused` (a 401), `other` (an answer for another account),
 * `settled` (check `generation` finished: `outcome` is `answered` when the
 * session check answered, `failed` when it didn't).
 *
 * Effects: `forget` (the shell's forgetRefusedAccountData, which drops the
 * account's rows and Projects and leaves the Browse picker open to say why),
 * `check` (session check `generation`, then Projects for the same account),
 * `done` (the recovery ended with no check left to run; it carries the last
 * check's `generation` and `outcome`, and the Browse picker, if it waits on
 * it, learns who is signed in).
 */
import { defineMachine, reject } from "../shared/machine.mjs";

/** How many times one recovery runs its check again. */
export const RECOVERY_RERUNS = 2;

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const only = (value, keys) => {
  for (const key of Object.keys(value)) check(keys.includes(key), `unexpected field ${key}`);
};
const generation = (value) =>
  check(Number.isSafeInteger(value.generation) && value.generation >= 0, "generation is a count");
/** Session check outcomes: it answered, or it didn't (an outage, a 5xx). */
export const CHECK_OUTCOMES = Object.freeze(["answered", "failed"]);
const outcome = (value) =>
  check(CHECK_OUTCOMES.includes(value.outcome), "outcome is answered or failed");

export const recoverySpec = Object.freeze({
  name: "signed-out-recovery",
  states: ["idle", "recovering"],
  events: ["refused", "other", "settled"],
  cases: { "recovering/settled": ["done", "rerun", "spent", "stale"] },
  validate: {
    states: {
      idle: (value) => {
        only(value, ["name", "generation"]);
        generation(value);
      },
      recovering: (value) => {
        only(value, ["name", "rearm", "reruns", "generation"]);
        check(typeof value.rearm === "boolean", "rearm is a boolean");
        check(
          Number.isSafeInteger(value.reruns) &&
            value.reruns >= 0 &&
            value.reruns <= RECOVERY_RERUNS,
          "reruns is a count within the cap",
        );
        generation(value);
        check(value.generation > 0, "a check in flight has a generation");
      },
    },
    events: {
      refused: (value) => only(value, ["type"]),
      other: (value) => only(value, ["type"]),
      settled: (value) => {
        only(value, ["type", "generation", "outcome"]);
        generation(value);
        outcome(value);
      },
    },
    effects: {
      forget: (value) => only(value, ["type"]),
      check: (value) => {
        only(value, ["type", "generation"]);
        generation(value);
      },
      done: (value) => {
        only(value, ["type", "generation", "outcome"]);
        generation(value);
        outcome(value);
      },
    },
  },
});

export const REJECT = Object.freeze({
  idle: "No check is in flight",
  stale: "Not the check in flight",
});

/** Start check `generation + 1` with `rearm` cleared. */
const start = (current, reruns) => {
  const next = current.generation + 1;
  return {
    state: { name: "recovering", rearm: false, reruns, generation: next },
    effect: { type: "check", generation: next },
  };
};

function transition(current, input) {
  if (input.type === "refused") {
    if (current.name !== "idle")
      return { state: { ...current, rearm: true }, effects: [{ type: "forget" }] };
    const { state, effect } = start(current, 0);
    return { state, effects: [{ type: "forget" }, effect] };
  }
  if (input.type === "other") {
    if (current.name !== "idle") return { state: { ...current, rearm: true }, effects: [] };
    const { state, effect } = start(current, 0);
    return { state, effects: [effect] };
  }
  if (current.name === "idle") return reject(current, REJECT.idle);
  if (input.generation !== current.generation) return reject(current, REJECT.stale);
  if (current.rearm && current.reruns < RECOVERY_RERUNS) {
    const { state, effect } = start(current, current.reruns + 1);
    return { state, effects: [effect] };
  }
  return {
    state: { name: "idle", generation: current.generation },
    effects: [{ type: "done", generation: current.generation, outcome: input.outcome }],
  };
}

export const recoveryMachine = defineMachine({
  ...recoverySpec,
  initial: { name: "idle", generation: 0 },
  transition,
});

/**
 * Runs the machine. `forget()` clears the account's data; `check()` returns
 * a promise for the session check and the Projects request that follows it,
 * which rejects when the session check didn't answer; `done({ generation,
 * outcome })` runs when the recovery ends. `stop()` ends it: nothing runs
 * after, and a check in flight settles into nothing.
 */
export class SignedOutRecovery {
  #state = recoveryMachine.initial;
  #forget;
  #check;
  #done;
  #stopped = false;
  constructor({ forget, check, done = () => {} }) {
    this.#forget = forget;
    this.#check = check;
    this.#done = done;
  }
  get state() {
    return this.#state;
  }
  /** The generation of the check in flight, or of the last one. A check
   * that settles with a higher one started after this was read. */
  get generation() {
    return this.#state.generation;
  }
  refused() {
    this.#dispatch({ type: "refused" });
  }
  /** An answer named another account than the tab's. */
  otherAccount() {
    this.#dispatch({ type: "other" });
  }
  stop() {
    this.#stopped = true;
  }
  #dispatch(input) {
    if (this.#stopped) return;
    const result = recoveryMachine.step(this.#state, input);
    if (result.rejected) return;
    this.#state = result.state;
    for (const effect of result.effects) {
      if (effect.type === "forget") this.#forget();
      else if (effect.type === "done")
        this.#done({ generation: effect.generation, outcome: effect.outcome });
      else this.#run(effect.generation);
    }
  }
  #run(generation) {
    let pending;
    try {
      pending = Promise.resolve(this.#check());
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      () => this.#dispatch({ type: "settled", generation, outcome: "answered" }),
      () => this.#dispatch({ type: "settled", generation, outcome: "failed" }),
    );
  }
}
