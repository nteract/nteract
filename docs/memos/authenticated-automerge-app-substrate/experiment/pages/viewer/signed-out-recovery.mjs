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
 * States:
 * - idle: no check in flight.
 * - recovering: a check is in flight. `rearm` says a refusal or another
 *   account's answer arrived since it started; `reruns` counts the checks run
 *   again in this recovery.
 *
 * Events: `refused` (a 401), `other` (an answer for another account),
 * `settled` (the check finished, either way).
 *
 * Effects: `forget` (the shell's forgetRefusedAccountData, which drops the
 * account's rows and Projects and leaves the Browse picker open to say why),
 * `check` (session check, then Projects for the same account), `done` (the
 * recovery ended with no check left to run; the Browse picker, if it waits on
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

export const recoverySpec = Object.freeze({
  name: "signed-out-recovery",
  states: ["idle", "recovering"],
  events: ["refused", "other", "settled"],
  cases: { "recovering/settled": ["done", "rerun", "spent"] },
  validate: {
    states: {
      idle: (value) => only(value, ["name"]),
      recovering: (value) => {
        only(value, ["name", "rearm", "reruns"]);
        check(typeof value.rearm === "boolean", "rearm is a boolean");
        check(
          Number.isSafeInteger(value.reruns) &&
            value.reruns >= 0 &&
            value.reruns <= RECOVERY_RERUNS,
          "reruns is a count within the cap",
        );
      },
    },
    events: {
      refused: (value) => only(value, ["type"]),
      other: (value) => only(value, ["type"]),
      settled: (value) => only(value, ["type"]),
    },
    effects: {
      forget: (value) => only(value, ["type"]),
      check: (value) => only(value, ["type"]),
      done: (value) => only(value, ["type"]),
    },
  },
});

export const REJECT = Object.freeze({ idle: "No check is in flight" });

function transition(current, input) {
  if (input.type === "refused")
    return current.name === "idle"
      ? {
          state: { name: "recovering", rearm: false, reruns: 0 },
          effects: [{ type: "forget" }, { type: "check" }],
        }
      : { state: { ...current, rearm: true }, effects: [{ type: "forget" }] };
  if (input.type === "other")
    return current.name === "idle"
      ? { state: { name: "recovering", rearm: false, reruns: 0 }, effects: [{ type: "check" }] }
      : { state: { ...current, rearm: true }, effects: [] };
  if (current.name === "idle") return reject(current, REJECT.idle);
  if (current.rearm && current.reruns < RECOVERY_RERUNS)
    return {
      state: { name: "recovering", rearm: false, reruns: current.reruns + 1 },
      effects: [{ type: "check" }],
    };
  return { state: { name: "idle" }, effects: [{ type: "done" }] };
}

export const recoveryMachine = defineMachine({
  ...recoverySpec,
  initial: { name: "idle" },
  transition,
});

/**
 * Runs the machine. `forget()` clears the account's data; `check()` returns
 * a promise for the session check and the Projects request that follows it;
 * `done()` runs when the recovery ends. `stop()` ends it: nothing runs after,
 * and a check in flight settles into nothing.
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
      else if (effect.type === "done") this.#done();
      else this.#run();
    }
  }
  #run() {
    let pending;
    try {
      pending = Promise.resolve(this.#check());
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.catch(() => {}).then(() => this.#dispatch({ type: "settled" }));
  }
}
