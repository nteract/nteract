// Interprets editor-start-machine.mjs in the browser: reads the boot route,
// watches a listing for its first rows and for intent, and asks for the
// editor when the machine says so.
import { editorStartMachine } from "./editor-start-machine.mjs";

/** A listing's rows: the library's list rows and grid cards, and /projects'
 * rows. The first one in the document means the listing has drawn. */
export const FIRST_ROWS = ".index-row-link, .index-card-link";
/** What a person reaches for to open or start a Page: a row link, New Page,
 * the Page switcher and its rows. */
export const INTENT_TARGETS = [
  ".index-row-link",
  ".index-card-link",
  ".library-actions .primary",
  ".pages-trigger",
  ".picker-page",
  ".picker-create",
].join(", ");
// Events that show intent before a click: hover, a touch or press, and
// keyboard focus.
const INTENT_EVENTS = Object.freeze(["pointerover", "pointerdown", "focusin"]);
/** The longest the editor waits for an idle period once the rows painted. */
export const IDLE_TIMEOUT_MS = 2_000;
/** Where there is no requestIdleCallback (Safari), the wait after the rows
 * painted. */
export const IDLE_FALLBACK_MS = 300;

export class EditorStart {
  #state = editorStartMachine.initial;
  #win;
  #start;
  #stops = [];
  /** `start` asks the loader for the editor; it runs at most once. `win` is
   * the window whose document is watched. */
  constructor({ start, win = globalThis.window }) {
    this.#start = start;
    this.#win = win;
  }
  get state() {
    return this.#state;
  }
  /** Read the route the tab booted on (shared/routes.mjs `kind`). */
  boot(route) {
    this.#dispatch({ type: "boot", route });
  }
  /** Something that opens a Page was pointed at or focused. */
  intent() {
    this.#dispatch({ type: "intent" });
  }
  #dispatch(event) {
    const result = editorStartMachine.step(this.#state, event);
    if (result.rejected) return;
    this.#state = result.state;
    for (const effect of result.effects) {
      if (effect.type === "watch") this.#watch();
      else if (effect.type === "idle") this.#requestIdle();
      else if (effect.type === "start") this.#start();
      else if (effect.type === "stop") for (const stop of this.#stops.splice(0)) stop();
      else throw new Error(`unknown effect ${effect.type}`);
    }
  }
  #watch() {
    const win = this.#win;
    const page = win?.document;
    if (!page) return;
    const onIntent = (event) => {
      if (event.target?.closest?.(INTENT_TARGETS)) this.intent();
    };
    for (const type of INTENT_EVENTS) page.addEventListener(type, onIntent, true);
    this.#stops.push(() => {
      for (const type of INTENT_EVENTS) page.removeEventListener(type, onIntent, true);
    });
    // One shot: it reports the first rows once, a frame after they are in
    // the document, and disconnects.
    let frame = null;
    const observer = new win.MutationObserver(() => {
      if (!page.querySelector(FIRST_ROWS)) return;
      observer.disconnect();
      frame = win.requestAnimationFrame(() => {
        frame = null;
        this.#dispatch({ type: "painted" });
      });
    });
    observer.observe(page.documentElement, { childList: true, subtree: true });
    this.#stops.push(() => {
      observer.disconnect();
      if (frame !== null) win.cancelAnimationFrame(frame);
    });
  }
  #requestIdle() {
    const win = this.#win;
    const idle = () => this.#dispatch({ type: "idle" });
    if (typeof win.requestIdleCallback === "function") {
      const id = win.requestIdleCallback(idle, { timeout: IDLE_TIMEOUT_MS });
      this.#stops.push(() => win.cancelIdleCallback?.(id));
    } else {
      const id = win.setTimeout(idle, IDLE_FALLBACK_MS);
      this.#stops.push(() => win.clearTimeout(id));
    }
  }
}
