// What a link to another Page or to a Project shows this tab's reader, read
// with this tab's own session (worker/link-previews.mjs):
//
// - a Page: its title, state and edit time (`/p/<id>/meta.json`) and its
//   first-screen card (`/p/<id>/card.json`);
// - a Project: its title, description and role
//   (`/project/<id>/meta.json`) and its content document's first-screen
//   card (`/project/<id>/card.json`).
//
// Nothing about the target is stored with the link; every reader resolves
// it for themselves, when they look.
//
// One PageRefs per tab, in memory only (never IndexedDB). A target is `{
// kind, id }`, kind "page" or "project" (pageTarget, projectTarget); each
// target has a ref per file ("meta", "card") for the signed-in account,
// keyed by kind, id and file (refKey), so a Page and a Project never share
// a ref. Each ref follows the page-ref machine below: idle → requested →
// readable, unavailable or failed; a readable answer goes stale after
// PAGE_REF_TTL_MS and an unavailable one sooner, after
// PAGE_REF_UNAVAILABLE_TTL_MS, and a failure may be asked again after a
// backoff. Concurrent asks share one request, and at most
// PAGE_REF_CONCURRENCY requests run at once, of both kinds (the
// page-ref-pool machine). Another account or sign-out drops every ref,
// aborts the requests in flight and cancels the timers, as the library's
// listing cache forgets an account (main.jsx forgetAccountData).
//
// A refusal (a ref request's own 401, or a tool call's that the shell
// handles, main.jsx forgetRefusedAccountData) drops every ref the same way
// and holds the tab (the page-ref-access machine): `want` asks nothing,
// whoever calls it, until a session answer names who is signed in
// (`session`, from main.jsx onSession). The same account releases the hold;
// another account, or none, clears to it as `account` does. A release that
// is followed by another refusal with no ref answered in between waits
// before the next release, on the ref backoff (2 s doubling to 60 s). So
// while the ref routes keep answering 401 and the session keeps answering
// "signed in", each release sends at most PAGE_REF_CONCURRENCY (6)
// requests, and each release after the first waits 2, 4, 8, 16, 32 and
// then 60 s past the session answer that follows the refusal before it: at
// most 36 requests over the first six releases (62 s), then at most 6 a
// minute.
//
// Refs load on intent: `want(target, files)`. The hover card asks, urgent,
// (PageLinkCard.jsx) when a reader points at or focuses a link. Chits and
// labeled Page and Project links ask for meta, not urgent, when an editor
// draws them (page-chits.mjs), so an intent the reader has now goes out
// before theirs: N distinct targets cost N asks. A drawn chit asks again
// whenever its answer goes stale. A labeled link asks by the cause of each
// pass (page-chits.mjs labeledLinkAsks): after the first draw, only a stale
// unavailable answer while the tab is visible, every 15 s (a failed recheck
// of one on its backoff, at most a minute apart); a stale answer
// of any kind when the reader comes back to the tab; and through the card
// on a hover. A hidden tab asks for labeled links only when an editor draws.
import { timer } from "rxjs";
import { defineMachine, reject } from "../shared/machine.mjs";
import { getJson } from "./request.mjs";
import { Store } from "./store.mjs";

/** How long a readable answer is fresh. */
export const PAGE_REF_TTL_MS = 60_000;
/** How long an unavailable answer is fresh. Shorter: the routes' one 404
 * also stands for a host that didn't answer in time, which a reader should
 * see recover soon. */
export const PAGE_REF_UNAVAILABLE_TTL_MS = 15_000;
/** The first wait before a failed ref may ask again; it doubles per failure. */
export const PAGE_REF_BACKOFF_MS = 2_000;
/** The longest wait before a failed ref may ask again. */
export const PAGE_REF_BACKOFF_MAX_MS = 60_000;
/** Requests this tab runs at once. */
export const PAGE_REF_CONCURRENCY = 6;
/** What a ref is for: a Page or a Project. */
export const PAGE_REF_TARGETS = Object.freeze(["page", "project"]);

/** A Page target. */
export const pageTarget = (id) => ({ kind: "page", id });
/** A Project target. */
export const projectTarget = (id) => ({ kind: "project", id });

/** The wait before a ref that has failed `attempts` times asks again. */
export const backoffMs = (attempts) =>
  Math.min(PAGE_REF_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), PAGE_REF_BACKOFF_MAX_MS);

