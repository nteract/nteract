// Card previews for the library grid (Library.jsx PageGrid). Each card asks
// for its Page's card (model/page-card.mjs) when it nears the viewport; the
// requests go out in batches of up to 24 through `page_cards`, which checks
// access as list_pages does (worker/page-cards.mjs).
//
// Cards that ask wait together for at most 200 ms from the first of them, or
// until 24 wait, whichever comes first (the page-card-batches machine below),
// so a steady scroll still sends requests while it runs. A request takes the
// latest cards to come into view first. A card that leaves the viewport, or
// unmounts, before its request goes out stops waiting and goes back to idle,
// so a request never carries a card that left view before it went out. A
// request then fills toward 24 with the next cards in the grid's order that
// haven't asked yet, so a slow scroll down a phone grid sends one request per
// 24 cards, not one per row.
//
// Each card follows the page-card machine below, keyed by Page ID and the
// row's `content_updated_at`, so a Page edited since the grid asked shows a
// new key and is asked again. The machines live in one Store per mounted
// grid; React reads a card's state from it and keeps none of its own.
// Nothing outlives the mount: a return visit asks again, so there is no
// cross-visit cache to scope by account or age out. A grid that doesn't know
// its account asks nothing, and an answer that names another account
// (`principal`) is ignored and counts as failed.
import { EMPTY, Subject, switchMap, timer } from "rxjs";
import { defineMachine, reject } from "../shared/machine.mjs";
import { Store } from "./store.mjs";

/** The most IDs one page_cards request carries (worker/page-cards.mjs). */
export const PAGE_CARDS_BATCH = 24;
/** The longest a card that asked waits for others to share its request. */
export const PAGE_CARDS_GATHER_MS = 200;
/** page_cards requests one grid runs at once. */
export const PAGE_CARDS_CONCURRENCY = 2;
/** How far outside the viewport a card starts loading. */
export const PAGE_CARDS_ROOT_MARGIN = "400px 0px";

const card = (state) => {
  if (!state.card || typeof state.card !== "object" || !Array.isArray(state.card.blocks))
    throw Error("shown needs a card with blocks");
};

/**
 * One grid card's preview.
 *
 * States: idle (not asked), requested (in a batch), shown (a card with
 * content), empty (no card, or one with nothing to show; also what a refused
 * or unknown Page answers), failed (the request failed or answered for
 * another account), stale (a card this browser kept from an earlier visit,
 * library-device-cache.mjs, not asked yet on this one), revalidating (a kept
 * card in a batch: it stays drawn until the answer replaces it).
 *
 * Events: `visible` (the card neared the viewport), `ahead` (a batch with
 * room took this idle or stale card, the next in the grid), `left` (a card
 * that asked left the viewport before its request went out), `answered` (a
 * card), `missing` (null), `failed`, `recalled` (a kept card for this key).
 *
 * A kept card is only drawn while it is asked for again: `missing` drops
 * it (the Page has no card for this account now), and `failed` keeps it
 * drawn as stale, so it asks again when it scrolls back into view.
 *
 * Effects: `fetch`, which the loader batches. `ahead` has none: the batch
 * that took the card already carries it.
 */
