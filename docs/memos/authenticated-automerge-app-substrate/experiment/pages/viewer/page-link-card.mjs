// The hover card for links to other Pages (PageLinkCard.jsx draws it). One
// controller per tab watches the document, as HeadingAnchors' click handler
// does, so it covers Page links in Page blocks (editable and read-only), in
// the boot preview and in comments: every link drawn with the Page glyph's
// class and `data-page-id` (link-destination.mjs linkAttributes).
//
// The card follows the page-link-card machine below; RxJS runs its one
// timer. Pointing at a link opens the card after PAGE_LINK_OPEN_MS; keyboard
// focus opens it at once. Leaving the link starts a short grace period, so
// the pointer can cross into the card; entering the card keeps it open.
// Escape closes it and puts focus back on the link. Opening the card asks
// the ref store for the Page's meta and card (page-refs.mjs).
//
// The controller never opens a card while the editor's link menu is open,
// while a mouse button is down (a text selection), for touch or pen input,
// where the device can't hover (`(hover: none)`), for a link inside a card
// preview, or while this tab knows no account.
import { EMPTY, Subject, switchMap, timer } from "rxjs";
import { defineMachine, reject } from "../shared/machine.mjs";
import { linkedPage } from "../shared/page-links.mjs";
import { PAGE_LINK_CLASS } from "./link-destination.mjs";
import { Store } from "./store.mjs";

/** How long the pointer rests on a link before its card opens. */
export const PAGE_LINK_OPEN_MS = 300;
/** How long a card stays after the pointer leaves, to cross into it. */
export const PAGE_LINK_GRACE_MS = 200;
/** The card's root class; links inside it never open another card. */
export const PAGE_LINK_CARD_CLASS = "page-link-card";

const targetOf = (value) => {
  const target = value?.target;
  if (!target || typeof target.pageId !== "string" || typeof target.key !== "string")
    throw Error("needs a target with pageId and key");
  if (target.anchor !== null && typeof target.anchor !== "string")
    throw Error("anchor must be a string or null");
  if (typeof target.href !== "string") throw Error("needs an href");
};
const shown = (state) => {
  targetOf(state);
  if (!["pointer", "focus"].includes(state.via)) throw Error("via must be pointer or focus");
};
const same = (a, b) => a.key === b.key;

/**
 * One tab's Page-link card.
 *
 * States:
 * - closed: no card.
 * - pending: the pointer rests on `target`; the open timer runs.
 * - open: the card for `target` shows. `via` says what opened it: the
 *   pointer, or keyboard focus.
 * - closing: the pointer left the link or the card; the grace timer runs.
 *
 * Events:
 * - `hovered` (`target`): the pointer came onto a Page link.
 * - `focused` (`target`): keyboard focus came onto a Page link.
 * - `left`: the pointer left the link or the card (not for one into the
 *   other's child: the controller filters those).
 * - `blurred`: focus left both the link and the card.
 * - `entered`: the pointer came into the card.
 * - `elapsed`: the timer fired.
 * - `dismissed` (`restore`): Escape, a mouse button going down outside the
 *   card, the link menu opening, or an account change. With `restore`, focus
 *   goes back to the link.
 *
 * Effects: `arm` (`ms`) and `disarm` the timer, `load` (ask the ref store
 * for `pageId`), `restore` (focus the link).
 */