const settledLast = (last) => {
  if (last === null) return;
  if (last?.name === "readable" && last.value && typeof last.value === "object") return;
  if (last?.name === "unavailable") return;
  throw Error("last must be null, readable with a value, or unavailable");
};
const attemptsOf = (state) => {
  if (!Number.isInteger(state.attempts) || state.attempts < 0)
    throw Error("attempts must be a count");
};

/**
 * One linked Page's or Project's answer of one file, for this tab's account.
 *
 * States:
 * - idle: never asked.
 * - requested: a request is queued or running. `last` is the settled answer
 *   it refreshes (readable or unavailable) or null, so a reader keeps seeing
 *   the old title while a stale one is asked again; `attempts` counts the
 *   failures before it.
 * - readable: `value` is the answer; `stale` once PAGE_REF_TTL_MS passed.
 * - unavailable: the routes' one 404, which says nothing about why: the
 *   reader can't open the Page, or its host didn't answer. `stale` once
 *   PAGE_REF_UNAVAILABLE_TTL_MS passed.
 * - failed: the request failed; `attempts` failures in a row. `ready` once
 *   the backoff passed, so the next ask goes out. `last` as in requested.
 *
 * Events: `wanted` (someone wants the answer), `answered` (`value`),
 * `refused` (404), `failed`, `expired` (the TTL timer), `retry` (the backoff
 * timer).
 *
 * Effects: `fetch`, `expire` (arm the TTL timer, `ms`) and `backoff` (arm the
 * retry timer, `ms`).
 */
export const pageRefMachine = defineMachine({
  name: "page-ref",
  states: ["idle", "requested", "readable", "unavailable", "failed"],
  events: ["wanted", "answered", "refused", "failed", "expired", "retry"],
  initial: { name: "idle" },
  unreachable: [
    ["idle", "answered", "an idle ref has no request"],
    ["idle", "refused", "an idle ref has no request"],
    ["idle", "failed", "an idle ref has no request"],
    ["idle", "expired", "an idle ref has no timer"],
    ["idle", "retry", "an idle ref has no timer"],
    ["requested", "expired", "a ref asks again only after its TTL timer fired"],
    ["requested", "retry", "a ref asks again only after its backoff timer fired"],
    ["readable", "answered", "a settled ref has no request"],
    ["readable", "refused", "a settled ref has no request"],
    ["readable", "failed", "a settled ref has no request"],
    ["readable", "retry", "only a failed ref backs off"],
    ["unavailable", "answered", "a settled ref has no request"],
    ["unavailable", "refused", "a settled ref has no request"],
    ["unavailable", "failed", "a settled ref has no request"],
    ["unavailable", "retry", "only a failed ref backs off"],
    ["failed", "answered", "a failed ref has no request"],
    ["failed", "refused", "a failed ref has no request"],
    ["failed", "failed", "a failed ref has no request"],
    ["failed", "expired", "a failed ref has no TTL timer"],
  ],
  cases: {
    "readable/wanted": ["fresh", "stale"],
    "unavailable/wanted": ["fresh", "stale"],
    "readable/expired": ["fresh", "stale"],
    "unavailable/expired": ["fresh", "stale"],
    "failed/wanted": ["backing-off", "ready"],
    "failed/retry": ["backing-off", "ready"],
  },
  validate: {
    states: {
      requested: (state) => {
        settledLast(state.last);
        attemptsOf(state);
      },
      readable: (state) => {
        if (!state.value || typeof state.value !== "object") throw Error("readable needs a value");
        if (typeof state.stale !== "boolean") throw Error("stale must be a boolean");
      },
      unavailable: (state) => {
        if (typeof state.stale !== "boolean") throw Error("stale must be a boolean");
      },
      failed: (state) => {
        settledLast(state.last);
        attemptsOf(state);
        if (state.attempts < 1) throw Error("a failed ref failed at least once");
        if (typeof state.ready !== "boolean") throw Error("ready must be a boolean");
      },
    },
    events: {
      answered: (event) => {
        if (!event.value || typeof event.value !== "object") throw Error("answered needs a value");
      },
    },
    effects: {
      fetch: () => {},
      expire: (effect) => {
        if (!(effect.ms > 0)) throw Error("expire needs ms");
      },
      backoff: (effect) => {
        if (!(effect.ms > 0)) throw Error("backoff needs ms");
      },
    },
  },
  transition(state, event) {
    switch (event.type) {
      case "wanted": {
        if (state.name === "idle")
          return {
            state: { name: "requested", last: null, attempts: 0 },
            effects: [{ type: "fetch" }],
          };
        if (state.name === "requested") return reject(state, "already requested");
        if (state.name === "failed") {
          if (!state.ready) return reject(state, "backing off");
          return {
            state: { name: "requested", last: state.last, attempts: state.attempts },
            effects: [{ type: "fetch" }],
          };
        }
        // readable or unavailable
        if (!state.stale) return reject(state, "fresh");
        const last =
          state.name === "readable"
            ? { name: "readable", value: state.value }
            : { name: "unavailable" };
        return {
          state: { name: "requested", last, attempts: 0 },
          effects: [{ type: "fetch" }],
        };
      }
      case "answered":
        // requested only (see unreachable).
        return {
          state: { name: "readable", value: event.value, stale: false },
          effects: [{ type: "expire", ms: PAGE_REF_TTL_MS }],
        };
      case "refused":
        return {
          state: { name: "unavailable", stale: false },
          effects: [{ type: "expire", ms: PAGE_REF_UNAVAILABLE_TTL_MS }],
        };
      case "failed": {
        const attempts = state.attempts + 1;
        return {
          state: { name: "failed", last: state.last, attempts, ready: false },
          effects: [{ type: "backoff", ms: backoffMs(attempts) }],
        };
      }
      case "expired":
        // readable or unavailable only (see unreachable).
        if (state.stale) return reject(state, "already stale");
        return { state: { ...state, stale: true }, effects: [] };
      case "retry":
        // failed only (see unreachable).
        if (state.ready) return reject(state, "already ready");
        return { state: { ...state, ready: true }, effects: [] };
    }
  },
});

