// The owner's tab draws its Page's grid card images (worker/card-images.mjs).
//
// When the `card_hash` of the local document (model/page-card.mjs, the same
// code the Page host runs) differs from the stored image's, and the tab is
// visible and has had no edit or input for CARD_CAPTURE_IDLE_MS, the tab renders the
// card shell offscreen (card-shell.mjs, loaded on first use with its
// rasterizer) in light and dark and uploads both. A capture that starts
// begins a CARD_CAPTURE_REST_MS rest, so a Page captures at most once per
// rest however much it changes. Only one capture runs at a time; a change to
// the first screen, a hidden tab or leaving the Page cancels it, and so does
// input, which also gives back the rest.
//
// The stored image's hash comes from one `GET /api/pages/:id/card-image`
// when the Page opens, then from each upload's answer: no request per edit.
//
// A tab never captures on Save-Data, on a device reporting under 2 GB of
// memory, or for anyone but the Page's owner with write access. Every timer
// runs through an RxJS scheduler, so tests drive it on virtual time.
import {
  EMPTY,
  Subject,
  Subscription,
  debounceTime,
  fromEvent,
  merge,
  switchMap,
  throttleTime,
  timer,
} from "rxjs";
import { defineMachine, reject } from "../shared/machine.mjs";

/** Quiet time after the last change before a capture starts. */
export const CARD_CAPTURE_IDLE_MS = 3_000;
/** The shortest gap between two captures' starts. */
export const CARD_CAPTURE_REST_MS = 120_000;
/** How long the local hash waits for typing to pause before it's rebuilt. */
export const CARD_HASH_DEBOUNCE_MS = 1_000;
/** Below this `navigator.deviceMemory` (GB), a tab never captures. */
export const CARD_CAPTURE_MIN_MEMORY_GB = 2;

const HASH = /^[0-9a-f]{64}$/;
const hashOrNull = (value, label) => {
  if (value !== null && !(typeof value === "string" && HASH.test(value)))
    throw Error(`${label} must be a card hash or null`);
};
const context = (state) => {
  hashOrNull(state.hash, "hash");
  hashOrNull(state.stored, "stored");
  for (const flag of ["known", "visible", "resting"])
    if (typeof state[flag] !== "boolean") throw Error(`${flag} must be a boolean`);
};
const quiet = (state) => {
  context(state);
  if ("target" in state) throw Error(`${state.name} has no capture target`);
};

/** Whether a capture should wait for quiet: there is something new to draw
 * and nothing holds it back. */
export const wantsCapture = (state) =>
  state.visible &&
  !state.resting &&
  state.known &&
  state.hash !== null &&
  state.hash !== state.stored;

/** Settle an idle or waiting state (no capture running) after its context
 * changed. `rearm` restarts a running quiet timer: something changed. */
function settle(state, effects, { rearm = false } = {}) {
  const { target: _target, ...rest } = state;
  if (wantsCapture(rest)) {
    if (rest.name !== "waiting" || rearm) effects.push({ type: "arm" });
    return { ...rest, name: "waiting" };
  }
  if (rest.name === "waiting") effects.push({ type: "disarm" });
  return { ...rest, name: "idle" };
}

/**
 * One Page's capture schedule.
 *
 * Every state carries `hash` (the local card hash, null while the first
 * screen is empty or not built yet), `stored` (the stored image's hash, null
 * when none), `known` (whether `stored` has been learned), `visible` (the
 * tab is visible and its account may capture), and `resting` (a capture
 * started less than CARD_CAPTURE_REST_MS ago).
 *
 * States: idle (nothing to do, or something holds it back), waiting (the
 * quiet timer runs), capturing (`target` is the hash being drawn), stopped
 * (the Page closed; terminal).
 *
 * Events: `changed` (the local hash was rebuilt after a change, `hash`),
 * `stored` (the stored hash, `hash`), `visible`, `hidden`, `input` (the
 * person pointed, typed, wheeled or scrolled), `elapsed` (the
 * quiet timer fired), `captured` (`target` uploaded; `stored` is the
 * server's answer), `failed` (`target` didn't upload), `rested` (the rest
 * ended), `stop`.
 *
 * Effects: `arm` and `disarm` the quiet timer, `capture` (`hash`), `cancel`
 * the running capture, `rest` (start the rest timer), `unrest` (drop it).
 */
