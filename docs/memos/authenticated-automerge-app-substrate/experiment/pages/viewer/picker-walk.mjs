/**
 * The Browse picker's lifecycle as a state machine, and the interpreter the
 * shell runs it with.
 *
 * The picker lists every Page the account can open by walking list_pages'
 * cursors (page-list.mjs listAllPages). A walk belongs to one opening for one
 * account: closing the picker, the shell forgetting what it remembers for the
 * account (sign-out, account change), or a tool call refused as signed out
 * cancels the walk and drops its rows. A refusal leaves the picker open with
 * a message while the session check decides who is signed in: the shell
 * closes it if the account changed or signed out, and otherwise it stays
 * open saying why its rows went. A walk answered for another account, or
 * whose pages named different accounts (page-list.mjs ACCOUNT_CHANGED), waits
 * on the same check in `checking`. Only a check that started after that
 * answer counts: once one settles with the picker's account still signed in,
 * the picker says to try again, and if it couldn't reach the server, it says
 * so. Nothing but `open` ever starts a walk, so a walk that fails, a 401
 * included, can't start another.
 *
 * States:
 * - closed: nothing shows and nothing is in flight.
 * - loading: open for `principal`; the walk is in flight under `key` and no
 *   rows show.
 * - refreshing: like loading, while the library's remembered first page
 *   (listing-cache.mjs, within its age limit) shows.
 * - ready: the walk's rows show.
 * - checking: the walk was answered for another account, or its pages named
 *   different accounts, and no session check that started after it has
 *   settled; no rows from the server show. `after` is the session check
 *   generation (signed-out-recovery.mjs) the shell had reached when the walk
 *   answered.
 * - failed: the walk failed, a tool call was refused as signed out, or a
 *   session check found the same account or couldn't answer, with `message`;
 *   no rows from the server show.
 *
 * Events:
 * - open: show the picker for `principal` (never null) and walk under `key`.
 *   `seeded` says the cache holds the library's first page for the account.
 * - loaded / failed / foreign: the walk under `key` settled, failed, or was
 *   answered for another account. A key that no longer matches belongs to a
 *   walk this machine already cancelled. `foreign` carries `after`.
 * - close: the person closed the picker, or the shell navigated.
 * - forget: the shell forgot the account's data.
 * - refused: a tool call was refused as signed out (request.mjs
 *   observeSignedOut). The rows go, and the picker says so.
 * - settled: session check `generation` finished with `principal` signed in
 *   and `outcome` `answered`, or couldn't answer (`failed`). A check no later
 *   than `after` started before the walk's answer: the picker asks again. Of
 *   a later one, the same account means the walk can be retried, another
 *   closes the picker, and a failure says the check couldn't be made.
 *
 * Effects: `fetch` walks under `key` for `principal`; `paint` shows the
 * remembered first page; `show` shows the settled walk's rows; `clear` drops
 * every row; `cancel` aborts the walk in flight; `report` hands a failure to
 * the picker's error line; `recheck` asks the shell to check the session.
 */
import { defineMachine, reject } from "../shared/machine.mjs";
import { failureMessage } from "./alerts.mjs";
import { ACCOUNT_CHANGED } from "./page-list.mjs";
import { CHECK_OUTCOMES } from "./signed-out-recovery.mjs";
import { Store } from "./store.mjs";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const text = (value) => typeof value === "string" && value !== "";
const shape = (head, keys) => (value) => {
  for (const key of Object.keys(value))
    check(key === head || keys.includes(key), `unexpected field ${key}`);
  if (keys.includes("principal")) check(text(value.principal), "principal is required");
  if (keys.includes("key")) check(text(value.key), "key is required");
  if (keys.includes("message")) check(typeof value.message === "string", "message is a string");
  if (keys.includes("seeded")) check(typeof value.seeded === "boolean", "seeded is a boolean");
  for (const count of ["after", "generation"])
    if (keys.includes(count))
      check(Number.isSafeInteger(value[count]) && value[count] >= 0, `${count} is a count`);
  if (keys.includes("outcome"))
    check(CHECK_OUTCOMES.includes(value.outcome), "outcome is answered or failed");
};
const state = (...keys) => shape("name", keys);
const event = (...keys) => shape("type", keys);