export const IDLE_REF = pageRefMachine.initial;

const poolCounts = (state) => {
  for (const key of ["waiting", "busy", "slots"])
    if (!Number.isInteger(state[key]) || state[key] < 0) throw Error(`${key} must be a count`);
  if (state.slots < 1) throw Error("slots must be positive");
  if (state.busy > state.slots) throw Error("busy can't pass slots");
};

/** The pool's state name for its counts. */
const poolNamed = (counts) => ({
  ...counts,
  name: counts.waiting > 0 ? "full" : counts.busy > 0 ? "busy" : "quiet",
});

/**
 * When refs' requests go out: at most `slots` at once.
 *
 * States carry `waiting` (requests queued), `busy` (running) and `slots`.
 * - quiet: nothing runs or waits.
 * - busy: requests run and a slot may be free; nothing waits.
 * - full: every slot is busy and requests wait.
 *
 * Events: `queued` (a ref asked), `settled` (a request ended, however).
 * Effects: `send`, which starts the next waiting request. Which one is the
 * loader's queue: an urgent ask goes first.
 */
export const pageRefPoolMachine = defineMachine({
  name: "page-ref-pool",
  states: ["quiet", "busy", "full"],
  events: ["queued", "settled"],
  initial: { name: "quiet", waiting: 0, busy: 0, slots: PAGE_REF_CONCURRENCY },
  cases: { "busy/queued": ["sent", "waits"], "full/settled": ["sent", "sent-drained"] },
  validate: {
    states: {
      quiet: (state) => {
        poolCounts(state);
        if (state.waiting || state.busy) throw Error("quiet has nothing running or waiting");
      },
      busy: (state) => {
        poolCounts(state);
        if (state.waiting) throw Error("busy has nothing waiting");
        if (!state.busy) throw Error("busy runs a request");
      },
      full: (state) => {
        poolCounts(state);
        if (!state.waiting) throw Error("full has a request waiting");
        if (state.busy !== state.slots) throw Error("full has every slot busy");
      },
    },
    effects: { send: () => {} },
  },
  transition(state, event) {
    const { waiting, busy, slots } = state;
    switch (event.type) {
      case "queued":
        if (busy < slots)
          return {
            state: poolNamed({ waiting, busy: busy + 1, slots }),
            effects: [{ type: "send" }],
          };
        return { state: poolNamed({ waiting: waiting + 1, busy, slots }), effects: [] };
      case "settled":
        if (busy === 0) return reject(state, "no request is running");
        if (waiting > 0)
          return {
            state: poolNamed({ waiting: waiting - 1, busy, slots }),
            effects: [{ type: "send" }],
          };
        return { state: poolNamed({ waiting, busy: busy - 1, slots }), effects: [] };
    }
  },
});

const strikesOf = (state, least) => {
  if (!Number.isInteger(state.strikes) || state.strikes < least)
    throw Error(`strikes must be a count of at least ${least}`);
};