const ASKED = "only a card that asked is in a batch";
const WAITS = "only a card that asked waits to go out";
export const pageCardMachine = defineMachine({
  name: "page-card",
  states: ["idle", "requested", "shown", "empty", "failed", "stale", "revalidating"],
  events: ["visible", "ahead", "left", "answered", "missing", "failed", "recalled"],
  initial: { name: "idle" },
  unreachable: [
    ["idle", "left", WAITS],
    ["shown", "left", WAITS],
    ["empty", "left", WAITS],
    ["failed", "left", WAITS],
    ["stale", "left", WAITS],
    ["idle", "answered", ASKED],
    ["idle", "missing", ASKED],
    ["idle", "failed", ASKED],
    ["stale", "answered", ASKED],
    ["stale", "missing", ASKED],
    ["stale", "failed", ASKED],
  ],
  cases: {
    "requested/answered": ["content", "blank"],
    "revalidating/answered": ["content", "blank"],
  },
  validate: {
    states: { shown: card, stale: card, revalidating: card },
    events: {
      answered: (event) => {
        if (!event.card || typeof event.card !== "object") throw Error("answered needs a card");
      },
      recalled: (event) => card(event),
    },
    effects: { fetch: () => {} },
  },
  transition(state, event) {
    const asked = state.name === "requested" || state.name === "revalidating";
    switch (event.type) {
      case "visible":
        // A failed card asks again when it scrolls back into view.
        if (state.name === "idle" || state.name === "failed")
          return { state: { name: "requested" }, effects: [{ type: "fetch" }] };
        if (state.name === "stale")
          return {
            state: { name: "revalidating", card: state.card },
            effects: [{ type: "fetch" }],
          };
        return reject(state, `already ${state.name}`);
      case "ahead":
        // Only a card that never asked: a failed one waits until it's seen.
        if (state.name === "idle") return { state: { name: "requested" }, effects: [] };
        if (state.name === "stale")
          return { state: { name: "revalidating", card: state.card }, effects: [] };
        return reject(state, `already ${state.name}`);
      case "left":
        // An asked card only (see unreachable): it asks again when it's seen.
        if (state.name === "revalidating")
          return { state: { name: "stale", card: state.card }, effects: [] };
        if (state.name === "requested") return { state: { name: "idle" }, effects: [] };
        return reject(state, "not waiting to go out");
      case "answered":
        if (!asked) return reject(state, "not waiting for a card");
        return Array.isArray(event.card.blocks) && event.card.blocks.length > 0
          ? { state: { name: "shown", card: event.card }, effects: [] }
          : { state: { name: "empty" }, effects: [] };
      case "missing":
        if (!asked) return reject(state, "not waiting for a card");
        return { state: { name: "empty" }, effects: [] };
      case "failed":
        if (!asked) return reject(state, "not waiting for a card");
        if (state.name === "revalidating")
          return { state: { name: "stale", card: state.card }, effects: [] };
        return { state: { name: "failed" }, effects: [] };
      case "recalled":
        // Only before this visit asked: anything the server said wins.
        if (state.name === "idle")
          return { state: { name: "stale", card: event.card }, effects: [] };
        return reject(state, `already ${state.name}`);
    }
  },
});

/** The card a state draws, or null. */
export const drawnCard = (state) =>
  state.name === "shown" || state.name === "stale" || state.name === "revalidating"
    ? state.card
    : null;

export const IDLE_CARD = pageCardMachine.initial;

const count = (value, label) => {
  if (!Number.isInteger(value) || value < 0) throw Error(`${label} must be a count`);
};
const limits = (state) => {
  count(state.waiting, "waiting");
  count(state.busy, "busy");
  if (!Number.isInteger(state.batch) || state.batch < 1) throw Error("batch must be positive");
  if (!Number.isInteger(state.slots) || state.slots < 1) throw Error("slots must be positive");
  if (state.busy > state.slots) throw Error("busy can't pass slots");
  if (typeof state.opened !== "boolean") throw Error("opened is a boolean");
};

/** Send requests while a slot is free: full batches only, or with `all`,
 * whatever waits. */
function sendWaiting(state, effects, all) {
  let next = state;
  while (next.busy < next.slots && (all ? next.waiting > 0 : next.waiting >= next.batch)) {
    const take = Math.min(next.waiting, next.batch);
    effects.push({ type: "send", take });
    next = { ...next, waiting: next.waiting - take, busy: next.busy + 1, opened: true };
  }
  return next;
}

/** Back to quiet once nothing waits; a window still running is cancelled. */
function quietWhenEmpty(state, effects) {
  if (state.waiting > 0) return state;
  if (state.name === "gathering") effects.push({ type: "disarm" });
  return { ...state, name: "quiet" };
}

/**
 * When a grid's waiting cards go out.
 *
 * States carry `waiting` (cards that asked and haven't gone out), `busy`
 * (requests running), the limits `batch` (cards per request) and `slots`
 * (requests at once), and `opened`, whether this grid has sent a request.
 * - quiet: nothing waits.
 * - gathering: cards wait and the window, started by the first of them, is
 *   running. A full batch goes out at once if a slot is free.
 * - due: the window ended with every slot busy; the next free slot sends.
 *
 * The first window of a grid that hasn't sent anything is `eager`: it ends
 * as soon as the cards that came into view together have asked (the
 * loader's next task), not after the gather time. The rows in view on the
 * first paint go out at once; later scrolling keeps the gather.
 *
 * Events: `wanted` (a card asked), `dropped` (a waiting card left the
 * viewport), `elapsed` (the window ended), `settled` (a request ended,
 * answered or not).
 *
 * Effects: `arm` (with `eager`) and `disarm` the window, and `send` a
 * request that takes `take` waiting cards. Which cards, and the top-up
 * toward a full batch, are the loader's choice when it sends.
 */