export const pickerWalkSpec = Object.freeze({
  name: "picker-walk",
  states: ["closed", "loading", "refreshing", "ready", "checking", "failed"],
  events: ["open", "loaded", "failed", "foreign", "close", "forget", "refused", "settled"],
  cases: {
    "closed/open": ["fresh", "seeded"],
    "loading/loaded": ["current", "stale"],
    "loading/failed": ["current", "stale"],
    "loading/foreign": ["current", "stale"],
    "refreshing/loaded": ["current", "stale"],
    "refreshing/failed": ["current", "stale"],
    "refreshing/foreign": ["current", "stale"],
    "checking/settled": ["same", "changed", "failed", "stale"],
  },
  validate: {
    states: {
      closed: state(),
      loading: state("principal", "key"),
      refreshing: state("principal", "key"),
      ready: state("principal"),
      checking: state("principal", "after"),
      failed: state("principal", "message"),
    },
    events: {
      open: event("principal", "key", "seeded"),
      loaded: event("key"),
      failed: event("key", "message"),
      foreign: event("key", "after"),
      close: event(),
      forget: event(),
      refused: event(),
      settled: event("principal", "outcome", "generation"),
    },
    effects: {
      fetch: event("key", "principal"),
      paint: event("principal"),
      show: event("key"),
      clear: event(),
      cancel: event(),
      report: event("message"),
      recheck: event(),
    },
  },
});

export const REJECT = Object.freeze({
  open: "The picker is already open",
  closed: "The picker is closed",
  idle: "No walk is in flight",
  stale: "A walk this picker cancelled",
  unchecked: "The picker isn't waiting on a session check",
});

/** What the picker says once a tool call was refused as signed out. The
 * shell closes it if the session check then finds another account or none. */
export const SIGNED_OUT_MESSAGE =
  "The server asked this tab to sign in again, so this list was cleared. Close Pages and open it again to retry.";

/** What the picker says when a walk was answered for another account, while
 * the session check runs. */
export const OTHER_ACCOUNT_MESSAGE =
  "This tab's account changed in another window. Checking who is signed in…";

/** What the picker says once that check found the same account. */
export const SAME_ACCOUNT_MESSAGE =
  "This tab is still signed in to the same account. Close Pages and open it again to retry.";

/** What the picker says when that check couldn't reach the server, or the
 * server failed: who is signed in is still unknown. */
export const CHECK_FAILED_MESSAGE =
  "Couldn't check who is signed in. Close Pages and open it again to retry.";

const walking = (current) => current.name === "loading" || current.name === "refreshing";
const CLOSE = Object.freeze([{ type: "cancel" }, { type: "clear" }]);

function transition(current, input) {
  if (input.type === "open") {
    if (current.name !== "closed") return reject(current, REJECT.open);
    const { principal, key } = input;
    return input.seeded
      ? {
          state: { name: "refreshing", principal, key },
          effects: [
            { type: "paint", principal },
            { type: "fetch", key, principal },
          ],
        }
      : {
          state: { name: "loading", principal, key },
          effects: [{ type: "fetch", key, principal }],
        };
  }
  if (input.type === "close" || input.type === "forget") {
    if (current.name === "closed") return reject(current, REJECT.closed);
    return { state: { name: "closed" }, effects: [...CLOSE] };
  }
  if (input.type === "refused") {
    if (current.name === "closed") return reject(current, REJECT.closed);
    return {
      state: { name: "failed", principal: current.principal, message: SIGNED_OUT_MESSAGE },
      effects: [...CLOSE, { type: "report", message: SIGNED_OUT_MESSAGE }],
    };
  }
  if (input.type === "settled") {
    if (current.name !== "checking") return reject(current, REJECT.unchecked);
    // A check that started before the walk's answer says nothing about it.
    // The recovery that ran it is idle now, so asking again starts a check.
    if (input.generation <= current.after)
      return { state: current, effects: [{ type: "recheck" }] };
    if (input.outcome === "failed")
      return {
        state: { name: "failed", principal: current.principal, message: CHECK_FAILED_MESSAGE },
        effects: [{ type: "report", message: CHECK_FAILED_MESSAGE }],
      };
    if (input.principal !== current.principal)
      return { state: { name: "closed" }, effects: [...CLOSE] };
    return {
      state: { name: "failed", principal: current.principal, message: SAME_ACCOUNT_MESSAGE },
      effects: [{ type: "report", message: SAME_ACCOUNT_MESSAGE }],
    };
  }
  if (!walking(current)) return reject(current, REJECT.idle);
  if (input.key !== current.key) return reject(current, REJECT.stale);
  if (input.type === "loaded")
    return {
      state: { name: "ready", principal: current.principal },
      effects: [{ type: "show", key: input.key }],
    };
  if (input.type === "foreign")
    return {
      state: { name: "checking", principal: current.principal, after: input.after },
      effects: [
        { type: "clear" },
        { type: "report", message: OTHER_ACCOUNT_MESSAGE },
        { type: "recheck" },
      ],
    };
  return {
    state: { name: "failed", principal: current.principal, message: input.message },
    effects: [{ type: "clear" }, { type: "report", message: input.message }],
  };
}

export const pickerWalkMachine = defineMachine({
  ...pickerWalkSpec,
  initial: { name: "closed" },
  transition,
});

