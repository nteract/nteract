// The owner's library redraws stored card images larger than a capture
// (worker/card-images.mjs) at the capture's size (card-raster.mjs).
//
// The grid offers a Page when the shown image it already loaded is wider or
// taller than CARD_PIXEL_WIDTH×CARD_PIXEL_HEIGHT and the row says the account
// owns the Page (card-shrink-offers.mjs). This module loads on the first
// offer. It works one Page at a time, CARD_SHRINK_GAP_MS apart and then only
// once the main thread is idle, and only while the tab is visible. For each
// theme it fetches the stored image past this browser's HTTP cache, which
// can hold a larger copy under the same immutable URL after another device
// shrank it. An image already at the capture's size needs nothing. A larger
// one is drawn into a canvas of that size with high smoothing, encoded as a
// capture is (encodeCard), and uploaded through the capture's route with
// the same `card_hash` and theme. The URL the record names after the upload
// is fetched past the cache again, so the next visit's grid loads the
// smaller image and offers nothing.
//
// The Page host decides every upload: the owner only, the hash of its loaded
// document, one upload per theme a minute. Any refusal or failure ends that
// Page's turn for this visit to the library; nothing retries on a timer.
// Each upload wakes the Page's Durable Object, which loads its document to
// check the hash.
import {
  EMPTY,
  Observable,
  Subject,
  Subscription,
  distinctUntilChanged,
  fromEvent,
  map,
  startWith,
  switchMap,
  timer,
} from "rxjs";
import { defineMachine, reject } from "../shared/machine.mjs";
import { CARD_PIXEL_HEIGHT, CARD_PIXEL_WIDTH, captureAllowed, encodeCard } from "./card-raster.mjs";

/** The gap before each Page's turn, after an offer, after the last Page or
 * after the tab shows again. The turn then waits for an idle main thread. */
export const CARD_SHRINK_GAP_MS = 5_000;
/** How long a turn waits for an idle main thread before it starts anyway. */
export const CARD_SHRINK_IDLE_TIMEOUT_MS = 2_000;

const THEMES = ["light", "dark"];
const HASH = /^[0-9a-f]{64}$/;
const OUTCOMES = ["shrunk", "current", "refused"];

/** Throws unless `candidate` is `{ page_id, card_hash, light, dark }` with
 * each theme's URL on this Page's card image route for that hash. */
function assertCandidate(candidate) {
  if (typeof candidate?.page_id !== "string" || candidate.page_id === "")
    throw Error("a candidate needs a page_id");
  if (!HASH.test(candidate.card_hash ?? "")) throw Error("a candidate needs a card hash");
  for (const theme of THEMES) {
    const prefix = `/api/pages/${candidate.page_id}/card-image/${candidate.card_hash}-${theme}.`;
    if (typeof candidate[theme] !== "string" || !candidate[theme].startsWith(prefix))
      throw Error(`a candidate's ${theme} URL must be its card image route`);
  }
}
const context = (state) => {
  if (typeof state.visible !== "boolean") throw Error("visible must be a boolean");
  if (!Array.isArray(state.queue)) throw Error("queue must be an array");
  state.queue.forEach(assertCandidate);
  if (!Array.isArray(state.done)) throw Error("done must be an array");
  for (const entry of state.done) {
    if (typeof entry?.page_id !== "string") throw Error("a done entry needs a page_id");
    if (!OUTCOMES.includes(entry.outcome)) throw Error("a done entry needs an outcome");
  }
};
const quiet = (state) => {
  context(state);
  if ("target" in state) throw Error(`${state.name} has no target`);
};

/** Whether a turn should wait for its gap: a Page waits and the tab shows. */
export const wantsTurn = (state) => state.visible && state.queue.length > 0;

/** Whether `pageId` was offered this visit: waiting, shrinking or done. */
const offeredBefore = (state, pageId) =>
  state.target?.page_id === pageId ||
  state.queue.some((candidate) => candidate.page_id === pageId) ||
  state.done.some((entry) => entry.page_id === pageId);

