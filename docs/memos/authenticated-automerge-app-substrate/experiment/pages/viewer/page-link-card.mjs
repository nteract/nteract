// The hover card for links to other Pages (PageLinkCard.jsx draws it). One
// controller per tab watches the document, as HeadingAnchors' click handler
// does, so it covers Page links in Page blocks (editable and read-only), in
// the boot preview and in comments: every link drawn with the Page glyph's
// class and `data-page-id` (link-destination.mjs linkAttributes).
//
// The card follows the page-link-card machine below; RxJS runs its one
// timer. Pointing at a link opens the card after PAGE_LINK_OPEN_MS. Leaving
// the link starts a short grace period, so the pointer can cross into the
// card; entering the card keeps it open. Opening the card asks the ref store
// for the Page's meta and card (page-refs.mjs).
//
// Keyboard focus on a link opens its card at once. Only a link that takes
// focus can do this: links in read-only blocks, comments and the loading
// preview. In an editable block focus stays on the editor, so a caret
// entering a link opens nothing. From a focused link, Tab moves into the
// card's actions; Shift-Tab from the first goes back to the link, and Tab
// past the last closes the card and moves on to whatever follows the link.
// A polite live region, owned by the controller, announces the Page's title,
// or "Page unavailable", once a keyboard-opened card's answer loads.
//
// Escape closes the card, and nothing else: the event is marked handled and
// stopped, so a comments panel doesn't also back out of its thread. Focus
// goes back to the link, or to the editor when the link is editable content.
// Using either action closes the card. Pointer-opened cards also close on a
// keypress (other than Tab, Escape or a lone modifier) and when the editor's
// link menu opens (link-menu.mjs).
//
// The controller never opens a card while a link menu is open, while a
// mouse button is down (a text selection), for touch or pen input, where
// the device can't hover (`(hover: none)`), for a link inside a card
// preview, or while this tab knows no account.
//
// A link whose text is formatted draws as one element in the editor
// (PagesLink's rank, model/wordgard-doc.mjs) and in the preview
// (PagePreview.jsx). Should it ever draw as several sibling fragments, the
// contiguous fragments with one href are one link here (linkRun): one
// target, and crossing between them keeps the card.
import { EMPTY, Subject, combineLatest, distinctUntilChanged, map, switchMap, timer } from "rxjs";
import { defineMachine, reject } from "../shared/machine.mjs";
import { linkedPage } from "../shared/page-links.mjs";
import { returnFocus } from "./editor-focus.mjs";
import { PAGE_LINK_CLASS } from "./link-destination.mjs";
import { linkMenus } from "./link-menu.mjs";
import { settledOf } from "./page-refs.mjs";
import { Store } from "./store.mjs";

/** How long the pointer rests on a link before its card opens. */
export const PAGE_LINK_OPEN_MS = 300;
/** How long a card stays after the pointer leaves, to cross into it. */
export const PAGE_LINK_GRACE_MS = 200;
/** The card's root class; links inside it never open another card. */
export const PAGE_LINK_CARD_CLASS = "page-link-card";
/** Where comment links live: their card offers only Open in new tab, as the
 * links themselves do, so a comment draft is never navigated away from. */
export const COMMENT_LINK_SCOPE = ".comment-rich-editor, .comment-rich-content";

const targetOf = (value) => {
  const target = value?.target;
  if (!target || typeof target.pageId !== "string" || typeof target.key !== "string")
    throw Error("needs a target with pageId and key");
  if (target.anchor !== null && typeof target.anchor !== "string")
    throw Error("anchor must be a string or null");
  if (typeof target.href !== "string") throw Error("needs an href");
  if (typeof target.comment !== "boolean") throw Error("comment must be a boolean");
};
const shown = (state) => {
  targetOf(state);
  if (!["pointer", "focus"].includes(state.via)) throw Error("via must be pointer or focus");
  if (typeof state.held !== "boolean") throw Error("held must be a boolean");
};
const same = (a, b) => a.key === b.key;

