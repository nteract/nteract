// Runs heading-links.mjs's scroll machine for the shell. It exists from page
// load, before the editor or a Page session: the address's heading is asked
// for at boot, and the reader scrolling the loading preview calls it off.
// HeadingAnchors (with the open Page) reports the target drawn and runs the
// scroll; this side owns the requests and the reader's intent.
//
// Back and Forward ask for the position the history entry recorded
// (routes.mjs rememberScroll), or its heading when it has none. A load or
// reload asks only for the address's heading, and the browser's own scroll
// restoration (left on "auto") still covers every other screen.
import { EMPTY, filter, fromEvent, merge, switchMap } from "rxjs";
import { readPageRoute, savedScroll } from "../shared/routes.mjs";
import {
  anchorFromHash,
  headingScrollActive,
  headingScrollTransition,
  initialHeadingScroll,
} from "./heading-links.mjs";
import { Store } from "./store.mjs";

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"]);

/** The reader taking over: scrolling with a wheel, touch or keys, typing,
 * or pressing a pointer (a click, or a drag on the scrollbar). */
export function readerIntent(target) {
  const options = { capture: true, passive: true };
  return merge(
    fromEvent(target, "wheel", options),
    fromEvent(target, "touchmove", options),
    fromEvent(target, "pointerdown", options),
    fromEvent(target, "keydown", options).pipe(filter((event) => !MODIFIERS.has(event.key))),
  );
}

/** The Page or Project id an address names, or null. */
export function routeIdOf(href) {
  const route = readPageRoute(href);
  if (route.kind === "page") return route.pageId;
  if (route.kind === "project") return route.projectId;
  return null;
}

export class HeadingScroll {
  store = new Store(initialHeadingScroll);
  #window;
  #history;
  #location;
  #subscription = null;

  constructor({
    window = globalThis.window,
    history = globalThis.history,
    location = globalThis.location,
  } = {}) {
    this.#window = window;
    this.#history = history;
    this.#location = location;
  }

  /** Listen for the reader's intent while a scroll is active, and for
   * Back, Forward and a fragment typed into the address. */
  start() {
    if (this.#subscription) return;
    this.#subscription = this.store
      .select(headingScrollActive)
      .pipe(switchMap((active) => (active ? readerIntent(this.#window) : EMPTY)))
      .subscribe(() => this.dispatch({ type: "userIntent" }));
    this.#subscription.add(
      merge(fromEvent(this.#window, "popstate"), fromEvent(this.#window, "hashchange")).subscribe(
        () => this.requestFromHistory(),
      ),
    );
  }

  stop() {
    this.#subscription?.unsubscribe();
    this.#subscription = null;
  }

  /** Run one event; returns its effects for the caller to run. */
  dispatch(event) {
    const { state, effects } = headingScrollTransition(this.store.snapshot(), event);
    this.store.update(() => state);
    return effects;
  }

  /** Show heading `anchor` of route `routeId` (a Page or Project id). */
  request(routeId, anchor) {
    this.dispatch({
      type: "requested",
      routeId,
      target: anchor ? { kind: "anchor", anchor } : null,
    });
  }

  /** Page load: the address's heading. */
  requestFromAddress() {
    this.request(routeIdOf(this.#location.href), anchorFromHash(this.#location.hash));
  }

  /** Back, Forward or a typed fragment: the entry's recorded position, or
   * else its heading. */
  requestFromHistory() {
    const y = savedScroll({ history: this.#history, location: this.#location });
    const anchor = anchorFromHash(this.#location.hash);
    this.dispatch({
      type: "requested",
      routeId: routeIdOf(this.#location.href),
      target: y !== null ? { kind: "position", y } : anchor ? { kind: "anchor", anchor } : null,
    });
  }

  /** The app opened `routeId` (null: a screen with no Page). */
  navigated(routeId) {
    this.dispatch({ type: "navigated", routeId: routeId ?? null });
  }
}