/** An idle state (no Page shrinking) after its context changed. */
function settle(state, effects) {
  const { target: _target, ...rest } = state;
  if (wantsTurn(rest)) {
    if (rest.name !== "waiting") effects.push({ type: "arm" });
    return { ...rest, name: "waiting" };
  }
  if (rest.name === "waiting") effects.push({ type: "disarm" });
  return { ...rest, name: "idle" };
}

/**
 * One library visit's shrink pass.
 *
 * Every state carries `visible` (the tab is visible), `queue` (the offered
 * Pages not yet shrunk, in offer order) and `done` (`{ page_id, outcome }`
 * for each Page whose turn ended this visit).
 *
 * States: idle (nothing waits, or the tab is hidden), waiting (the gap
 * timer runs), shrinking (`target` is the Page being worked on), stopped
 * (the library closed; terminal).
 *
 * Events: `offered` (`candidate`), `visible`, `hidden`, `elapsed` (the gap
 * passed and the main thread is idle), `finished` (`page_id`, `outcome`:
 * shrunk, current when every theme was already small, refused for a
 * refusal or a failure), `stop`.
 *
 * Effects: `arm` and `disarm` the gap timer, `shrink` (`candidate`),
 * `cancel` the running shrink.
 */
export const cardShrinkMachine = defineMachine({
  name: "card-shrink",
  states: ["idle", "waiting", "shrinking", "stopped"],
  events: ["offered", "visible", "hidden", "elapsed", "finished", "stop"],
  initial: { name: "idle", visible: false, queue: [], done: [] },
  cases: {
    "idle/offered": ["known", "held", "wants"],
    "waiting/offered": ["known", "queued"],
    "shrinking/offered": ["known", "queued"],
    "idle/visible": ["already", "holds", "wants"],
    "idle/hidden": ["already", "hides"],
    "shrinking/finished": ["mine", "stale"],
  },
  validate: {
    states: {
      idle: quiet,
      waiting: (state) => {
        quiet(state);
        if (!wantsTurn(state)) throw Error("waiting needs a visible tab and a Page");
      },
      shrinking: (state) => {
        context(state);
        if (!state.visible) throw Error("shrinking needs a visible tab");
        assertCandidate(state.target);
      },
      stopped: (state) => {
        quiet(state);
        if (state.visible || state.queue.length) throw Error("stopped holds nothing to do");
      },
    },
    events: {
      offered: (event) => assertCandidate(event.candidate),
      finished: (event) => {
        if (typeof event.page_id !== "string") throw Error("finished needs a page_id");
        if (!OUTCOMES.includes(event.outcome)) throw Error("finished needs an outcome");
      },
    },
    effects: {
      arm: () => {},
      disarm: () => {},
      shrink: (effect) => assertCandidate(effect.candidate),
      cancel: () => {},
    },
  },
  transition(state, event) {
    const effects = [];
    if (state.name === "stopped") return reject(state, "stopped");
    switch (event.type) {
      case "offered": {
        if (offeredBefore(state, event.candidate.page_id))
          return reject(state, "offered this visit");
        const next = { ...state, queue: [...state.queue, event.candidate] };
        if (state.name !== "idle") return { state: next, effects };
        return { state: settle(next, effects), effects };
      }
      case "visible":
        if (state.visible) return reject(state, "already visible");
        return { state: settle({ ...state, visible: true }, effects), effects };
      case "hidden": {
        if (!state.visible) return reject(state, "already hidden");
        if (state.name === "shrinking") {
          // The Page goes back to the front; an image it already shrank
          // reads as current on its next turn.
          effects.push({ type: "cancel" });
          const { target, ...rest } = state;
          const next = { ...rest, name: "idle", visible: false, queue: [target, ...state.queue] };
          return { state: settle(next, effects), effects };
        }
        return { state: settle({ ...state, visible: false }, effects), effects };
      }
      case "elapsed": {
        // A timer that fired as the state moved on.
        if (state.name !== "waiting") return reject(state, "no gap timer is running");
        const [target, ...queue] = state.queue;
        effects.push({ type: "shrink", candidate: target });
        return { state: { ...state, name: "shrinking", target, queue }, effects };
      }
      case "finished": {
        if (state.name !== "shrinking" || state.target.page_id !== event.page_id)
          return reject(state, "not this Page's turn");
        const done = [...state.done, { page_id: event.page_id, outcome: event.outcome }];
        return { state: settle({ ...state, name: "idle", done }, effects), effects };
      }
      case "stop": {
        if (state.name === "waiting") effects.push({ type: "disarm" });
        if (state.name === "shrinking") effects.push({ type: "cancel" });
        return {
          state: { name: "stopped", visible: false, queue: [], done: state.done },
          effects,
        };
      }
    }
  },
});