const CLOSED = Object.freeze({ state: pickerWalkMachine.initial, items: Object.freeze([]) });

/**
 * Runs the machine. The store holds `{ state, items }`.
 *
 * - walk({ principal, signal }): every Page as list_pages answers it,
 *   `{ pages, principal }`; it stops between pages once `signal` aborts.
 * - seed(principal): the library's remembered first page, or null.
 * - report(message): the picker's error line.
 * - onOtherAccount(): a walk was answered for another account, or its pages
 *   named different accounts (page-list.mjs ACCOUNT_CHANGED); the shell
 *   rechecks the session, and calls settled() once that check is done.
 * - generation(): the session check generation the shell has reached
 *   (SignedOutRecovery's `generation`), read when the walk answers.
 *
 * A walk's answer shows only when it names the picker's account, or names no
 * account (an older API): the same rule as the library listing, which shows
 * such a page but never remembers it. The picker remembers nothing.
 */
export class PickerWalk {
  store = new Store(CLOSED);
  #walk;
  #seed;
  #report;
  #onOtherAccount;
  #generation;
  #newKey;
  #flight = null;
  #answer = null;
  constructor({
    walk,
    seed = () => null,
    report = () => {},
    onOtherAccount = () => {},
    generation = () => 0,
    newKey = () => crypto.randomUUID(),
  }) {
    this.#walk = walk;
    this.#seed = seed;
    this.#report = report;
    this.#onOtherAccount = onOtherAccount;
    this.#generation = generation;
    this.#newKey = newKey;
  }
  get state() {
    return this.store.snapshot().state;
  }
  /** Show the picker for `principal` and walk. No account, no walk. */
  open(principal) {
    if (!text(principal)) return false;
    const seeded = (this.#seed(principal)?.length ?? 0) > 0;
    return this.#dispatch({ type: "open", principal, key: this.#newKey(), seeded });
  }
  close() {
    return this.#dispatch({ type: "close" });
  }
  forget() {
    return this.#dispatch({ type: "forget" });
  }
  /** A tool call was refused as signed out: drop the rows, stay open. */
  refused() {
    return this.#dispatch({ type: "refused" });
  }
  /** Session check `generation` finished with `outcome` (`answered` or
   * `failed`) and `principal` signed in. A picker waiting on a check that
   * started after its walk's answer says to try again, says the check
   * failed, or closes if the account changed. A check that started before
   * the walk's answer makes it ask again. */
  settled({ principal, outcome, generation }) {
    if (!text(principal)) return false;
    return this.#dispatch({ type: "settled", principal, outcome, generation });
  }
  #dispatch(input) {
    const result = pickerWalkMachine.step(this.state, input);
    if (result.rejected) return false;
    this.store.update((current) => ({ ...current, state: result.state }));
    for (const effect of result.effects) this.#run(effect);
    return true;
  }
  #run(effect) {
    switch (effect.type) {
      case "fetch":
        return this.#start(effect);
      case "paint": {
        const items = this.#seed(effect.principal) ?? [];
        this.store.update((current) => ({ ...current, items }));
        return;
      }
      case "show": {
        const items = Array.isArray(this.#answer?.pages) ? this.#answer.pages : [];
        this.#answer = null;
        this.store.update((current) => ({ ...current, items }));
        return;
      }
      case "clear":
        this.store.update((current) => ({ ...current, items: CLOSED.items }));
        return;
      case "cancel":
        this.#flight?.controller.abort();
        this.#flight = null;
        return;
      case "report":
        return this.#report(effect.message);
      case "recheck":
        return this.#onOtherAccount();
    }
    throw new Error(`unknown effect ${effect.type}`);
  }
  #start({ key, principal }) {
    const controller = new AbortController();
    this.#flight = { key, controller };
    const { signal } = controller;
    let pending;
    try {
      pending = Promise.resolve(this.#walk({ principal, signal }));
    } catch (error) {
      pending = Promise.reject(error);
    }
    const settled = () => {
      if (this.#flight?.key === key) this.#flight = null;
    };
    pending.then(
      (answer) => {
        if (signal.aborted) return;
        settled();
        if (answer?.principal && answer.principal !== principal) {
          this.#dispatch({ type: "foreign", key, after: this.#generation() });
          return;
        }
        this.#answer = answer;
        if (!this.#dispatch({ type: "loaded", key })) this.#answer = null;
      },
      (error) => {
        if (signal.aborted) return;
        settled();
        if (error?.code === ACCOUNT_CHANGED) {
          this.#dispatch({ type: "foreign", key, after: this.#generation() });
          return;
        }
        this.#dispatch({ type: "failed", key, message: failureMessage(error) });
      },
    );
  }
}