export const pageCardBatchMachine = defineMachine({
  name: "page-card-batches",
  states: ["quiet", "gathering", "due"],
  events: ["wanted", "dropped", "elapsed", "settled"],
  initial: {
    name: "quiet",
    waiting: 0,
    busy: 0,
    batch: PAGE_CARDS_BATCH,
    slots: PAGE_CARDS_CONCURRENCY,
    opened: false,
  },
  cases: {
    "quiet/wanted": ["eager", "gather"],
    "gathering/wanted": ["gather", "full"],
    "gathering/dropped": ["gather", "drained"],
    "due/dropped": ["due", "drained"],
    "gathering/elapsed": ["sent", "due"],
    "gathering/settled": ["gather", "full", "stray"],
    "due/settled": ["drained", "more"],
  },
  validate: {
    states: {
      quiet: (state) => {
        limits(state);
        if (state.waiting !== 0) throw Error("quiet has nothing waiting");
      },
      gathering: (state) => {
        limits(state);
        if (state.waiting === 0) throw Error("gathering needs a waiting card");
      },
      due: (state) => {
        limits(state);
        if (state.waiting === 0) throw Error("due needs a waiting card");
        if (state.busy < state.slots) throw Error("due waits only for a busy slot");
      },
    },
    effects: {
      arm: (effect) => {
        if (typeof effect.eager !== "boolean") throw Error("arm says whether it is eager");
      },
      disarm: () => {},
      send: (effect) => {
        if (!Number.isInteger(effect.take) || effect.take < 1) throw Error("send takes a card");
      },
    },
  },
  transition(state, event) {
    const effects = [];
    switch (event.type) {
      case "wanted": {
        const waiting = { ...state, waiting: state.waiting + 1 };
        if (state.name === "quiet") {
          effects.push({ type: "arm", eager: !state.opened });
          waiting.name = "gathering";
        }
        // A due card goes out with the next free slot; a gathering one with
        // a full batch or the window's end.
        const sent = sendWaiting(waiting, effects, waiting.name === "due");
        return { state: quietWhenEmpty(sent, effects), effects };
      }
      case "dropped": {
        if (state.waiting === 0) return reject(state, "nothing waits");
        return {
          state: quietWhenEmpty({ ...state, waiting: state.waiting - 1 }, effects),
          effects,
        };
      }
      case "elapsed": {
        // A timer that fired as the window closed.
        if (state.name !== "gathering") return reject(state, "no window is running");
        const sent = sendWaiting({ ...state, name: "due" }, effects, true);
        return { state: sent.waiting ? sent : { ...sent, name: "quiet" }, effects };
      }
      case "settled": {
        if (state.busy === 0) return reject(state, "no request is running");
        const freed = { ...state, busy: state.busy - 1 };
        if (state.name === "quiet") return { state: freed, effects };
        const sent = sendWaiting(freed, effects, state.name === "due");
        return { state: quietWhenEmpty(sent, effects), effects };
      }
    }
  },
});

/** A grid row's card key: its Page and the content time it was listed with. */
export const cardKeyOf = (row) => `${row.id}\n${row.contentUpdatedAt ?? ""}`;

/**
 * The cards of one mounted grid.
 *
 * - `tool(operation, args, { signal })` calls /api/tools.
 * - `principal` is the account the grid lists for. Without one the grid asks
 *   for nothing; an answer naming another account is ignored.
 * - `observer(callback, options)` builds an IntersectionObserver; without
 *   one, `observe` asks at once.
 * - `scheduler` is the RxJS scheduler that runs the gather window; tests
 *   pass a virtual one.
 */
export class PageCards {
  #abort = new AbortController();
  #observer = null;
  #rows = new Map();
  #order = [];
  /** Grid position by Page ID, for the top-up and a request's order. */
  #index = new Map();
  /** Cards that asked and haven't gone out, by key, in the order they asked. */
  #waiting = new Map();
  /** When each card that intersects now came into view, by key: a count
   * of observer reports, so a later report is a larger number. */
  #views = new Map();
  #viewCount = 0;
  #batches = null;
  #window = new Subject();
  constructor({
    tool,
    principal = null,
    observer = globalThis.IntersectionObserver
      ? (callback, options) => new globalThis.IntersectionObserver(callback, options)
      : null,
    gatherMs = PAGE_CARDS_GATHER_MS,
    batchSize = PAGE_CARDS_BATCH,
    concurrency = PAGE_CARDS_CONCURRENCY,
    scheduler,
    onCards = () => {},
  }) {
    this.tool = tool;
    this.principal = principal;
    this.onCards = onCards;
    this.createObserver = observer;
    this.gatherMs = gatherMs;
    this.batchSize = batchSize;
    this.concurrency = concurrency;
    this.scheduler = scheduler;
    this.store = new Store(new Map());
  }