/**
 * Whether this tab may ask for refs.
 *
 * States carry `strikes`: refusals since a ref was last answered (readable
 * or the routes' 404; either way the server knew the session).
 * - open: `want` asks.
 * - held: a refusal dropped every ref; `want` asks nothing until a session
 *   answer names the same account.
 * - cooling: the session named the same account after a refusal that
 *   followed a release with no answer between; the release waits for the
 *   cool timer.
 *
 * Events: `refused` (a 401, the refs' own or the shell's), `confirmed` (a
 * session answer named the tab's account), `cooled` (the cool timer),
 * `answered` (a ref request was answered). A session answer naming another
 * account, or none, isn't an event: PageRefs clears to that account and
 * starts this machine over.
 *
 * Effects: `drop` (abort the requests in flight, cancel the ref timers and
 * empty the refs), `wait` (arm the cool timer, `ms`) and `cancel` (clear
 * it). A release is the move to open itself: the store change is what
 * drawn links react to.
 */
export const pageRefAccessMachine = defineMachine({
  name: "page-ref-access",
  states: ["open", "held", "cooling"],
  events: ["refused", "confirmed", "cooled", "answered"],
  initial: { name: "open", strikes: 0 },
  unreachable: [
    ["open", "cooled", "the cool timer runs only while cooling"],
    ["held", "cooled", "a refusal while cooling cancels the cool timer"],
    ["held", "answered", "a hold aborts every request, and want asks nothing while held"],
    ["cooling", "answered", "cooling follows a hold, and want asks nothing while cooling"],
  ],
  cases: {
    "open/answered": ["forgiven", "clean"],
    "held/confirmed": ["first", "repeat"],
  },
  validate: {
    states: {
      open: (state) => strikesOf(state, 0),
      held: (state) => strikesOf(state, 1),
      cooling: (state) => strikesOf(state, 2),
    },
    effects: {
      drop: () => {},
      wait: (effect) => {
        if (!(effect.ms > 0)) throw Error("wait needs ms");
      },
      cancel: () => {},
    },
  },
  transition(state, event) {
    switch (event.type) {
      case "refused":
        if (state.name === "held") return reject(state, "already held");
        if (state.name === "cooling")
          return { state: { name: "held", strikes: state.strikes }, effects: [{ type: "cancel" }] };
        return {
          state: { name: "held", strikes: state.strikes + 1 },
          effects: [{ type: "drop" }],
        };
      case "confirmed":
        if (state.name === "open") return reject(state, "not held");
        if (state.name === "cooling") return reject(state, "already cooling");
        if (state.strikes === 1) return { state: { name: "open", strikes: 1 }, effects: [] };
        return {
          state: { name: "cooling", strikes: state.strikes },
          effects: [{ type: "wait", ms: backoffMs(state.strikes - 1) }],
        };
      case "cooled":
        // cooling only (see unreachable).
        return { state: { name: "open", strikes: state.strikes }, effects: [] };
      case "answered":
        // open only (see unreachable).
        if (state.strikes === 0) return reject(state, "no strikes");
        return { state: { name: "open", strikes: 0 }, effects: [] };
    }
  },
});

/** Whether a PageRefs store state lets `want` ask: the access is open. */
export const asking = (state) => state.access.name === "open";

/** A ref's key in the store: the target's kind and id, and the file. */
export const refKey = (target, file) => `${target.kind}:${target.id}:${file}`;

/** The path of `target`'s `file` route. */
export function refPath(target, file) {
  const prefix = target.kind === "project" ? "project" : "p";
  return `/${prefix}/${encodeURIComponent(target.id)}/${file}.json`;
}

/** A Page meta.json answer's fields, or null when it isn't one for `pageId`. */
export function readMeta(body, pageId) {
  if (body?.v !== 1 || body.page_id !== pageId || typeof body.title !== "string") return null;
  if (!["active", "trashed"].includes(body.state)) return null;
  return {
    title: body.title,
    state: body.state,
    role: typeof body.role === "string" ? body.role : null,
    content_updated_at:
      typeof body.content_updated_at === "string" ? body.content_updated_at : null,
  };
}

/** A Project meta.json answer's fields, or null when it isn't one for
 * `projectId`. */
export function readProjectMeta(body, projectId) {
  if (body?.v !== 1 || body.kind !== "project" || body.project_id !== projectId) return null;
  if (typeof body.title !== "string") return null;
  return {
    title: body.title,
    description: typeof body.description === "string" ? body.description : "",
    role: typeof body.role === "string" ? body.role : null,
  };
}