export const pageLinkCardMachine = defineMachine({
  name: "page-link-card",
  states: ["closed", "pending", "open", "closing"],
  events: ["hovered", "focused", "left", "blurred", "entered", "elapsed", "dismissed"],
  initial: { name: "closed" },
  cases: {
    "pending/hovered": ["same", "other"],
    "pending/focused": ["same", "other"],
    "open/hovered": ["same", "other"],
    "open/focused": ["same", "other"],
    "open/left": ["pointer", "focus"],
    "open/blurred": ["pointer", "focus"],
    "open/dismissed": ["restore", "stay"],
    "closing/hovered": ["same", "other"],
    "closing/focused": ["same", "other"],
    "closing/dismissed": ["restore", "stay"],
  },
  validate: {
    states: { pending: targetOf, open: shown, closing: shown },
    events: { hovered: targetOf, focused: targetOf },
    effects: {
      arm: (effect) => {
        if (!(effect.ms > 0)) throw Error("arm needs ms");
      },
      disarm: () => {},
      load: (effect) => {
        if (typeof effect.pageId !== "string") throw Error("load needs a pageId");
      },
      restore: () => {},
    },
  },
  transition(state, event) {
    const pending = (target) => ({
      state: { name: "pending", target },
      effects: [{ type: "arm", ms: PAGE_LINK_OPEN_MS }],
    });
    const open = (target, via, effects = []) => ({
      state: { name: "open", target, via },
      effects: [...effects, { type: "load", pageId: target.pageId }],
    });
    switch (event.type) {
      case "hovered":
        if (state.name === "closed") return pending(event.target);
        if (same(state.target, event.target)) {
          // Back onto the link whose card is closing: keep it.
          if (state.name === "closing")
            return { state: { ...state, name: "open" }, effects: [{ type: "disarm" }] };
          return reject(state, "already on this link");
        }
        // Another link: its own delay, and this card goes.
        return pending(event.target);
      case "focused":
        if (state.name === "closed") return open(event.target, "focus");
        if (state.name === "pending") return open(event.target, "focus", [{ type: "disarm" }]);
        if (same(state.target, event.target)) {
          if (state.name === "closing")
            return {
              state: { ...state, name: "open", via: "focus" },
              effects: [{ type: "disarm" }],
            };
          return reject(state, "already open for this link");
        }
        return open(event.target, "focus", state.name === "closing" ? [{ type: "disarm" }] : []);
      case "left":
        if (state.name === "closed") return reject(state, "nothing to leave");
        if (state.name === "pending")
          return { state: { name: "closed" }, effects: [{ type: "disarm" }] };
        if (state.name === "closing") return reject(state, "already closing");
        // A card keyboard focus opened stays until focus leaves.
        if (state.via === "focus") return reject(state, "focus keeps the card");
        return {
          state: { ...state, name: "closing" },
          effects: [{ type: "arm", ms: PAGE_LINK_GRACE_MS }],
        };
      case "blurred":
        if (state.name !== "open") return reject(state, "focus didn't open this card");
        if (state.via === "pointer") return reject(state, "the pointer keeps the card");
        return { state: { name: "closed" }, effects: [] };
      case "entered":
        if (state.name === "closing")
          return { state: { ...state, name: "open" }, effects: [{ type: "disarm" }] };
        // A card React hasn't removed yet can still report the pointer.
        if (state.name !== "open") return reject(state, "no card is drawn");
        return reject(state, "already open");
      case "elapsed":
        if (state.name === "pending") return open(state.target, "pointer");
        if (state.name === "closing") return { state: { name: "closed" }, effects: [] };
        return reject(state, "no timer is running");
      case "dismissed": {
        if (state.name === "closed") return reject(state, "nothing to dismiss");
        const effects = state.name === "open" ? [] : [{ type: "disarm" }];
        if (event.restore && state.name !== "pending") effects.push({ type: "restore" });
        return { state: { name: "closed" }, effects };
      }
    }
  },
});

/**
 * The Page link `node` is in, as the card targets it: `{ element, pageId,
 * anchor, href }`, or null. Only a link drawn with the Page glyph's class
 * whose `data-page-id` still matches its href, read against `base`, counts,
 * and none inside a card or a card preview.
 */
export function pageLinkAt(node, { base = globalThis.location?.href, currentPageId = null } = {}) {
  const element = node?.closest?.(`a.${PAGE_LINK_CLASS}[data-page-id]`);
  if (!element || element.closest(`.${PAGE_LINK_CARD_CLASS}, .page-card-preview`)) return null;
  const page = linkedPage(element.getAttribute("href"), base, { currentPageId });
  if (!page || page.pageId !== element.dataset.pageId) return null;
  return { element, pageId: page.pageId, anchor: page.anchor, href: element.href };
}

/**
 * The tab's card controller.
 *
 * - `refs`: the tab's PageRefs; opening a card asks it for the Page's meta
 *   and card, and no card opens while it knows no account.
 * - `canHover()`: whether this device hovers; false where `(hover: none)`.
 * - `focusVisible(element)`: whether focus came from the keyboard.
 * - `currentPageId()`: the Page open now, whose own links aren't Page links.
 * - `scheduler`: runs the timer; tests pass a virtual one.
 *
 * `store` holds the machine's state. `attach(document)` starts watching and
 * returns the stop function. The component registers the card's element as
 * `card`.
 */
export class PageLinkCards {
  #links = new Map();
  #keys = new WeakMap();
  #nextKey = 0;
  #timer = new Subject();
  #subscription = null;
  #buttonDown = false;
  /** True while the card gives focus back to its link: that focus is not
   * a reader's ask to open it again. */
  #restoring = false;
  card = null;
  constructor({
    refs,
    canHover = () => !globalThis.matchMedia?.("(hover: none)").matches,
    focusVisible = (element) => {
      try {
        return element.matches(":focus-visible");
      } catch {
        return false;
      }
    },
    currentPageId = () => null,
    scheduler,
  }) {
    this.refs = refs;
    this.canHover = canHover;
    this.focusVisible = focusVisible;
    this.currentPageId = currentPageId;
    this.scheduler = scheduler;
    this.store = new Store(pageLinkCardMachine.initial);
  }