  /** Start sending; returns the stop function (useConnected). A card that
   * asks waits at most `gatherMs` for others to share its request, and a
   * request goes out as soon as `batchSize` wait. Nothing runs on a timer
   * while no card waits. */
  connect() {
    // A fresh signal per connection: React may connect, stop and connect
    // the same loader again (StrictMode, a fast remount).
    const abort = new AbortController();
    this.#abort = abort;
    this.#batches = {
      ...pageCardBatchMachine.initial,
      batch: this.batchSize,
      slots: this.concurrency,
    };
    const subscription = this.#window
      .pipe(
        switchMap((armed) =>
          armed ? timer(armed.eager ? 0 : this.gatherMs, this.scheduler) : EMPTY,
        ),
      )
      .subscribe(() => this.#dispatch({ type: "elapsed" }));
    // Cards that asked before this connection go out under it, one `wanted`
    // each. A send shrinks the waiting set as this runs, so count it first.
    const asked = this.#waiting.size;
    for (let index = 0; index < asked; index++) this.#dispatch({ type: "wanted" });
    return () => {
      subscription.unsubscribe();
      abort.abort();
      this.#batches = null;
      this.#observer?.disconnect();
      this.#observer = null;
      this.#rows.clear();
      this.#views.clear();
    };
  }

  /** The card state for `key`. */
  state(key) {
    return this.store.snapshot().get(key) ?? IDLE_CARD;
  }