/** An Observable that emits once when the main thread is idle, or after
 * `timeout` ms at the latest; unsubscribing cancels the wait. */
export function whenIdle(timeout = CARD_SHRINK_IDLE_TIMEOUT_MS, browser = globalThis) {
  return new Observable((subscriber) => {
    const done = () => {
      subscriber.next();
      subscriber.complete();
    };
    if (typeof browser.requestIdleCallback === "function") {
      const id = browser.requestIdleCallback(done, { timeout });
      return () => browser.cancelIdleCallback?.(id);
    }
    const id = setTimeout(done, 0);
    return () => clearTimeout(id);
  });
}

/**
 * The machine with its effects at the edge.
 *
 * - `visible$`: an Observable of whether the tab is visible.
 * - `shrink(candidate, signal)`: one Page's turn; resolves with its
 *   outcome. It must stop when `signal` aborts.
 * - `scheduler`: the RxJS scheduler for the gap timer.
 * - `idle()`: an Observable that emits once the main thread is idle.
 */
export class CardShrink {
  state = cardShrinkMachine.initial;
  #gap = new Subject();
  #subscription = new Subscription();
  #abort = null;
  /** The running or last turn, so a new one starts only after it ends. */
  #running = Promise.resolve();
  constructor({
    visible$,
    shrink,
    scheduler,
    gapMs = CARD_SHRINK_GAP_MS,
    idle = () => whenIdle(),
    onError = () => {},
  }) {
    this.shrink = shrink;
    this.onError = onError;
    this.#subscription.add(
      this.#gap
        .pipe(
          switchMap((armed) =>
            armed ? timer(gapMs, scheduler).pipe(switchMap(() => idle())) : EMPTY,
          ),
        )
        .subscribe(() => this.dispatch({ type: "elapsed" })),
    );
    this.#subscription.add(
      visible$
        .pipe(distinctUntilChanged())
        .subscribe((visible) => this.dispatch({ type: visible ? "visible" : "hidden" })),
    );
  }

  /** Offer a Page: `{ page_id, card_hash, light, dark }`. */
  offer(candidate) {
    return this.dispatch({ type: "offered", candidate });
  }

  dispatch(event) {
    const result = cardShrinkMachine.step(this.state, event);
    if (result.rejected) return result;
    this.state = result.state;
    for (const effect of result.effects) this.#run(effect);
    return result;
  }

  /** Leave the library: cancel a running turn and the gap timer. */
  stop() {
    this.dispatch({ type: "stop" });
    this.#subscription.unsubscribe();
  }

  #run(effect) {
    switch (effect.type) {
      case "arm":
        return this.#gap.next(true);
      case "disarm":
        return this.#gap.next(false);
      case "cancel":
        this.#abort?.abort();
        this.#abort = null;
        return;
      case "shrink": {
        const abort = new AbortController();
        this.#abort = abort;
        const { candidate } = effect;
        this.#running = this.#running.then(async () => {
          if (abort.signal.aborted) return;
          let outcome;
          try {
            outcome = await this.shrink(candidate, abort.signal);
          } catch (error) {
            if (abort.signal.aborted) return;
            this.onError(error);
            outcome = "refused";
          }
          if (abort.signal.aborted) return;
          this.dispatch({ type: "finished", page_id: candidate.page_id, outcome });
        });
        return;
      }
    }
  }
}