export const cardCaptureMachine = defineMachine({
  name: "card-capture",
  states: ["idle", "waiting", "capturing", "stopped"],
  events: [
    "changed",
    "stored",
    "visible",
    "hidden",
    "input",
    "elapsed",
    "captured",
    "failed",
    "rested",
    "stop",
  ],
  initial: {
    name: "idle",
    hash: null,
    stored: null,
    known: false,
    visible: false,
    resting: false,
  },
  cases: {
    "idle/changed": ["holds", "wants"],
    "waiting/changed": ["rearm", "settles"],
    "capturing/changed": ["same", "moved"],
    "idle/stored": ["holds", "wants"],
    "waiting/stored": ["wants", "current"],
    "idle/visible": ["holds", "wants"],
    "idle/rested": ["holds", "wants", "unrested"],
    "capturing/captured": ["mine", "stale"],
    "capturing/failed": ["mine", "stale"],
  },
  validate: {
    states: {
      idle: quiet,
      waiting: (state) => {
        quiet(state);
        if (!wantsCapture(state)) throw Error("waiting needs something to capture");
      },
      capturing: (state) => {
        context(state);
        hashOrNull(state.target, "target");
        if (state.target === null) throw Error("capturing needs a target");
      },
      stopped: quiet,
    },
    events: {
      changed: (event) => hashOrNull(event.hash, "hash"),
      stored: (event) => hashOrNull(event.hash, "hash"),
      captured: (event) => {
        hashOrNull(event.target, "target");
        hashOrNull(event.stored, "stored");
      },
      failed: (event) => hashOrNull(event.target, "target"),
    },
    effects: {
      arm: () => {},
      disarm: () => {},
      capture: (effect) => hashOrNull(effect.hash, "hash"),
      cancel: () => {},
      rest: () => {},
      unrest: () => {},
    },
  },
  transition(state, event) {
    const effects = [];
    if (state.name === "stopped") return reject(state, "stopped");
    switch (event.type) {
      case "changed": {
        if (state.name === "capturing") {
          if (event.hash === state.target)
            return { state: { ...state, hash: event.hash }, effects };
          // The first screen moved on: this capture would be stale.
          effects.push({ type: "cancel" });
          return { state: settle({ ...state, name: "idle", hash: event.hash }, effects), effects };
        }
        return { state: settle({ ...state, hash: event.hash }, effects, { rearm: true }), effects };
      }
      case "stored": {
        const next = { ...state, stored: event.hash, known: true };
        if (state.name === "capturing") return { state: next, effects };
        return { state: settle(next, effects), effects };
      }
      case "visible":
        if (state.name === "capturing") return reject(state, "already visible");
        return { state: settle({ ...state, visible: true }, effects), effects };
      case "hidden": {
        if (state.name === "capturing") {
          effects.push({ type: "cancel" });
          return { state: settle({ ...state, name: "idle", visible: false }, effects), effects };
        }
        return { state: settle({ ...state, visible: false }, effects), effects };
      }
      case "input":
        // Quiet means no input either: a pointer, key, wheel or scroll
        // restarts the wait, and stops a capture before its rasterizing
        // lands in the middle of the interaction. The cancelled capture
        // doesn't count against the rest.
        if (state.name === "waiting") {
          effects.push({ type: "arm" });
          return { state, effects };
        }
        if (state.name === "capturing") {
          effects.push({ type: "cancel" }, { type: "unrest" });
          const next = { ...state, name: "idle", resting: false };
          return { state: settle(next, effects, { rearm: true }), effects };
        }
        return reject(state, "nothing waits for quiet");
      case "elapsed":
        // A timer that fired as the state moved on.
        if (state.name !== "waiting") return reject(state, "no quiet timer is running");
        effects.push({ type: "capture", hash: state.hash }, { type: "rest" });
        return {
          state: { ...state, name: "capturing", target: state.hash, resting: true },
          effects,
        };
      case "captured":
      case "failed": {
        if (state.name !== "capturing" || event.target !== state.target)
          return reject(state, "not this capture");
        const next =
          event.type === "captured"
            ? { ...state, name: "idle", stored: event.stored, known: true }
            : { ...state, name: "idle" };
        return { state: settle(next, effects), effects };
      }
      case "rested": {
        if (!state.resting) return reject(state, "not resting");
        if (state.name === "capturing") return { state: { ...state, resting: false }, effects };
        return { state: settle({ ...state, resting: false }, effects), effects };
      }
      case "stop":
        if (state.name === "waiting") effects.push({ type: "disarm" });
        if (state.name === "capturing") effects.push({ type: "cancel" });
        return {
          state: {
            name: "stopped",
            hash: state.hash,
            stored: state.stored,
            known: state.known,
            visible: false,
            resting: state.resting,
          },
          effects,
        };
    }
  },
});