  /** Cards this browser kept for the grid's rows (library-device-cache.mjs),
   * `[{ id, at, card }]`: each draws at once for the row with that Page ID
   * and content time, and is asked for again when it comes into view. A
   * card this visit has already asked for keeps what it has. A grid that
   * doesn't know its account draws none. */
  recall(entries) {
    if (!this.principal || !entries?.length) return;
    this.#steps(
      entries
        .filter((entry) => typeof entry?.id === "string" && entry.card?.blocks)
        .map(({ id, at, card }) => [
          cardKeyOf({ id, contentUpdatedAt: at }),
          { type: "recalled", card },
        ]),
    );
  }

  /** The grid's rows in the order it shows them, for topping up batches. */
  arrange(rows) {
    this.#order = rows;
    this.#index = new Map(rows.map((row, index) => [row.id, index]));
  }

  /** `row` came into view. Cards reported together share `at`, so they
   * keep the order they asked in. */
  visible(row, at = ++this.#viewCount) {
    if (!this.principal) return;
    const key = cardKeyOf(row);
    this.#views.set(key, at);
    const { effects } = this.#steps([[key, { type: "visible" }]])[0];
    if (!effects.some((effect) => effect.type === "fetch")) return;
    this.#waiting.set(key, { key, id: row.id, at: row.contentUpdatedAt ?? null });
    this.#dispatch({ type: "wanted" });
  }

  /** Watch `element` and ask for `row`'s card when it nears the viewport.
   * Returns the stop function. */
  observe(element, row) {
    if (!element || !this.principal) return () => {};
    if (!this.createObserver) {
      this.visible(row);
      return () => {};
    }
    this.#observer ??= this.createObserver(
      (entries) => {
        const at = ++this.#viewCount;
        for (const entry of entries) {
          const seen = this.#rows.get(entry.target);
          if (!seen) continue;
          if (entry.isIntersecting) this.visible(seen, at);
          else this.#left(seen);
        }
      },
      { rootMargin: PAGE_CARDS_ROOT_MARGIN },
    );
    this.#rows.set(element, row);
    this.#observer.observe(element);
    return () => {
      this.#rows.delete(element);
      this.#left(row);
      this.#observer?.unobserve(element);
    };
  }

  /** `row` left the viewport, or unmounted. A card still waiting to go out
   * goes back to idle and asks again when it's seen. */
  #left(row) {
    const key = cardKeyOf(row);
    this.#views.delete(key);
    if (!this.#waiting.delete(key)) return;
    this.#steps([[key, { type: "left" }]]);
    this.#dispatch({ type: "dropped" });
  }

  /** Step the batch machine and run its effects. Before `connect` and after
   * a stop, cards only wait; the next connection sends them. */
  #dispatch(event) {
    if (!this.#batches) return;
    const result = pageCardBatchMachine.step(this.#batches, event);
    this.#batches = result.state;
    for (const effect of result.effects) {
      if (effect.type === "arm") this.#window.next({ eager: effect.eager });
      else if (effect.type === "disarm") this.#window.next(false);
      else if (effect.type === "send") this.#send(effect.take);
    }
  }

  /** Send `take` waiting cards, topped up, and report when it settles. */
  #send(take) {
    const signal = this.#abort.signal;
    const batch = this.#fill(this.#pick(take));
    this.#fetch(batch, signal).finally(() => {
      if (!signal.aborted) this.#dispatch({ type: "settled" });
    });
  }

  /** The `take` waiting cards to send now, the latest into view first. One
   * with no view recorded (it asked before a reconnect) comes after them, in
   * the order it asked. The request lists them in the grid's order. */
  #pick(take) {
    const waiting = [...this.#waiting.values()];
    const seen = (want) => this.#views.get(want.key) ?? 0;
    // Array sort is stable: cards without a view keep the order they asked in.
    const picked = waiting.sort((a, b) => seen(b) - seen(a)).slice(0, take);
    for (const { key } of picked) this.#waiting.delete(key);
    // Cards the grid hasn't placed keep the order they were picked in.
    const position = (want) => this.#index.get(want.id) ?? Infinity;
    return picked.sort((a, b) => (position(a) === position(b) ? 0 : position(a) - position(b)));
  }

  /** `picked`, then the idle cards after the last of them in the grid's
   * order, until the request is full. */
  #fill(picked) {
    const room = this.batchSize - picked.length;
    if (room <= 0 || !this.#order.length) return picked;
    const seen = new Set(picked.map(({ key }) => key));
    let last = -1;
    for (const { id } of picked) last = Math.max(last, this.#index.get(id) ?? -1);
    const ahead = [];
    for (let index = last + 1; index < this.#order.length && ahead.length < room; index++) {
      const row = this.#order[index];
      const key = cardKeyOf(row);
      const name = this.state(key).name;
      if (row.local || row.held || seen.has(key) || (name !== "idle" && name !== "stale")) continue;
      seen.add(key);
      ahead.push({ key, id: row.id, at: row.contentUpdatedAt ?? null });
    }
    this.#steps(ahead.map(({ key }) => [key, { type: "ahead" }]));
    return [...picked, ...ahead];
  }

  /** Apply events to cards in one store update; returns each step result. */
  #steps(pairs) {
    const current = this.store.snapshot();
    const next = new Map(current);
    const results = pairs.map(([key, event]) => {
      const result = pageCardMachine.step(next.get(key) ?? IDLE_CARD, event);
      if (!result.rejected) next.set(key, result.state);
      return result;
    });
    if (results.some((result) => !result.rejected)) this.store.update(() => next);
    return results;
  }

  /** Ask for `batch` under `signal`, the connection that sent it, even if
   * React reconnects. */
  async #fetch(batch, signal) {
    const ids = [...new Set(batch.map((want) => want.id))];
    let answer;
    try {
      answer = await this.tool("page_cards", { page_ids: ids }, { signal });
    } catch {
      if (signal.aborted) return;
      this.#steps(batch.map(({ key }) => [key, { type: "failed" }]));
      return;
    }
    if (signal.aborted) return;
    const own = answer?.principal === this.principal;
    const cards = own && answer?.cards && typeof answer.cards === "object" ? answer.cards : null;
    this.#steps(
      batch.map(({ key, id }) => {
        const found = cards?.[id];
        if (!cards) return [key, { type: "failed" }];
        if (found && typeof found === "object") return [key, { type: "answered", card: found }];
        return [key, { type: "missing" }];
      }),
    );
    // What this account was just shown, for the device cache: each card, or
    // null for one that has none now.
    if (cards)
      this.onCards(
        batch.map(({ id, at = null }) => {
          const found = cards[id];
          return { id, at, card: found && typeof found === "object" ? found : null };
        }),
      );
  }
}