/** A card.json answer's card (null when there's none yet), or undefined
 * when it isn't one for `target`. A Page's answer names `page_id`, a
 * Project's `project_id`. A bare ID is a Page. */
export function readCard(body, target) {
  const { kind, id } = typeof target === "string" ? pageTarget(target) : target;
  const named = kind === "project" ? body?.project_id : body?.page_id;
  if (body?.v !== 1 || named !== id || !("card" in body)) return undefined;
  const card = body.card;
  return card && typeof card === "object" && Array.isArray(card.blocks) ? card : null;
}

/** The refusal code of `kind`'s routes. */
const REFUSED = { page: "page_unavailable", project: "project_unavailable" };

/** What a ref shows now: its settled answer, or the one it refreshes. */
export function settledOf(ref) {
  if (ref.name === "readable" || ref.name === "unavailable") return ref;
  return ref.last ?? null;
}

/**
 * The refs of one tab.
 *
 * - `get(path, { signal })` reads a JSON route; it rejects with the
 *   server's `status` and `code` (request.mjs getJson, which also reports a
 *   401 as signed out).
 * - `scheduler` runs the TTL and backoff timers; tests pass a virtual one.
 *
 * The store holds `{ principal, refs, access }`: the account, a Map of ref
 * states by refKey, and the page-ref-access state (`asking` reads it). React
 * reads it with useStore.
 */
export class PageRefs {
  #pool = pageRefPoolMachine.initial;
  /** Keys whose request waits for a slot, in the order they go out. */
  #queue = [];
  #abort = new AbortController();
  /** The running TTL or backoff timer of each key. */
  #timers = new Map();
  /** The cool timer, while the access is cooling. */
  #cooling = null;
  constructor({ get = getJson, scheduler, concurrency = PAGE_REF_CONCURRENCY } = {}) {
    this.get = get;
    this.scheduler = scheduler;
    this.concurrency = concurrency;
    this.#pool = { ...pageRefPoolMachine.initial, slots: concurrency };
    this.store = new Store({
      principal: null,
      refs: new Map(),
      access: pageRefAccessMachine.initial,
    });
  }

  /** The signed-in account, or null. */
  get principal() {
    return this.store.snapshot().principal;
  }

  /** The account this tab is signed in as now, or null. Another account
   * drops every ref and starts the access over. */
  account(principal) {
    if ((principal ?? null) === this.principal) return;
    this.clear(principal ?? null);
  }

  /** A session answer named `principal` (null: signed out). The tab's own
   * account releases a hold, at once or after the cool timer; another
   * account, or none, clears to it as `account` does. */
  session(principal) {
    if ((principal ?? null) !== this.principal) return this.account(principal);
    this.#access({ type: "confirmed" });
  }

  /** The server refused this tab's session (a 401): drop every ref and ask
   * nothing until a session answer (`session`). */
  refused() {
    this.#access({ type: "refused" });
  }

  /** Drop every ref: abort the requests in flight, cancel the timers and
   * empty the queue. The account and its access stay unless `principal`
   * names another, which starts the access over. */
  clear(principal = this.principal) {
    const restart = principal !== this.principal;
    if (restart) this.#cool(null);
    this.#drop();
    this.store.update((state) => ({
      principal,
      refs: new Map(),
      access: restart ? pageRefAccessMachine.initial : state.access,
    }));
  }

  /** The ref for `target`'s `file`. */
  ref(target, file) {
    return this.store.snapshot().refs.get(refKey(target, file)) ?? IDLE_REF;
  }

  /** Ask for `target`'s `files`. An ask already running, or a fresh answer,
   * asks nothing, and so does every ask while the access is held or
   * cooling; an `urgent` ask goes before the ones already waiting. */
  want(target, files = ["meta"], { urgent = false } = {}) {
    const state = this.store.snapshot();
    if (!state.principal || !asking(state) || !PAGE_REF_TARGETS.includes(target?.kind)) return;
    if (typeof target.id !== "string" || !target.id) return;
    const results = this.#steps(files.map((file) => [refKey(target, file), { type: "wanted" }]));
    const fetches = files.filter((_, index) => results[index].effects.length > 0);
    const keys = fetches.map((file) => ({ key: refKey(target, file), target, file }));
    if (urgent) this.#queue.unshift(...keys);
    else this.#queue.push(...keys);
    for (let index = 0; index < keys.length; index++) this.#dispatch({ type: "queued" });
  }

