// Card previews for the library grid (Library.jsx PageGrid). Each card asks
// for its Page's card (model/page-card.mjs) when it nears the viewport; the
// requests go out in batches of up to 24 through `page_cards`, which checks
// access as list_pages does (worker/page-cards.mjs).
//
// A batch fills toward 24: the cards that came into view within the gather
// window, then the next cards in the grid's order that haven't asked yet. A
// slow scroll down a phone grid sends one request per 24 cards, not one per
// row.
//
// Each card follows the page-card machine below, keyed by Page ID and the
// row's `content_updated_at`, so a Page edited since the grid asked shows a
// new key and is asked again. The machines live in one Store per mounted
// grid; React reads a card's state from it and keeps none of its own.
// Nothing outlives the mount: a return visit asks again, so there is no
// cross-visit cache to scope by account or age out. A grid that doesn't know
// its account asks nothing, and an answer that names another account
// (`principal`) is ignored and counts as failed.
import { Subject, buffer, debounceTime, from, map, mergeMap } from "rxjs";
import { defineMachine, reject } from "../shared/machine.mjs";
import { Store } from "./store.mjs";

/** The most IDs one page_cards request carries (worker/page-cards.mjs). */
export const PAGE_CARDS_BATCH = 24;
/** How long cards coming into view gather before one request takes them. */
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
 * another account).
 *
 * Events: `visible` (the card neared the viewport), `ahead` (a batch with
 * room took this idle card, the next in the grid), `answered` (a card),
 * `missing` (null), `failed`.
 *
 * Effects: `fetch`, which the loader batches. `ahead` has none: the batch
 * that took the card already carries it.
 */
export const pageCardMachine = defineMachine({
  name: "page-card",
  states: ["idle", "requested", "shown", "empty", "failed"],
  events: ["visible", "ahead", "answered", "missing", "failed"],
  initial: { name: "idle" },
  unreachable: [
    ["idle", "answered", "only a requested card is in a batch"],
    ["idle", "missing", "only a requested card is in a batch"],
    ["idle", "failed", "only a requested card is in a batch"],
  ],
  cases: { "requested/answered": ["content", "blank"] },
  validate: {
    states: { shown: card },
    events: {
      answered: (event) => {
        if (!event.card || typeof event.card !== "object") throw Error("answered needs a card");
      },
    },
    effects: { fetch: () => {} },
  },
  transition(state, event) {
    switch (event.type) {
      case "visible":
        // A failed card asks again when it scrolls back into view.
        if (state.name === "idle" || state.name === "failed")
          return { state: { name: "requested" }, effects: [{ type: "fetch" }] };
        return reject(state, `already ${state.name}`);
      case "ahead":
        // Only a card that never asked: a failed one waits until it's seen.
        if (state.name === "idle") return { state: { name: "requested" }, effects: [] };
        return reject(state, `already ${state.name}`);
      case "answered":
        if (state.name !== "requested") return reject(state, "not waiting for a card");
        return Array.isArray(event.card.blocks) && event.card.blocks.length > 0
          ? { state: { name: "shown", card: event.card }, effects: [] }
          : { state: { name: "empty" }, effects: [] };
      case "missing":
        if (state.name !== "requested") return reject(state, "not waiting for a card");
        return { state: { name: "empty" }, effects: [] };
      case "failed":
        if (state.name !== "requested") return reject(state, "not waiting for a card");
        return { state: { name: "failed" }, effects: [] };
    }
  },
});

export const IDLE_CARD = pageCardMachine.initial;

/** `items` in runs of at most `size`. */
const chunks = (items, size) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );

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
 * - `scheduler` is the RxJS scheduler that gathers batches; tests pass a
 *   virtual one.
 */
export class PageCards {
  #wants = new Subject();
  #abort = new AbortController();
  #observer = null;
  #rows = new Map();
  #order = [];
  constructor({
    tool,
    principal = null,
    observer = globalThis.IntersectionObserver
      ? (callback, options) => new globalThis.IntersectionObserver(callback, options)
      : null,
    gatherMs = PAGE_CARDS_GATHER_MS,
    batchSize = PAGE_CARDS_BATCH,
    scheduler,
  }) {
    this.tool = tool;
    this.principal = principal;
    this.createObserver = observer;
    this.gatherMs = gatherMs;
    this.batchSize = batchSize;
    this.scheduler = scheduler;
    this.store = new Store(new Map());
  }

  /** Start batching; returns the stop function (useConnected). Cards that
   * come into view within `gatherMs` of each other share requests of at
   * most `batchSize`, topped up with the next cards in the grid's order.
   * Nothing runs on a timer while no card is asked for. */
  connect() {
    // A fresh signal per connection: React may connect, stop and connect
    // the same loader again (StrictMode, a fast remount).
    const abort = new AbortController();
    this.#abort = abort;
    const quiet = this.#wants.pipe(debounceTime(this.gatherMs, this.scheduler));
    const subscription = this.#wants
      .pipe(
        buffer(quiet),
        map((gathered) => this.#fill(gathered)),
        mergeMap((gathered) => from(chunks(gathered, this.batchSize))),
        mergeMap((batch) => from(this.#fetch(batch)), PAGE_CARDS_CONCURRENCY),
      )
      .subscribe();
    return () => {
      subscription.unsubscribe();
      abort.abort();
      this.#observer?.disconnect();
      this.#observer = null;
      this.#rows.clear();
    };
  }

  /** The card state for `key`. */
  state(key) {
    return this.store.snapshot().get(key) ?? IDLE_CARD;
  }

  /** The grid's rows in the order it shows them, for topping up batches. */
  arrange(rows) {
    this.#order = rows;
  }

  /** `row` came into view. */
  visible(row) {
    if (!this.principal) return;
    const key = cardKeyOf(row);
    const { effects } = this.#steps([[key, { type: "visible" }]])[0];
    if (effects.some((effect) => effect.type === "fetch")) this.#wants.next({ key, id: row.id });
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
        for (const entry of entries) {
          const seen = this.#rows.get(entry.target);
          if (entry.isIntersecting && seen) this.visible(seen);
        }
      },
      { rootMargin: PAGE_CARDS_ROOT_MARGIN },
    );
    this.#rows.set(element, row);
    this.#observer.observe(element);
    return () => {
      this.#rows.delete(element);
      this.#observer?.unobserve(element);
    };
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

  /** `gathered`, deduplicated, then the idle cards after the last of them in
   * the grid's order, until the last batch is full. */
  #fill(gathered) {
    const seen = new Set();
    const wants = gathered.filter(({ key }) => !seen.has(key) && seen.add(key));
    const room = (this.batchSize - (wants.length % this.batchSize)) % this.batchSize;
    if (!room || !this.#order.length) return wants;
    const wanted = new Set(wants.map(({ id }) => id));
    let last = -1;
    this.#order.forEach((row, index) => {
      if (wanted.has(row.id)) last = index;
    });
    const ahead = [];
    for (let index = last + 1; index < this.#order.length && ahead.length < room; index++) {
      const row = this.#order[index];
      const key = cardKeyOf(row);
      if (row.local || seen.has(key) || this.state(key).name !== "idle") continue;
      seen.add(key);
      ahead.push({ key, id: row.id });
    }
    this.#steps(ahead.map(({ key }) => [key, { type: "ahead" }]));
    return [...wants, ...ahead];
  }

  async #fetch(batch) {
    // The connection this request belongs to, even if React reconnects.
    const signal = this.#abort.signal;
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
  }
}