/**
 * One tab's Page-link card.
 *
 * States:
 * - closed: no card.
 * - pending: the pointer rests on `target`; the open timer runs.
 * - open: the card for `target` shows. `via` says what opened it: the
 *   pointer, or keyboard focus on the link. `held` says keyboard focus is in
 *   the card, which keeps a pointer-opened card when the pointer leaves.
 * - closing: the pointer left the link or a pointer-opened card that holds
 *   no keyboard focus; the grace timer runs.
 *
 * Events:
 * - `hovered` (`target`): the pointer came onto a Page link.
 * - `focused` (`target`): keyboard focus came onto a Page link.
 * - `left`: the pointer left the link or the card (not for one into the
 *   other or between fragments of one link: the controller filters those).
 * - `blurred`: focus left both the link and the card.
 * - `entered`: the pointer came into the card.
 * - `cardFocused` (`keyboard`): focus moved into the card, from the
 *   keyboard or not (a click on one of its buttons).
 * - `acted`: one of the card's actions was used.
 * - `elapsed`: the timer fired.
 * - `dismissed` (`restore`): Escape, a mouse button going down outside the
 *   card, a keypress on a pointer-opened card, the link menu opening, Tab
 *   past the card's last action, or an account change. With `restore`,
 *   focus goes back to the link.
 *
 * Effects: `arm` (`ms`) and `disarm` the timer, `load` (ask the ref store
 * for `pageId`), `restore` (give focus back to the link, or its editor).
 */