  /** The link element the card is for now, or null. */
  get link() {
    const state = this.store.snapshot();
    return state.target ? (this.#links.get(state.target.key) ?? null) : null;
  }

  /** Step the machine and run its effects. */
  dispatch(event) {
    const result = pageLinkCardMachine.step(this.store.snapshot(), event);
    if (result.rejected) return result;
    const link = this.link;
    const focusInCard = !!this.card?.contains(this.card.ownerDocument?.activeElement);
    this.store.update(() => result.state);
    for (const effect of result.effects) {
      if (effect.type === "arm") this.#timer.next(effect.ms);
      else if (effect.type === "disarm") this.#timer.next(null);
      else if (effect.type === "load")
        this.refs.want(effect.pageId, ["meta", "card"], { urgent: true });
      else if (effect.type === "restore") this.#focusLink(link);
    }
    // A card that closes with focus inside gives it back to its link.
    if (result.state.name === "closed" && focusInCard) this.#focusLink(link);
    // Only the current link's element is kept.
    const key = result.state.target?.key;
    for (const known of this.#links.keys()) if (known !== key) this.#links.delete(known);
    return result;
  }

  #focusLink(link) {
    if (!link || link.ownerDocument?.activeElement === link) return;
    this.#restoring = true;
    try {
      link.focus({ preventScroll: true });
    } finally {
      this.#restoring = false;
    }
  }

  /** The machine target for a link found by pageLinkAt. */
  #target(found) {
    let key = this.#keys.get(found.element);
    if (!key) {
      key = `link-${++this.#nextKey}`;
      this.#keys.set(found.element, key);
    }
    this.#links.set(key, found.element);
    return { key, pageId: found.pageId, anchor: found.anchor, href: found.href };
  }

  /** Whether a card may open now (see the module comment). */
  #allowed(document) {
    return (
      !!this.refs.principal &&
      !this.#buttonDown &&
      this.canHover() &&
      !document.querySelector(".link-popover")
    );
  }

  #find(node) {
    return pageLinkAt(node, { currentPageId: this.currentPageId() });
  }

  #inCard(node) {
    return !!node && !!this.card?.contains(node);
  }

  /** Watch `document` for Page links. Returns the stop function. */
  attach(document) {
    this.#subscription = this.#timer
      .pipe(switchMap((ms) => (ms === null ? EMPTY : timer(ms, this.scheduler))))
      .subscribe(() => this.dispatch({ type: "elapsed" }));
    const hoverInput = (event) => event.pointerType === "mouse" || event.pointerType === undefined;
    const over = (event) => {
      if (!hoverInput(event)) return;
      if (this.#inCard(event.target)) return void this.dispatch({ type: "entered" });
      const found = this.#find(event.target);
      if (!found || event.buttons || !this.#allowed(document)) return;
      this.dispatch({ type: "hovered", target: this.#target(found) });
    };
    const out = (event) => {
      if (!hoverInput(event)) return;
      // Someone tabbed into the card: the pointer leaving doesn't close it.
      if (this.#inCard(event.target.ownerDocument?.activeElement)) return;
      const to = event.relatedTarget;
      if (this.#inCard(event.target)) {
        if (!this.#inCard(to)) this.dispatch({ type: "left" });
        return;
      }
      const found = this.#find(event.target);
      if (found && !found.element.contains(to)) this.dispatch({ type: "left" });
    };
    const focusIn = (event) => {
      if (this.#restoring || this.#inCard(event.target)) return;
      const found = this.#find(event.target);
      if (!found) return;
      // Keyboard focus only: a click that focuses a link follows it.
      if (!this.focusVisible(found.element) || !this.#allowed(document)) return;
      this.dispatch({ type: "focused", target: this.#target(found) });
    };
    const focusOut = (event) => {
      const to = event.relatedTarget;
      if (this.#inCard(to) || (to && this.link?.contains(to))) return;
      if (this.#inCard(event.target) || this.link?.contains(event.target))
        this.dispatch({ type: "blurred" });
    };
    const keyDown = (event) => {
      if (event.key !== "Escape" || this.store.snapshot().name === "closed") return;
      const inCard = this.#inCard(event.target);
      const restore = inCard || this.store.snapshot().via === "focus";
      if (inCard) {
        event.preventDefault();
        event.stopPropagation();
      }
      this.dispatch({ type: "dismissed", restore });
    };
    const down = (event) => {
      if (this.#inCard(event.target)) return;
      if (event.pointerType === "mouse") this.#buttonDown = true;
      this.dispatch({ type: "dismissed", restore: false });
    };
    const up = () => {
      this.#buttonDown = false;
    };
    const listeners = [
      ["pointerover", over],
      ["pointerout", out],
      ["focusin", focusIn],
      ["focusout", focusOut],
      ["keydown", keyDown, true],
      ["pointerdown", down, true],
      ["pointerup", up, true],
      ["pointercancel", up, true],
    ];
    for (const [type, listener, capture] of listeners)
      document.addEventListener(type, listener, capture);
    // A changed account closes the card; its answers belong to the old one.
    const account = this.refs.store
      .select((state) => state.principal)
      .subscribe(() => this.dispatch({ type: "dismissed", restore: false }));
    return () => {
      for (const [type, listener, capture] of listeners)
        document.removeEventListener(type, listener, capture);
      account.unsubscribe();
      this.#subscription?.unsubscribe();
      this.#subscription = null;
      this.dispatch({ type: "dismissed", restore: false });
    };
  }
}
