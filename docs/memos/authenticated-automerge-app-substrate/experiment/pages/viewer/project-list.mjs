/**
 * The signed-in account's Projects (list_projects' first page), shared by the
 * shell: the library's Project filter and Project labels, the Browse picker,
 * Move to… and the first page of /projects all read one request. A request
 * made while another for the same account is in flight joins it.
 *
 * States:
 * - idle: nothing known.
 * - loading: the first request for `principal` is in flight under `key`.
 * - ready: `principal`'s Projects are in the store. `verified` says the
 *   answer named `principal`; an answer that named no account isn't.
 * - refreshing: a later request for `principal` is in flight under `key`;
 *   the Projects already listed stay, with their `verified`.
 *
 * Events:
 * - request: list `principal`'s Projects. One in flight for the same account
 *   answers it (rejected as joined) unless `fresh` asks for a new one, as
 *   after a create or move this tab made. Another account starts over.
 * - loaded / failed: the request for `key` settled; `loaded` says whether
 *   the answer was `verified`. A key that no longer matches belongs to a
 *   superseded request. A failed first request knows nothing; a failed
 *   refresh keeps what was listed only when it was verified.
 * - reset: another account signed in, or none did.
 *
 * Effects: `fetch` asks list_projects under `key`; `show` puts that answer's
 * Projects in the store for the state's account; `clear` empties the store.
 *
 * list_projects names the `principal` that answered. An answer for any other
 * account than the request's (another window signed in) settles as `failed`,
 * so it never shows as this account's Projects. An answer that names no
 * account (an older API, during a deploy) shows, as the library listing shows
 * such a page, but it is never authoritative past its own request: the next
 * request replaces it, and if that request fails the unverified Projects go
 * rather than stay. The listing cache (listing-cache.mjs) applies the same
 * rule by never storing a page that names no account.
 */
import { defineMachine, reject } from "../shared/machine.mjs";
import { Store } from "./store.mjs";
import { PROJECTS_PER_REQUEST } from "./listing.mjs";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const text = (value) => typeof value === "string" && value !== "";
const shape = (head, keys) => (value) => {
  for (const key of Object.keys(value))
    check(key === head || keys.includes(key), `unexpected field ${key}`);
  if (keys.includes("verified"))
    check(typeof value.verified === "boolean", "verified is a boolean");
  if (keys.includes("principal")) check(text(value.principal), "principal is required");
  if (keys.includes("key")) check(text(value.key), "key is required");
  if (keys.includes("fresh")) check(typeof value.fresh === "boolean", "fresh is a boolean");
};
const state = (...keys) => shape("name", keys);
const event = (...keys) => shape("type", keys);

export const projectListSpec = Object.freeze({
  name: "project-list",
  states: ["idle", "loading", "ready", "refreshing"],
  events: ["request", "loaded", "failed", "reset"],
  cases: {
    "loading/request": ["join", "fresh", "account"],
    "refreshing/request": ["join", "fresh", "account"],
    "ready/request": ["same", "account"],
    "loading/loaded": ["current", "stale"],
    "loading/failed": ["current", "stale"],
    "refreshing/loaded": ["current", "stale"],
    "refreshing/failed": ["kept", "dropped", "stale"],
  },
  validate: {
    states: {
      idle: state(),
      loading: state("principal", "key"),
      ready: state("principal", "verified"),
      refreshing: state("principal", "key", "verified"),
    },
    events: {
      request: event("principal", "key", "fresh"),
      loaded: event("key", "verified"),
      failed: event("key"),
      reset: event(),
    },
    effects: { fetch: event("key"), show: event("key"), clear: event() },
  },
});

export const REJECT = Object.freeze({
  joined: "A request for this account is already in flight",
  idle: "No request is in flight",
  stale: "A newer request superseded this one",
});

const inFlight = (current) => current.name === "loading" || current.name === "refreshing";