  /** Stop the timers, for tests and teardown. */
  dispose() {
    this.#cool(null);
    this.clear();
  }

  /** Step the access machine and run its effects. A drop and the new access
   * land in one store update, so no subscriber sees the refs empty while
   * the access is still open. */
  #access(event) {
    const result = pageRefAccessMachine.step(this.store.snapshot().access, event);
    if (result.rejected) return;
    let dropped = false;
    for (const effect of result.effects)
      if (effect.type === "drop") {
        this.#drop();
        dropped = true;
      } else if (effect.type === "wait") this.#cool(effect.ms);
      else this.#cool(null);
    this.store.update((state) => ({
      ...state,
      refs: dropped ? new Map() : state.refs,
      access: result.state,
    }));
  }

  /** Abort the requests in flight, cancel the ref timers and empty the
   * queue and pool. The caller empties the refs in its store update. */
  #drop() {
    this.#abort.abort();
    this.#abort = new AbortController();
    for (const subscription of this.#timers.values()) subscription.unsubscribe();
    this.#timers.clear();
    this.#queue = [];
    this.#pool = { ...pageRefPoolMachine.initial, slots: this.concurrency };
  }

  /** Arm the cool timer for `ms`, replacing the last one, or cancel it with
   * null. */
  #cool(ms) {
    this.#cooling?.unsubscribe();
    this.#cooling = null;
    if (ms === null) return;
    const subscription = timer(ms, this.scheduler).subscribe(() => {
      this.#cooling = null;
      this.#access({ type: "cooled" });
    });
    if (!subscription.closed) this.#cooling = subscription;
  }

  /** Step the pool and start the requests it sends. */
  #dispatch(event) {
    const result = pageRefPoolMachine.step(this.#pool, event);
    this.#pool = result.state;
    for (const effect of result.effects) if (effect.type === "send") this.#send();
  }

  #send() {
    const next = this.#queue.shift();
    if (!next) return;
    const signal = this.#abort.signal;
    this.#fetch(next, signal).finally(() => {
      if (!signal.aborted) this.#dispatch({ type: "settled" });
    });
  }

  async #fetch({ key, target, file }, signal) {
    let event;
    try {
      const body = await this.get(refPath(target, file), { signal });
      if (signal.aborted) return;
      const meta = target.kind === "project" ? readProjectMeta : readMeta;
      const value = file === "meta" ? meta(body, target.id) : readCard(body, target);
      if (file === "meta" ? value === null : value === undefined) event = { type: "failed" };
      else event = { type: "answered", value: file === "meta" ? value : { card: value } };
    } catch (error) {
      if (signal.aborted) return;
      // getJson reports a 401 to the shell before it rejects, and the shell's
      // refusal holds the access and aborts this request (returned above).
      // Without that shell, this refusal holds it. Either way nothing
      // resolved under this session is kept, and nothing is asked until a
      // session answer.
      if (error?.status === 401) return this.refused();
      // Only the kind's own refusal is unavailable; another 404 (a proxy, a
      // missing route, the other kind's refusal) is a failure.
      event =
        error?.status === 404 && error?.code === REFUSED[target.kind]
          ? { type: "refused" }
          : { type: "failed" };
    }
    // A readable answer or the routes' 404: the server knew the session.
    if (event.type !== "failed") this.#access({ type: "answered" });
    this.#steps([[key, event]]);
  }

  /** Apply events to refs in one store update and run their timer effects;
   * returns each step's result. */
  #steps(pairs) {
    const current = this.store.snapshot();
    const refs = new Map(current.refs);
    const results = pairs.map(([key, event]) => {
      const result = pageRefMachine.step(refs.get(key) ?? IDLE_REF, event);
      if (!result.rejected) refs.set(key, result.state);
      for (const effect of result.effects)
        if (effect.type === "expire") this.#arm(key, "expired", effect.ms);
        else if (effect.type === "backoff") this.#arm(key, "retry", effect.ms);
      return result;
    });
    if (results.some((result) => !result.rejected))
      this.store.update((state) => ({ ...state, refs }));
    return results;
  }

  /** Feed `type` back to `key`'s ref after `ms`, replacing its last timer. */
  #arm(key, type, ms) {
    this.#timers.get(key)?.unsubscribe();
    const subscription = timer(ms, this.scheduler).subscribe(() => {
      this.#timers.delete(key);
      this.#steps([[key, { type }]]);
    });
    if (!subscription.closed) this.#timers.set(key, subscription);
  }
}
