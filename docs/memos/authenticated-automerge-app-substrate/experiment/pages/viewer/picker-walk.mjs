/**
 * The Browse picker's lifecycle as a state machine, and the interpreter the
 * shell runs it with.
 *
 * The picker lists every Page the account can open by walking list_pages'
 * cursors (page-list.mjs listAllPages). A walk belongs to one opening for one
 * account: closing the picker, or the shell forgetting what it remembers for
 * the account (sign-out, account change, a tool call refused as signed out),
 * cancels the walk and drops its rows. Nothing but `open` ever starts a walk,
 * so a walk that fails, a 401 included, can't start another.
 *
 * States:
 * - closed: nothing shows and nothing is in flight.
 * - loading: open for `principal`; the walk is in flight under `key` and no
 *   rows show.
 * - refreshing: like loading, while the library's remembered first page
 *   (listing-cache.mjs, within its age limit) shows.
 * - ready: the walk's rows show.
 * - failed: the walk failed with `message`; no rows from the server show.
 *
 * Events:
 * - open: show the picker for `principal` (never null) and walk under `key`.
 *   `seeded` says the cache holds the library's first page for the account.
 * - loaded / failed: the walk under `key` settled. A key that no longer
 *   matches belongs to a walk this machine already cancelled.
 * - close: the person closed the picker, or the shell navigated.
 * - forget: the shell forgot the account's data.
 *
 * Effects: `fetch` walks under `key` for `principal`; `paint` shows the
 * remembered first page; `show` shows the settled walk's rows; `clear` drops
 * every row; `cancel` aborts the walk in flight; `report` hands a failure to
 * the picker's error line.
 */
import { defineMachine, reject } from "../shared/machine.mjs";
import { failureMessage } from "./alerts.mjs";
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
};
const state = (...keys) => shape("name", keys);
const event = (...keys) => shape("type", keys);

export const pickerWalkSpec = Object.freeze({
  name: "picker-walk",
  states: ["closed", "loading", "refreshing", "ready", "failed"],
  events: ["open", "loaded", "failed", "close", "forget"],
  cases: {
    "closed/open": ["fresh", "seeded"],
    "loading/loaded": ["current", "stale"],
    "loading/failed": ["current", "stale"],
    "refreshing/loaded": ["current", "stale"],
    "refreshing/failed": ["current", "stale"],
  },
  validate: {
    states: {
      closed: state(),
      loading: state("principal", "key"),
      refreshing: state("principal", "key"),
      ready: state("principal"),
      failed: state("principal", "message"),
    },
    events: {
      open: event("principal", "key", "seeded"),
      loaded: event("key"),
      failed: event("key", "message"),
      close: event(),
      forget: event(),
    },
    effects: {
      fetch: event("key", "principal"),
      paint: event("principal"),
      show: event("key"),
      clear: event(),
      cancel: event(),
      report: event("message"),
    },
  },
});

export const REJECT = Object.freeze({
  open: "The picker is already open",
  closed: "The picker is closed",
  idle: "No walk is in flight",
  stale: "A walk this picker cancelled",
});

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
  if (!walking(current)) return reject(current, REJECT.idle);
  if (input.key !== current.key) return reject(current, REJECT.stale);
  if (input.type === "loaded")
    return {
      state: { name: "ready", principal: current.principal },
      effects: [{ type: "show", key: input.key }],
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

/** What the picker says when a walk was answered for another account. */
export const OTHER_ACCOUNT_MESSAGE =
  "This tab's account changed in another window. Checking who is signed in…";

const CLOSED = Object.freeze({ state: pickerWalkMachine.initial, items: Object.freeze([]) });

/**
 * Runs the machine. The store holds `{ state, items }`.
 *
 * - walk({ principal, signal }): every Page as list_pages answers it,
 *   `{ pages, principal }`; it stops between pages once `signal` aborts.
 * - seed(principal): the library's remembered first page, or null.
 * - report(message): the picker's error line.
 * - onOtherAccount(): a walk was answered for another account; the shell
 *   rechecks the session.
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
  #newKey;
  #flight = null;
  #answer = null;
  constructor({
    walk,
    seed = () => null,
    report = () => {},
    onOtherAccount = () => {},
    newKey = () => crypto.randomUUID(),
  }) {
    this.#walk = walk;
    this.#seed = seed;
    this.#report = report;
    this.#onOtherAccount = onOtherAccount;
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
          this.#dispatch({ type: "failed", key, message: OTHER_ACCOUNT_MESSAGE });
          this.#onOtherAccount();
          return;
        }
        this.#answer = answer;
        if (!this.#dispatch({ type: "loaded", key })) this.#answer = null;
      },
      (error) => {
        if (signal.aborted) return;
        settled();
        this.#dispatch({ type: "failed", key, message: failureMessage(error) });
      },
    );
  }
}