function transition(current, input) {
  if (input.type === "reset") return { state: { name: "idle" }, effects: [{ type: "clear" }] };
  if (input.type === "request") {
    const same = current.principal === input.principal;
    if (same && inFlight(current) && !input.fresh) return reject(current, REJECT.joined);
    if (same && current.name !== "idle") {
      const state =
        current.name === "loading"
          ? { name: "loading", principal: input.principal, key: input.key }
          : {
              name: "refreshing",
              principal: input.principal,
              key: input.key,
              verified: current.verified,
            };
      return { state, effects: [{ type: "fetch", key: input.key }] };
    }
    return {
      state: { name: "loading", principal: input.principal, key: input.key },
      effects: [
        ...(current.name === "idle" ? [] : [{ type: "clear" }]),
        { type: "fetch", key: input.key },
      ],
    };
  }
  if (!inFlight(current)) return reject(current, REJECT.idle);
  if (input.key !== current.key) return reject(current, REJECT.stale);
  if (input.type === "loaded")
    return {
      state: { name: "ready", principal: current.principal, verified: input.verified },
      effects: [{ type: "show", key: input.key }],
    };
  if (current.name === "refreshing" && current.verified)
    return { state: { name: "ready", principal: current.principal, verified: true }, effects: [] };
  return {
    state: { name: "idle" },
    effects: current.name === "refreshing" ? [{ type: "clear" }] : [],
  };
}

export const projectListMachine = defineMachine({
  ...projectListSpec,
  initial: { name: "idle" },
  transition,
});

const EMPTY = Object.freeze({ principal: null, projects: Object.freeze([]), ready: false });

/** Runs the machine against `call` (request.mjs `tool`). The store holds
 * `{ principal, projects, ready }`; `ready` is false until `principal`'s
 * first answer. */
export class ProjectList {
  store = new Store(EMPTY);
  #state = projectListMachine.initial;
  #call;
  #newKey;
  // The request the machine's state names: { key, promise }.
  #flight = null;
  #answer = null;
  constructor({ call, newKey = () => crypto.randomUUID() }) {
    this.#call = call;
    this.#newKey = newKey;
  }
  get state() {
    return this.#state;
  }
  /** `principal`'s list_projects answer: the request in flight for that
   * account, or a new one. `fresh` asks again even when one is in flight. */
  request(principal, { fresh = false } = {}) {
    if (!principal) return Promise.reject(new Error("Sign in to list Projects"));
    this.#dispatch({ type: "request", principal, key: this.#newKey(), fresh });
    return this.#flight.promise;
  }
  /** Forget the account's Projects: another account signed in, or none. */
  reset() {
    this.#dispatch({ type: "reset" });
  }
  #dispatch(input) {
    const result = projectListMachine.step(this.#state, input);
    if (result.rejected) return false;
    this.#state = result.state;
    for (const effect of result.effects) this.#run(effect);
    return true;
  }
  #run(effect) {
    switch (effect.type) {
      case "clear":
        this.#flight = null;
        this.store.update(() => EMPTY);
        return;
      case "show": {
        const projects = Array.isArray(this.#answer?.projects) ? this.#answer.projects : [];
        this.#answer = null;
        this.store.update(() => ({ principal: this.#state.principal, projects, ready: true }));
        return;
      }
      case "fetch": {
        const { key } = effect;
        let promise;
        try {
          promise = Promise.resolve(this.#call("list_projects", { limit: PROJECTS_PER_REQUEST }));
        } catch (error) {
          promise = Promise.reject(error);
        }
        this.#flight = { key, promise };
        promise.then(
          (answer) => {
            if (answer?.principal && answer.principal !== this.#state.principal) {
              this.#dispatch({ type: "failed", key });
              return;
            }
            this.#answer = answer;
            const verified = answer?.principal === this.#state.principal;
            if (!this.#dispatch({ type: "loaded", key, verified })) this.#answer = null;
          },
          () => this.#dispatch({ type: "failed", key }),
        );
        return;
      }
    }
    throw new Error(`unknown effect ${effect.type}`);
  }
}