/** Whether this device should ever capture: not on Save-Data, and not on a
 * device that reports little memory. */
export function captureAllowed(browser = globalThis.navigator) {
  if (browser?.connection?.saveData === true) return false;
  const memory = browser?.deviceMemory;
  return !(typeof memory === "number" && memory < CARD_CAPTURE_MIN_MEMORY_GB);
}

/**
 * The machine with its effects at the edge.
 *
 * - `hashes$`: an Observable of the local card hash (null while empty).
 * - `visible$`: an Observable of whether the tab may capture now.
 * - `input$`: an Observable that emits on the person's input.
 * - `readStored()`: resolves with the stored image's hash, or null.
 * - `capture(hash, signal)`: draws and uploads both themes; resolves with
 *   the server's stored hash. It must stop when `signal` aborts.
 * - `scheduler`: the RxJS scheduler for both timers.
 */
export class CardCapture {
  state = cardCaptureMachine.initial;
  #idle = new Subject();
  #rest = new Subject();
  #subscription = new Subscription();
  #abort = null;
  /** The running or last capture, so a new one starts only after it ends. */
  #running = Promise.resolve();
  constructor({
    hashes$,
    visible$,
    input$ = EMPTY,
    readStored,
    capture,
    scheduler,
    idleMs = CARD_CAPTURE_IDLE_MS,
    restMs = CARD_CAPTURE_REST_MS,
    onError = () => {},
  }) {
    this.capture = capture;
    this.onError = onError;
    this.#subscription.add(
      this.#idle
        .pipe(switchMap((armed) => (armed ? timer(idleMs, scheduler) : EMPTY)))
        .subscribe(() => this.dispatch({ type: "elapsed" })),
    );
    this.#subscription.add(
      this.#rest
        .pipe(switchMap((resting) => (resting ? timer(restMs, scheduler) : EMPTY)))
        .subscribe(() => this.dispatch({ type: "rested" })),
    );
    this.#subscription.add(hashes$.subscribe((hash) => this.dispatch({ type: "changed", hash })));
    this.#subscription.add(
      visible$.subscribe((visible) => this.dispatch({ type: visible ? "visible" : "hidden" })),
    );
    this.#subscription.add(input$.subscribe(() => this.dispatch({ type: "input" })));
    Promise.resolve()
      .then(readStored)
      .then(
        (hash) => this.dispatch({ type: "stored", hash: HASH.test(hash ?? "") ? hash : null }),
        (error) => this.onError(error),
      );
  }

  dispatch(event) {
    const result = cardCaptureMachine.step(this.state, event);
    if (result.rejected) return result;
    this.state = result.state;
    for (const effect of result.effects) this.#run(effect);
    return result;
  }

  /** Leave the Page: cancel a running capture and every timer. */
  stop() {
    this.dispatch({ type: "stop" });
    this.#subscription.unsubscribe();
  }

  #run(effect) {
    switch (effect.type) {
      case "arm":
        return this.#idle.next(true);
      case "disarm":
        return this.#idle.next(false);
      case "rest":
        return this.#rest.next(true);
      case "unrest":
        return this.#rest.next(false);
      case "cancel":
        this.#abort?.abort();
        this.#abort = null;
        return;
      case "capture": {
        const abort = new AbortController();
        this.#abort = abort;
        const target = effect.hash;
        const previous = this.#running;
        this.#running = previous.then(async () => {
          if (abort.signal.aborted) return;
          try {
            const stored = await this.capture(target, abort.signal);
            if (abort.signal.aborted) return;
            this.dispatch({
              type: "captured",
              target,
              stored: HASH.test(stored ?? "") ? stored : null,
            });
          } catch (error) {
            if (abort.signal.aborted) return;
            this.onError(error);
            this.dispatch({ type: "failed", target });
          }
        });
        return;
      }
    }
  }
}

/** Input that means someone is using the tab. Pointer moves don't count. */
const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"];
/** At most one `input` event per this many ms reaches the machine. */
const INPUT_THROTTLE_MS = 250;