export const pageLinkCardMachine = defineMachine({
  name: "page-link-card",
  states: ["closed", "pending", "open", "closing"],
  events: [
    "hovered",
    "focused",
    "left",
    "blurred",
    "entered",
    "cardFocused",
    "acted",
    "elapsed",
    "dismissed",
  ],
  initial: { name: "closed" },
  cases: {
    "pending/hovered": ["same", "other"],
    "pending/focused": ["same", "other"],
    "open/hovered": ["same", "other", "held"],
    "open/focused": ["same-pointer", "same-held", "same-focus", "other"],
    "open/left": ["pointer", "held", "focus"],
    "open/blurred": ["focus", "held", "pointer"],
    "open/cardFocused": ["keyboard", "already-held", "pointer"],
    "open/dismissed": ["restore", "stay"],
    "closing/hovered": ["same", "other"],
    "closing/focused": ["same", "other"],
    "closing/cardFocused": ["keyboard", "pointer"],
    "closing/dismissed": ["restore", "stay"],
  },
  validate: {
    states: {
      pending: targetOf,
      open: shown,
      closing: (state) => {
        shown(state);
        if (state.via !== "pointer" || state.held)
          throw Error("only a pointer-opened card holding no focus closes on a timer");
      },
    },
    events: {
      hovered: targetOf,
      focused: targetOf,
      cardFocused: (event) => {
        if (typeof event.keyboard !== "boolean") throw Error("keyboard must be a boolean");
      },
    },
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
      state: { name: "open", target, via, held: false },
      effects: [...effects, { type: "load", pageId: target.pageId }],
    });
    const reopen = (changes, effects = []) => ({
      state: { ...state, name: "open", ...changes },
      effects,
    });
    switch (event.type) {
      case "hovered":
        if (state.name === "closed") return pending(event.target);
        if (same(state.target, event.target)) {
          // Back onto the link whose card is closing: keep it.
          if (state.name === "closing") return reopen({}, [{ type: "disarm" }]);
          return reject(state, "already on this link");
        }
        // Keyboard focus in the card keeps it from a passing pointer.
        if (state.name === "open" && state.held)
          return reject(state, "keyboard focus keeps the card");
        // Another link: its own delay, and this card goes.
        return pending(event.target);
      case "focused":
        if (state.name === "closed") return open(event.target, "focus");
        if (state.name === "pending") return open(event.target, "focus", [{ type: "disarm" }]);
        if (same(state.target, event.target)) {
          if (state.name === "closing") return reopen({ via: "focus" }, [{ type: "disarm" }]);
          // The link the pointer opened the card for now has focus, or focus
          // came back to it from the card.
          if (state.via === "pointer") return reopen({ via: "focus", held: false });
          if (state.held) return reopen({ held: false });
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
        if (state.held) return reject(state, "keyboard focus keeps the card");
        return {
          state: { ...state, name: "closing" },
          effects: [{ type: "arm", ms: PAGE_LINK_GRACE_MS }],
        };
      case "blurred":
        if (state.name !== "open") return reject(state, "focus didn't open this card");
        if (state.via === "focus") return { state: { name: "closed" }, effects: [] };
        if (state.held) return reopen({ held: false });
        return reject(state, "the pointer keeps the card");
      case "entered":
        if (state.name === "closing") return reopen({}, [{ type: "disarm" }]);
        // A card React hasn't removed yet can still report the pointer.
        if (state.name !== "open") return reject(state, "no card is drawn");
        return reject(state, "already open");
      case "cardFocused":
        if (state.name !== "open" && state.name !== "closing")
          return reject(state, "no card is drawn");
        if (!event.keyboard) return reject(state, "only keyboard focus holds the card");
        if (state.name === "closing") return reopen({ held: true }, [{ type: "disarm" }]);
        if (state.held) return reject(state, "already held");
        return reopen({ held: true });
      case "acted":
        if (state.name !== "open" && state.name !== "closing")
          return reject(state, "no card is drawn");
        return {
          state: { name: "closed" },
          effects: [...(state.name === "closing" ? [{ type: "disarm" }] : []), { type: "restore" }],
        };
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

/** The block a link's text lives in: fragments of one link never cross it. */
const TEXTBLOCK = "p, li, h1, h2, h3, h4, h5, h6, td, th, pre, figcaption, wg-content";

/** The fragments `element` draws its link with, in order: the contiguous
 * Page links in its textblock with the same href and no text between. */
export function linkRun(element) {
  const block = element.closest(TEXTBLOCK) ?? element.parentElement;
  if (!block) return [element];
  const links = [...block.querySelectorAll(`a.${PAGE_LINK_CLASS}[data-page-id]`)];
  const href = element.getAttribute("href");
  const adjacent = (before, after) => {
    if (after.getAttribute("href") !== href) return false;
    const range = element.ownerDocument.createRange();
    range.setStartAfter(before);
    range.setEndBefore(after);
    return range.toString() === "";
  };
  let start = links.indexOf(element);
  if (start < 0) return [element];
  let end = start;
  while (start > 0 && adjacent(links[start - 1], links[start])) start--;
  while (end < links.length - 1 && adjacent(links[end], links[end + 1])) end++;
  return links.slice(start, end + 1);
}

/**
 * The Page link `node` is in, as the card targets it: `{ element, elements,
 * pageId, anchor, href, comment }`, or null. `elements` is the link's run of
 * fragments (linkRun) and `element` its first. Only a link drawn with the
 * Page glyph's class counts, and the Page is always the one its href names,
 * read against `base`: a `data-page-id` that disagrees with it (a stale or
 * forged attribute) makes the link no target. None inside a card or a card
 * preview. `comment` says the link is in a comment.
 */
export function pageLinkAt(node, { base = globalThis.location?.href, currentPageId = null } = {}) {
  const element = node?.closest?.(`a.${PAGE_LINK_CLASS}[data-page-id]`);
  if (!element || element.closest(`.${PAGE_LINK_CARD_CLASS}, .page-card-preview`)) return null;
  const page = linkedPage(element.getAttribute("href"), base, { currentPageId });
  if (!page || page.pageId !== element.dataset.pageId) return null;
  const elements = linkRun(element);
  return {
    element: elements[0],
    elements,
    pageId: page.pageId,
    anchor: page.anchor,
    href: element.href,
    comment: !!element.closest(COMMENT_LINK_SCOPE),
  };
}

/** Elements Tab can reach, roughly as the browser orders them. */
const TABBABLE = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled):not([type='hidden'])",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "summary",
  "[contenteditable='true']",
  "[tabindex]",
].join(", ");

/** The first element Tab would reach after `link`, outside `card`. */
export function nextTabbable(link, card) {
  for (const element of link.ownerDocument.querySelectorAll(TABBABLE)) {
    if (element.tabIndex < 0 || card?.contains(element) || link.contains(element)) continue;
    if (element.closest("[hidden], [inert]") || element.checkVisibility?.() === false) continue;
    if (link.compareDocumentPosition(element) & element.DOCUMENT_POSITION_FOLLOWING) return element;
  }
  return null;
}

/** Keys that never close a pointer-opened card on their own. */
const QUIET_KEYS = new Set([
  "Tab",
  "Escape",
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "OS",
  "CapsLock",
  "Fn",
  "FnLock",
  "Hyper",
  "Super",
]);

/** What the live region says for a keyboard-opened card: the title once it
 * loads, "Page unavailable", or a failure; null while it loads. */
export function announcement(meta) {
  const settled = settledOf(meta);
  if (settled?.name === "readable") return settled.value.title || "Untitled";
  if (settled?.name === "unavailable") return "Page unavailable";
  if (meta.name === "failed") return "Couldn't load a preview";
  return null;
}

/**
 * The tab's card controller.
 *
 * - `refs`: the tab's PageRefs; opening a card asks it for the Page's meta
 *   and card, and no card opens while it knows no account.
 * - `canHover()`: whether this device hovers; false where `(hover: none)`.
 * - `focusVisible(element)`: whether focus came from the keyboard.
 * - `currentPageId()`: the Page open now, whose own links aren't Page links.
 * - `menus`: the open link menu count (link-menu.mjs).
 * - `scheduler`: runs the timer; tests pass a virtual one.
 *
 * `store` holds the machine's state. `attach(document)` starts watching and
 * returns the stop function. The component registers the card's element as
 * `card` and reports action use with `acted()`.
 */
export class PageLinkCards {
  #links = new Map();
  #keys = new WeakMap();
  #nextKey = 0;
  #timer = new Subject();
  #subscriptions = [];
  #buttonDown = false;
  /** Whether the last input was the keyboard (for focus entering the card). */
  #keyboard = false;
  /** True while the card gives focus back to its link: that focus is not
   * a reader's ask to open it again. */
  #restoring = false;
  card = null;
  announcer = null;
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
    menus = linkMenus,
    scheduler,
  }) {
    this.refs = refs;
    this.canHover = canHover;
    this.focusVisible = focusVisible;
    this.currentPageId = currentPageId;
    this.menus = menus;
    this.scheduler = scheduler;
    this.store = new Store(pageLinkCardMachine.initial);
  }

  /** The fragments of the link the card is for now, or none. */
  get linkElements() {
    const state = this.store.snapshot();
    return state.target ? (this.#links.get(state.target.key) ?? []) : [];
  }

  /** The link the card is for now (its first fragment), or null. */
  get link() {
    return this.linkElements[0] ?? null;
  }

  /** One of the card's actions was used: the card closes. */
  acted() {
    return this.dispatch({ type: "acted" });
  }

  /** Step the machine and run its effects. */
  dispatch(event) {
    const result = pageLinkCardMachine.step(this.store.snapshot(), event);
    if (result.rejected) return result;
    const link = this.link;
    const focusInCard = !!this.card?.contains(this.card.ownerDocument?.activeElement);
    this.store.update(() => result.state);
    let restore = false;
    for (const effect of result.effects) {
      if (effect.type === "arm") this.#timer.next(effect.ms);
      else if (effect.type === "disarm") this.#timer.next(null);
      else if (effect.type === "load")
        this.refs.want(effect.pageId, ["meta", "card"], { urgent: true });
      else if (effect.type === "restore") restore = true;
    }
    // A card that closes with focus inside gives it back to its link.
    if (restore || (result.state.name === "closed" && focusInCard)) this.#returnFocus(link);
    // Only the current link's elements are kept.
    const key = result.state.target?.key;
    for (const known of this.#links.keys()) if (known !== key) this.#links.delete(known);
    return result;
  }

  #returnFocus(link) {
    this.#restoring = true;
    try {
      returnFocus(link);
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
    this.#links.set(key, found.elements);
    return {
      key,
      pageId: found.pageId,
      anchor: found.anchor,
      href: found.href,
      comment: found.comment,
    };
  }

  /** Whether a card may open now (see the module comment). */
  #allowed() {
    return (
      !!this.refs.principal && !this.#buttonDown && this.menus.snapshot() === 0 && this.canHover()
    );
  }

  #find(node) {
    return pageLinkAt(node, { currentPageId: this.currentPageId() });
  }

  #inCard(node) {
    return !!node && !!this.card?.contains(node);
  }

  #inLink(node) {
    return !!node && this.linkElements.some((element) => element.contains(node));
  }

  /** The card's actions, in order. */
  #actions() {
    return this.card ? [...this.card.querySelectorAll("a[href], button:not(:disabled)")] : [];
  }

  /** Move focus as the card's Tab order says; true when it did. */
  #tab(event) {
    const state = this.store.snapshot();
    if (state.name !== "open" || event.altKey || event.ctrlKey || event.metaKey) return false;
    const actions = this.#actions();
    if (!actions.length) return false;
    if (!event.shiftKey && state.via === "focus" && this.#inLink(event.target)) {
      this.#keyboard = true;
      actions[0].focus();
      return true;
    }
    if (!this.#inCard(event.target)) return false;
    const index = actions.indexOf(event.target);
    if (event.shiftKey && index === 0) {
      this.#returnFocus(this.link);
      // Focus is on the link again: the card no longer holds it.
      this.dispatch({ type: "focused", target: state.target });
      return true;
    }
    if (!event.shiftKey && index === actions.length - 1) {
      const link = this.link;
      const next = link ? nextTabbable(link, this.card) : null;
      if (!next) return false;
      next.focus();
      this.dispatch({ type: "dismissed", restore: false });
      return true;
    }
    return false;
  }

  /** Watch `document` for Page links. Returns the stop function. */
  attach(document) {
    const announcer = document.createElement("div");
    announcer.className = "sr-only";
    announcer.setAttribute("aria-live", "polite");
    announcer.dataset.pageLinkAnnouncer = "";
    document.body.append(announcer);
    this.announcer = announcer;
    this.#subscriptions = [
      this.#timer
        .pipe(switchMap((ms) => (ms === null ? EMPTY : timer(ms, this.scheduler))))
        .subscribe(() => this.dispatch({ type: "elapsed" })),
      // A changed account closes the card; its answers belong to the old one.
      this.refs.store
        .select((state) => state.principal)
        .subscribe(() => this.dispatch({ type: "dismissed", restore: false })),
      // The link menu opening closes the card.
      this.menus
        .select((open) => open > 0)
        .subscribe((open) => {
          if (open) this.dispatch({ type: "dismissed", restore: false });
        }),
      // A keyboard-opened card's answer, announced once it loads.
      combineLatest([this.store.select((state) => state), this.refs.store.select((s) => s.refs)])
        .pipe(
          map(([state, refs]) => {
            if (state.name !== "open" || state.via !== "focus") return null;
            const text = announcement(refs.get(`${state.target.pageId}:meta`) ?? { name: "idle" });
            return text === null ? null : `${state.target.key}\u0000${text}`;
          }),
          distinctUntilChanged(),
        )
        .subscribe((said) => {
          announcer.textContent = said === null ? "" : said.split("\u0000")[1];
        }),
    ];
    const hoverInput = (event) => event.pointerType === "mouse" || event.pointerType === undefined;
    const over = (event) => {
      if (!hoverInput(event)) return;
      if (this.#inCard(event.target)) return void this.dispatch({ type: "entered" });
      const found = this.#find(event.target);
      if (!found || event.buttons || !this.#allowed()) return;
      this.dispatch({ type: "hovered", target: this.#target(found) });
    };
    const out = (event) => {
      if (!hoverInput(event)) return;
      const to = event.relatedTarget;
      if (this.#inCard(event.target)) {
        if (!this.#inCard(to)) this.dispatch({ type: "left" });
        return;
      }
      const found = this.#find(event.target);
      if (found && !found.elements.some((element) => element.contains(to)))
        this.dispatch({ type: "left" });
    };
    const focusIn = (event) => {
      if (this.#restoring) return;
      if (this.#inCard(event.target))
        return void this.dispatch({ type: "cardFocused", keyboard: this.#keyboard });
      const found = this.#find(event.target);
      if (!found) return;
      // Keyboard focus only: a click that focuses a link follows it.
      if (!this.focusVisible(found.element) && !this.focusVisible(event.target)) return;
      if (!this.#allowed()) return;
      this.dispatch({ type: "focused", target: this.#target(found) });
    };
    const focusOut = (event) => {
      const to = event.relatedTarget;
      if (this.#inCard(to) || this.#inLink(to)) return;
      if (this.#inCard(event.target) || this.#inLink(event.target))
        this.dispatch({ type: "blurred" });
    };
    const keyDown = (event) => {
      this.#keyboard = true;
      const state = this.store.snapshot();
      if (state.name === "closed") return;
      if (event.key === "Escape") {
        if (state.name === "pending") return void this.dispatch({ type: "dismissed" });
        const restore = this.#inCard(event.target) || state.via === "focus";
        if (this.dispatch({ type: "dismissed", restore }).rejected) return;
        // Escape closed the card and does nothing else.
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key === "Tab") {
        if (this.#tab(event)) event.preventDefault();
        return;
      }
      // Typing closes a card the pointer opened.
      const pointerCard =
        state.name === "pending" || state.name === "closing" || state.via === "pointer";
      if (pointerCard && !state.held && !QUIET_KEYS.has(event.key))
        this.dispatch({ type: "dismissed", restore: false });
    };
    const down = (event) => {
      this.#keyboard = false;
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
    return () => {
      for (const [type, listener, capture] of listeners)
        document.removeEventListener(type, listener, capture);
      for (const subscription of this.#subscriptions) subscription.unsubscribe();
      this.#subscriptions = [];
      this.dispatch({ type: "dismissed", restore: false });
      announcer.remove();
      this.announcer = null;
    };
  }
}