/**
 * The capture-sized redraw of a stored image, or null when it is already
 * at or under the capture's size. `decode(blob)` gives an ImageBitmap;
 * `document` makes the canvas.
 */
export async function smallerCard(
  blob,
  {
    document = globalThis.document,
    decode = (image) => globalThis.createImageBitmap(image),
    encode = encodeCard,
  } = {},
) {
  const bitmap = await decode(blob);
  try {
    if (bitmap.width <= CARD_PIXEL_WIDTH && bitmap.height <= CARD_PIXEL_HEIGHT) return null;
    const canvas = document.createElement("canvas");
    canvas.width = CARD_PIXEL_WIDTH;
    canvas.height = CARD_PIXEL_HEIGHT;
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await encode(canvas);
  } finally {
    bitmap.close?.();
  }
}

/**
 * One Page's turn: each theme's stored image, fetched past the HTTP cache,
 * redrawn and uploaded when it is larger than a capture. Resolves with
 * "shrunk" when an upload landed, "current" when every theme was already
 * small, and "refused" at the first refusal (the Page host's, or a failed
 * read). `redraw(blob)` is smallerCard.
 */
export async function shrinkCard(candidate, { fetch, signal, redraw = smallerCard }) {
  const { page_id: pageId, card_hash: hash } = candidate;
  let shrunk = false;
  for (const theme of THEMES) {
    signal.throwIfAborted();
    const stored = await fetch(candidate[theme], { cache: "reload", signal });
    if (!stored.ok) return "refused";
    const blob = await redraw(await stored.blob());
    if (!blob) continue;
    signal.throwIfAborted();
    const upload = await fetch(`/api/pages/${pageId}/card-image?hash=${hash}&theme=${theme}`, {
      method: "PUT",
      headers: { "Content-Type": blob.type },
      body: blob,
      signal,
    });
    if (!upload.ok) return "refused";
    shrunk = true;
    // The record may name another extension now (a PNG redrawn as WebP).
    const ext = (await upload.json().catch(() => null))?.themes?.[theme];
    if (/^(webp|png|jpg)$/.test(ext ?? ""))
      await fetch(`/api/pages/${pageId}/card-image/${hash}-${theme}.${ext}`, {
        cache: "reload",
        signal,
      })
        .then((response) => response.arrayBuffer())
        .catch(() => {});
  }
  return shrunk ? "shrunk" : "current";
}

/**
 * Start a shrink pass for one visit to the library. Returns `{ offer, stop }`;
 * on Save-Data or a low-memory device (captureAllowed), and without a
 * document, it does nothing.
 */
export function startCardShrink({
  browser = globalThis,
  fetch = globalThis.fetch?.bind(globalThis),
  scheduler,
  gapMs,
  idle,
} = {}) {
  const document = browser.document;
  if (!document || !fetch || !captureAllowed(browser.navigator))
    return { offer() {}, stop() {}, state: null };
  const visible$ = fromEvent(document, "visibilitychange").pipe(
    startWith(null),
    map(() => document.visibilityState === "visible"),
  );
  const shrink = new CardShrink({
    visible$,
    scheduler,
    gapMs,
    idle,
    shrink: (candidate, signal) =>
      shrinkCard(candidate, {
        fetch,
        signal,
        redraw: (blob) => smallerCard(blob, { document }),
      }),
    onError: (error) => {
      if (globalThis.process?.env?.NODE_TEST_CONTEXT) return;
      console.info(`Pages card image: ${error?.message ?? error}`);
    },
  });
  return {
    offer: (candidate) => shrink.offer(candidate),
    stop: () => shrink.stop(),
    get state() {
      return shrink.state;
    },
  };
}