/**
 * Capture `session`'s card images while this tab shows the Page to its
 * owner. Returns the stop function. `session` is a PageSession: its `doc`,
 * `pageId`, `access`, `canWrite`, `hidden` and `subscribe`, and the `views`
 * and `pageSources` the shell draws charts from.
 *
 * Until the session first shows the owner's write access, this only watches
 * for it: a reader's or editor's tab never hashes, reads the stored image's
 * hash or loads the shell.
 */
export function captureCards(
  session,
  {
    browser = globalThis,
    fetch = globalThis.fetch?.bind(globalThis),
    scheduler,
    loadShell = () => import("./card-shell.mjs"),
    loadModel = () => import("../model/page-card.mjs"),
  } = {},
) {
  const document = browser.document;
  if (!document || !fetch || !captureAllowed(browser.navigator)) return () => {};
  const pageId = session.pageId;
  const eligible = () =>
    session.access?.role === "owner" && session.canWrite !== false && !session.hidden;
  const docs = new Subject();
  const visible = new Subject();
  const subscription = new Subscription();
  let capture = null;
  let lastDoc = null;
  let lastVisible = null;
  let model;
  const hashOf = async (doc) => {
    model ??= await loadModel();
    const card = await model.pageCard(doc);
    return card.blocks.length ? card.card_hash : null;
  };
  const start = () => {
    const hashes = new Subject();
    subscription.add(
      docs
        .pipe(
          debounceTime(CARD_HASH_DEBOUNCE_MS, scheduler),
          switchMap((doc) => hashOf(doc).catch(() => null)),
        )
        .subscribe((hash) => hashes.next(hash)),
    );
    const input$ = merge(
      ...INPUT_EVENTS.map((type) => fromEvent(document, type, { capture: true, passive: true })),
    ).pipe(throttleTime(INPUT_THROTTLE_MS, scheduler));
    return new CardCapture({
      hashes$: hashes,
      visible$: visible,
      input$,
      scheduler,
      readStored: async () => {
        const response = await fetch(`/api/pages/${pageId}/card-image`);
        if (!response.ok) throw Error(`card image state answered ${response.status}`);
        return (await response.json()).card_hash ?? null;
      },
      capture: async (hash, signal) => {
        const shell = await loadShell();
        const doc = session.doc;
        if (!doc || signal.aborted) throw Error("The Page closed");
        // The document may have moved on since the hash was built; draw only
        // the first screen that hash names.
        if ((await hashOf(doc)) !== hash) throw Error("The first screen changed");
        const images = await shell.renderCardImages({
          doc,
          pageId,
          signal,
          views: session.views ?? null,
          sources: session.pageSources ?? null,
        });
        let stored = null;
        for (const image of images) {
          signal.throwIfAborted();
          const response = await fetch(
            `/api/pages/${pageId}/card-image?hash=${hash}&theme=${image.theme}`,
            {
              method: "PUT",
              headers: { "Content-Type": image.blob.type },
              body: image.blob,
              signal,
            },
          );
          if (!response.ok) throw Error(`card image upload answered ${response.status}`);
          stored = (await response.json()).card_hash ?? null;
        }
        return stored;
      },
      onError: (error) => {
        if (globalThis.process?.env?.NODE_TEST_CONTEXT) return;
        console.info(`Pages card image: ${error?.message ?? error}`);
      },
    });
  };
  const report = () => {
    if (!capture) {
      if (!eligible()) return;
      capture = start();
    }
    const doc = session.doc;
    if (doc && doc !== lastDoc) {
      lastDoc = doc;
      docs.next(doc);
    }
    const now = document.visibilityState === "visible" && eligible();
    if (now !== lastVisible) {
      lastVisible = now;
      visible.next(now);
    }
  };
  const unsubscribe = session.subscribe(report);
  subscription.add(fromEvent(document, "visibilitychange").subscribe(report));
  // A Page kept in the back/forward cache comes back with its capture: its
  // tab is hidden meanwhile, which already holds or cancels the capture.
  const leave = (event) => {
    if (!event?.persisted) capture?.stop();
  };
  browser.addEventListener?.("pagehide", leave);
  report();
  return () => {
    browser.removeEventListener?.("pagehide", leave);
    unsubscribe();
    subscription.unsubscribe();
    capture?.stop();
  };
}
