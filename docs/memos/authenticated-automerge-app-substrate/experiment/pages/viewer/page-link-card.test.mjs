// The Page-link hover card: its machine over every state × event, the
// document controller on virtual time, the card's faces, and the glyph's
// hooks on links the editor and comments draw.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { VirtualTimeScheduler } from "rxjs";
import { runTable } from "../shared/machine-test.mjs";

const here = "1a160b47-6df1-4983-81eb-489ca5a26812";
const other = "2b160b47-6df1-4983-81eb-489ca5a26812";
const third = "3c160b47-6df1-4983-81eb-489ca5a26812";

const dom = new JSDOM("<!doctype html><body></body>", {
  url: `https://pages.example/p/${here}`,
  pretendToBeVisual: true,
});
class NoResizeObserver {
  observe() {}
  disconnect() {}
}
const saved = new Map();
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  navigator: dom.window.navigator,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  Text: dom.window.Text,
  Range: dom.window.Range,
  Selection: dom.window.Selection,
  DocumentFragment: dom.window.DocumentFragment,
  ShadowRoot: dom.window.ShadowRoot,
  MutationObserver: dom.window.MutationObserver,
  customElements: dom.window.customElements,
  Event: dom.window.Event,
  history: dom.window.history,
  CustomEvent: dom.window.CustomEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  InputEvent: dom.window.InputEvent,
  FocusEvent: dom.window.FocusEvent,
  MouseEvent: dom.window.MouseEvent,
  ResizeObserver: NoResizeObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  innerWidth: 1200,
  innerHeight: 800,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const empty = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 });
// jsdom has no layout; Wordgard's caret reads one line box beside text.
dom.window.Range.prototype.getClientRects = () => [empty()];
dom.window.Range.prototype.getBoundingClientRect = empty;
dom.window.document.elementFromPoint = () => null;
after(() => {
  dom.window.close();
  for (const [key, descriptor] of saved)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
});

const {
  PAGE_LINK_GRACE_MS,
  PAGE_LINK_OPEN_MS,
  PageLinkCards,
  linkRun,
  pageLinkAt,
  pageLinkCardMachine,
} = await import("./page-link-card.mjs");
const { PageRefs } = await import("./page-refs.mjs");
const { Store } = await import("./store.mjs");
const { linkMenuOpened } = await import("./link-menu.mjs");
// Built before any test is defined: the root test's after() hook restores
// the globals once every defined test has ended.
const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./PageLinkCard.jsx", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  loader: { ".css": "empty" },
  plugins: [
    {
      name: "test-component",
      setup(build) {
        build.onResolve({ filter: /^[^./]/ }, ({ path }) => ({
          path: pathToFileURL(require.resolve(path)).href,
          external: true,
        }));
      },
    },
  ],
});
const { PageLinkCard, cardFace, editedLabel } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

// ---------------------------------------------------------------------------
// The machine.

const target = (key = "a", pageId = other, comment = false) => ({
  key,
  pageId,
  anchor: null,
  href: `/p/${pageId}`,
  comment,
});
const A = target("a");
const B = target("b", third);
const ok = (state, effects = []) => ({ state, effects });
const no = (state, rejected) => ({ state, effects: [], rejected });
const closed = { name: "closed" };
const pending = (t = A) => ({ name: "pending", target: t });
const open = (via = "pointer", t = A, held = false) => ({ name: "open", target: t, via, held });
const held = (via = "pointer", t = A) => open(via, t, true);
const closing = (t = A) => ({ name: "closing", target: t, via: "pointer", held: false });
const arm = (ms) => ({ type: "arm", ms });
const disarm = { type: "disarm" };
const load = (t = A) => ({ type: "load", pageId: t.pageId });
const restore = { type: "restore" };
const hovered = (t = A) => ({ type: "hovered", target: t });
const focused = (t = A) => ({ type: "focused", target: t });
const cardFocused = (keyboard) => ({ type: "cardFocused", keyboard });
const acted = { type: "acted" };

const ROWS = [
  // closed
  { state: closed, event: hovered(), expect: ok(pending(), [arm(PAGE_LINK_OPEN_MS)]) },
  {
    label: "keyboard focus opens at once",
    state: closed,
    event: focused(),
    expect: ok(open("focus"), [load()]),
  },
  { state: closed, event: { type: "left" }, expect: no(closed, "nothing to leave") },
  { state: closed, event: { type: "blurred" }, expect: no(closed, "focus didn't open this card") },
  { state: closed, event: { type: "entered" }, expect: no(closed, "no card is drawn") },
  { state: closed, event: cardFocused(true), expect: no(closed, "no card is drawn") },
  { state: closed, event: acted, expect: no(closed, "no card is drawn") },
  { state: closed, event: { type: "elapsed" }, expect: no(closed, "no timer is running") },
  {
    state: closed,
    event: { type: "dismissed", restore: true },
    expect: no(closed, "nothing to dismiss"),
  },
  // pending
  {
    case: "same",
    state: pending(),
    event: hovered(),
    expect: no(pending(), "already on this link"),
  },
  {
    case: "other",
    label: "another link starts its own delay",
    state: pending(),
    event: hovered(B),
    expect: ok(pending(B), [arm(PAGE_LINK_OPEN_MS)]),
  },
  {
    case: "same",
    state: pending(),
    event: focused(),
    expect: ok(open("focus"), [disarm, load()]),
  },
  {
    case: "other",
    state: pending(),
    event: focused(B),
    expect: ok(open("focus", B), [disarm, load(B)]),
  },
  {
    label: "leaving before the delay opens nothing",
    state: pending(),
    event: { type: "left" },
    expect: ok(closed, [disarm]),
  },
  {
    state: pending(),
    event: { type: "blurred" },
    expect: no(pending(), "focus didn't open this card"),
  },
  { state: pending(), event: { type: "entered" }, expect: no(pending(), "no card is drawn") },
  { state: pending(), event: cardFocused(true), expect: no(pending(), "no card is drawn") },
  { state: pending(), event: acted, expect: no(pending(), "no card is drawn") },
  {
    label: "the delay ends: the card opens and loads",
    state: pending(),
    event: { type: "elapsed" },
    expect: ok(open(), [load()]),
  },
  {
    label: "a dismissal while pending has no focus to give back",
    state: pending(),
    event: { type: "dismissed", restore: true },
    expect: ok(closed, [disarm]),
  },
  // open
  { case: "same", state: open(), event: hovered(), expect: no(open(), "already on this link") },
  {
    case: "other",
    state: open(),
    event: hovered(B),
    expect: ok(pending(B), [arm(PAGE_LINK_OPEN_MS)]),
  },
  {
    case: "held",
    label: "keyboard focus in the card keeps it from a passing pointer",
    state: held(),
    event: hovered(B),
    expect: no(held(), "keyboard focus keeps the card"),
  },
  {
    case: "same-pointer",
    label: "focus reaching the link the pointer opened the card for",
    state: open(),
    event: focused(),
    expect: ok(open("focus")),
  },
  {
    case: "same-held",
    label: "Shift-Tab from the card back to its link",
    state: held("focus"),
    event: focused(),
    expect: ok(open("focus")),
  },
  {
    case: "same-focus",
    state: open("focus"),
    event: focused(),
    expect: no(open("focus"), "already open for this link"),
  },
  { case: "other", state: open(), event: focused(B), expect: ok(open("focus", B), [load(B)]) },
  {
    case: "pointer",
    label: "leaving starts the grace period",
    state: open(),
    event: { type: "left" },
    expect: ok(closing(), [arm(PAGE_LINK_GRACE_MS)]),
  },
  {
    case: "held",
    label: "keyboard focus in the card keeps it when the pointer leaves",
    state: held(),
    event: { type: "left" },
    expect: no(held(), "keyboard focus keeps the card"),
  },
  {
    case: "focus",
    state: open("focus"),
    event: { type: "left" },
    expect: no(open("focus"), "focus keeps the card"),
  },
  { case: "focus", state: open("focus"), event: { type: "blurred" }, expect: ok(closed) },
  {
    case: "held",
    label: "focus leaving a pointer-opened card hands it back to the pointer",
    state: held(),
    event: { type: "blurred" },
    expect: ok(open()),
  },
  {
    case: "pointer",
    state: open(),
    event: { type: "blurred" },
    expect: no(open(), "the pointer keeps the card"),
  },
  { state: open(), event: { type: "entered" }, expect: no(open(), "already open") },
  {
    case: "keyboard",
    label: "Tab into the card holds it",
    state: open(),
    event: cardFocused(true),
    expect: ok(held()),
  },
  {
    case: "already-held",
    state: held(),
    event: cardFocused(true),
    expect: no(held(), "already held"),
  },
  {
    case: "pointer",
    label: "a clicked button doesn't hold the card",
    state: open(),
    event: cardFocused(false),
    expect: no(open(), "only keyboard focus holds the card"),
  },
  {
    label: "using an action closes the card",
    state: held(),
    event: acted,
    expect: ok(closed, [restore]),
  },
  { state: open(), event: { type: "elapsed" }, expect: no(open(), "no timer is running") },
  {
    case: "restore",
    label: "Escape closes and gives focus back to the link",
    state: open("focus"),
    event: { type: "dismissed", restore: true },
    expect: ok(closed, [restore]),
  },
  {
    case: "stay",
    state: open(),
    event: { type: "dismissed", restore: false },
    expect: ok(closed),
  },
  // closing
  {
    case: "same",
    label: "back onto the link keeps the card",
    state: closing(),
    event: hovered(),
    expect: ok(open(), [disarm]),
  },
  {
    case: "other",
    state: closing(),
    event: hovered(B),
    expect: ok(pending(B), [arm(PAGE_LINK_OPEN_MS)]),
  },
  {
    case: "same",
    state: closing(),
    event: focused(),
    expect: ok(open("focus"), [disarm]),
  },
  {
    case: "other",
    state: closing(),
    event: focused(B),
    expect: ok(open("focus", B), [disarm, load(B)]),
  },
  { state: closing(), event: { type: "left" }, expect: no(closing(), "already closing") },
  {
    state: closing(),
    event: { type: "blurred" },
    expect: no(closing(), "focus didn't open this card"),
  },
  {
    label: "the pointer reaches the card in time",
    state: closing(),
    event: { type: "entered" },
    expect: ok(open(), [disarm]),
  },
  {
    case: "keyboard",
    state: closing(),
    event: cardFocused(true),
    expect: ok(held(), [disarm]),
  },
  {
    case: "pointer",
    state: closing(),
    event: cardFocused(false),
    expect: no(closing(), "only keyboard focus holds the card"),
  },
  { state: closing(), event: acted, expect: ok(closed, [disarm, restore]) },
  { state: closing(), event: { type: "elapsed" }, expect: ok(closed) },
  {
    case: "restore",
    state: closing(),
    event: { type: "dismissed", restore: true },
    expect: ok(closed, [disarm, restore]),
  },
  {
    case: "stay",
    state: closing(),
    event: { type: "dismissed", restore: false },
    expect: ok(closed, [disarm]),
  },
];

test("page-link-card: every state × event", async () => {
  const result = await runTable(pageLinkCardMachine, ROWS);
  assert.equal(result.rows, ROWS.length);
});

// ---------------------------------------------------------------------------
// The controller, on virtual time.

function pointer(type, element, { pointerType = "mouse", relatedTarget = null, buttons = 0 } = {}) {
  const event = new dom.window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    relatedTarget,
    buttons,
  });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  element.dispatchEvent(event);
}

function key(element, key, options = {}) {
  const event = new dom.window.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  element.dispatchEvent(event);
  return event;
}

function link(pageId, { href = `/p/${pageId}`, parent = document.body } = {}) {
  const block = document.createElement("p");
  const a = document.createElement("a");
  a.href = href;
  a.className = "page-link";
  a.dataset.pageId = pageId;
  a.textContent = "the plan";
  block.append(a);
  parent.append(block);
  return a;
}

/** A virtual clock: advance(ms) runs every action due by then and moves
 * the scheduler's clock there, even when nothing was due, so a timer armed
 * afterwards counts from the right time. */
function virtualTime() {
  const scheduler = new VirtualTimeScheduler();
  let now = 0;
  const advance = (ms) => {
    now += ms;
    scheduler.schedule(() => {}, now - scheduler.frame);
    scheduler.maxFrames = now;
    scheduler.flush();
  };
  return { scheduler, advance };
}

function controller({ principal = "user:a", canHover = () => true, get } = {}) {
  document.body.replaceChildren();
  const { scheduler, advance } = virtualTime();
  const wants = [];
  const refs = new PageRefs({ get: get ?? (() => new Promise(() => {})), scheduler });
  refs.account(principal);
  const want = refs.want.bind(refs);
  refs.want = (pageId, kinds, options) => {
    wants.push({ pageId, kinds, urgent: options?.urgent ?? false });
    return want(pageId, kinds, options);
  };
  const menus = new Store(0);
  const cards = new PageLinkCards({
    refs,
    canHover,
    scheduler,
    menus,
    focusVisible: () => true,
  });
  const stop = cards.attach(document);
  const card = (html = '<a href="/x">Open</a><button type="button">Open in new tab</button>') => {
    const element = document.createElement("div");
    element.className = "page-link-card";
    element.innerHTML = html;
    document.body.append(element);
    cards.card = element;
    return element;
  };
  return {
    cards,
    refs,
    menus,
    wants,
    stop,
    advance,
    card,
    state: () => cards.store.snapshot(),
  };
}

test("resting on a link opens its card after the delay and asks for meta and card", () => {
  const c = controller();
  const a = link(other);
  pointer("pointerover", a);
  assert.equal(c.state().name, "pending");
  c.advance(PAGE_LINK_OPEN_MS - 1);
  assert.equal(c.state().name, "pending");
  assert.deepEqual(c.wants, []);
  c.advance(1);
  assert.equal(c.state().name, "open");
  assert.equal(c.state().target.pageId, other);
  assert.deepEqual(c.wants, [{ pageId: other, kinds: ["meta", "card"], urgent: true }]);
  assert.equal(c.cards.link, a);
  c.stop();
});

test("leaving starts the grace period; the card or the link keeps it", () => {
  const c = controller();
  const a = link(other);
  pointer("pointerover", a);
  c.advance(PAGE_LINK_OPEN_MS);
  const card = c.card();
  pointer("pointerout", a, { relatedTarget: document.body });
  assert.equal(c.state().name, "closing");
  c.advance(PAGE_LINK_GRACE_MS - 1);
  pointer("pointerover", card);
  assert.equal(c.state().name, "open", "the pointer reached the card");
  c.advance(PAGE_LINK_GRACE_MS * 4);
  assert.equal(c.state().name, "open");
  // Moving within the card doesn't leave it.
  pointer("pointerout", card, { relatedTarget: card.firstChild });
  assert.equal(c.state().name, "open");
  pointer("pointerout", card, { relatedTarget: document.body });
  assert.equal(c.state().name, "closing");
  pointer("pointerover", a);
  assert.equal(c.state().name, "open", "back on the link");
  pointer("pointerout", a, { relatedTarget: document.body });
  c.advance(PAGE_LINK_GRACE_MS);
  assert.equal(c.state().name, "closed");
  c.stop();
});

test("leaving before the delay opens nothing; another link restarts it", () => {
  const c = controller();
  const a = link(other);
  const b = link(third);
  pointer("pointerover", a);
  c.advance(PAGE_LINK_OPEN_MS - 10);
  pointer("pointerout", a, { relatedTarget: b });
  pointer("pointerover", b);
  c.advance(PAGE_LINK_OPEN_MS - 1);
  assert.equal(c.state().name, "pending");
  c.advance(1);
  assert.equal(c.state().target.pageId, third);
  pointer("pointerout", b, { relatedTarget: document.body });
  c.advance(1);
  pointer("pointerover", a);
  assert.equal(c.state().name, "pending");
  pointer("pointerout", a, { relatedTarget: document.body });
  c.advance(PAGE_LINK_OPEN_MS * 2);
  assert.equal(c.state().name, "closed");
  assert.deepEqual(
    c.wants.map((want) => want.pageId),
    [third],
  );
  c.stop();
});

test("a link drawn as several fragments is one target: crossing them keeps the card", () => {
  const c = controller();
  // As Wordgard drew a formatted link before PagesLink had a rank: the
  // same href in sibling fragments, one inside <strong>.
  const block = document.createElement("p");
  block.innerHTML =
    `<a class="page-link" data-page-id="${other}" href="/p/${other}">the </a>` +
    `<strong><a class="page-link" data-page-id="${other}" href="/p/${other}">evening</a></strong>` +
    `<a class="page-link" data-page-id="${other}" href="/p/${other}"> focus</a>` +
    ` and <a class="page-link" data-page-id="${other}" href="/p/${other}">again</a>`;
  document.body.append(block);
  const [first, middle, last, separate] = block.querySelectorAll("a");
  assert.deepEqual(linkRun(middle), [first, middle, last]);
  assert.deepEqual(linkRun(separate), [separate], "text between links splits the run");
  assert.equal(pageLinkAt(last).element, first);
  pointer("pointerover", first);
  c.advance(PAGE_LINK_OPEN_MS);
  assert.equal(c.state().name, "open");
  assert.deepEqual(c.cards.linkElements, [first, middle, last]);
  // Crossing to the next fragment: no grace period, no new delay.
  pointer("pointerout", first, { relatedTarget: middle });
  pointer("pointerover", middle);
  pointer("pointerout", middle, { relatedTarget: last });
  pointer("pointerover", last);
  assert.equal(c.state().name, "open");
  c.advance(PAGE_LINK_GRACE_MS * 2);
  assert.equal(c.state().name, "open");
  assert.equal(c.wants.length, 1);
  // The separate link of the same Page is another target.
  pointer("pointerout", last, { relatedTarget: separate });
  pointer("pointerover", separate);
  assert.equal(c.state().name, "pending");
  c.stop();
});

test("focus opens at once; Escape closes, is handled, and gives focus back", () => {
  const c = controller();
  const a = link(other);
  a.focus();
  assert.equal(c.state().name, "open");
  assert.equal(c.state().via, "focus");
  const card = c.card();
  // Tab into the card: still open; Escape there returns focus to the link.
  key(a, "Tab");
  assert.equal(document.activeElement, card.firstChild);
  assert.equal(c.state().held, true);
  // A listener on an ancestor (the comments panel) sees Escape as handled,
  // or not at all.
  let panelSaw = null;
  const panel = (event) => (panelSaw = event.defaultPrevented);
  document.body.addEventListener("keydown", panel);
  const escape = key(card.firstChild, "Escape");
  document.body.removeEventListener("keydown", panel);
  assert.equal(c.state().name, "closed");
  assert.equal(escape.defaultPrevented, true);
  assert.notEqual(panelSaw, false, "the panel never sees an unhandled Escape");
  assert.equal(document.activeElement, a);
  // With no card open, Escape is the panel's.
  const free = key(a, "Escape");
  assert.equal(free.defaultPrevented, false);
  // Focus leaving both closes a card focus opened.
  a.blur();
  a.focus();
  assert.equal(c.state().name, "open");
  a.blur();
  assert.equal(c.state().name, "closed");
  c.stop();
});

test("Tab moves into the card, Shift-Tab back, and Tab past the last action moves on", () => {
  const c = controller();
  const a = link(other);
  const after = document.createElement("button");
  after.textContent = "Reply";
  document.body.append(after);
  a.focus();
  const card = c.card();
  const [open, newTab] = card.querySelectorAll("a, button");
  const tab = key(a, "Tab");
  assert.equal(tab.defaultPrevented, true);
  assert.equal(document.activeElement, open);
  // Within the card the browser moves focus.
  assert.equal(key(open, "Tab").defaultPrevented, false);
  newTab.focus();
  assert.equal(c.state().name, "open");
  // Shift-Tab from the first action goes back to the link.
  open.focus();
  assert.equal(key(open, "Tab", { shiftKey: true }).defaultPrevented, true);
  assert.equal(document.activeElement, a);
  assert.equal(c.state().name, "open");
  assert.equal(c.state().held, false);
  // Tab past the last action closes the card and moves on after the link.
  key(a, "Tab");
  newTab.focus();
  assert.equal(key(newTab, "Tab").defaultPrevented, true);
  assert.equal(document.activeElement, after);
  assert.equal(c.state().name, "closed");
  // A pointer-opened card isn't entered by Tab from its link.
  pointer("pointerover", a);
  c.advance(PAGE_LINK_OPEN_MS);
  assert.equal(c.state().via, "pointer");
  c.card();
  assert.equal(key(a, "Tab").defaultPrevented, false);
  c.stop();
});

test("a clicked action closes the card; only keyboard focus holds it open", () => {
  const c = controller();
  const a = link(other);
  pointer("pointerover", a);
  c.advance(PAGE_LINK_OPEN_MS);
  const card = c.card();
  const button = card.querySelector("button");
  pointer("pointerover", card);
  // A mouse press on a card button: focus lands there but doesn't hold it.
  pointer("pointerdown", button);
  button.focus();
  assert.equal(c.state().held, false);
  pointer("pointerout", card, { relatedTarget: document.body });
  assert.equal(c.state().name, "closing", "the pointer leaving closes it");
  c.advance(PAGE_LINK_GRACE_MS);
  assert.equal(c.state().name, "closed");
  // Using an action closes the card at once.
  pointer("pointerover", a);
  c.advance(PAGE_LINK_OPEN_MS);
  c.card();
  c.cards.acted();
  assert.equal(c.state().name, "closed");
  // Keyboard focus in a pointer-opened card holds it when the pointer leaves.
  pointer("pointerover", a);
  c.advance(PAGE_LINK_OPEN_MS);
  const held = c.card();
  key(document.body, "Shift");
  held.querySelector("button").focus();
  assert.equal(c.state().held, true);
  pointer("pointerout", a, { relatedTarget: document.body });
  c.advance(PAGE_LINK_GRACE_MS * 2);
  assert.equal(c.state().name, "open");
  c.stop();
});

test("a link in an editable editor gives focus back to the editor, keeping its caret", async () => {
  const c = controller();
  const { registerEditor } = await import("./editor-focus.mjs");
  const content = document.createElement("wg-content");
  content.setAttribute("contenteditable", "true");
  content.tabIndex = 0;
  const p = document.createElement("p");
  p.innerHTML = `Text <a class="page-link" data-page-id="${other}" href="/p/${other}">link</a>`;
  content.append(p);
  document.body.append(content);
  const a = p.querySelector("a");
  // jsdom has no isContentEditable; a browser reports it for this link.
  Object.defineProperty(a, "isContentEditable", { value: true });
  let focused = 0;
  const forget = registerEditor({
    contentDOM: content,
    focus() {
      focused++;
      content.focus();
    },
  });
  pointer("pointerover", a);
  c.advance(PAGE_LINK_OPEN_MS);
  const card = c.card();
  key(document.body, "Shift");
  card.querySelector("button").focus();
  key(card.querySelector("button"), "Escape");
  assert.equal(c.state().name, "closed");
  assert.equal(focused, 1, "the editor's focus(), which restores its selection");
  assert.equal(document.activeElement, content);
  forget();
  c.stop();
});

test("typing or the link menu opening closes a pointer-opened card", () => {
  const c = controller();
  const a = link(other);
  for (const quiet of ["Shift", "Meta", "Control", "Alt"]) {
    pointer("pointerover", a);
    c.advance(PAGE_LINK_OPEN_MS);
    key(document.body, quiet);
    assert.equal(c.state().name, "open", quiet);
    pointer("pointerout", a, { relatedTarget: document.body });
    c.advance(PAGE_LINK_GRACE_MS);
  }
  pointer("pointerover", a);
  c.advance(PAGE_LINK_OPEN_MS);
  key(document.body, "x");
  assert.equal(c.state().name, "closed", "typing");
  pointer("pointerout", a, { relatedTarget: document.body });
  // A pending card goes too.
  pointer("pointerover", a);
  key(document.body, "k", { metaKey: true });
  assert.equal(c.state().name, "closed", "Cmd-K while pending");
  pointer("pointerout", a, { relatedTarget: document.body });
  // The link menu opening closes it, and none opens while it shows.
  pointer("pointerover", a);
  c.advance(PAGE_LINK_OPEN_MS);
  assert.equal(c.state().name, "open");
  const release = linkMenuOpened(c.menus);
  assert.equal(c.state().name, "closed", "link menu");
  pointer("pointerout", a, { relatedTarget: document.body });
  pointer("pointerover", a);
  c.advance(PAGE_LINK_OPEN_MS * 2);
  assert.equal(c.state().name, "closed", "no card under the link menu");
  release();
  release();
  assert.equal(c.menus.snapshot(), 0, "releasing twice counts once");
  pointer("pointerout", a, { relatedTarget: document.body });
  // Typing never closes a keyboard-opened card: Enter on the link follows
  // it, and focus leaving the link closes the card.
  a.focus();
  key(a, "x");
  assert.equal(c.state().name, "open", "typing never closes a keyboard-opened card");
  c.stop();
});

test("the live region announces a keyboard-opened card's answer once", async () => {
  const answers = [];
  const c = controller({
    get: (path) => new Promise((resolve, reject) => answers.push({ path, resolve, reject })),
  });
  const a = link(other);
  const region = document.querySelector("[data-page-link-announcer]");
  assert.equal(region.getAttribute("aria-live"), "polite");
  a.focus();
  assert.equal(region.textContent, "", "nothing while it loads");
  answers[0].resolve({
    v: 1,
    page_id: other,
    title: "Evening focus",
    state: "active",
    role: "viewer",
    content_updated_at: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(region.textContent, "Evening focus");
  a.blur();
  assert.equal(region.textContent, "");
  // A pointer-opened card announces nothing: the reader is looking at it.
  const b = link(third);
  pointer("pointerover", b);
  c.advance(PAGE_LINK_OPEN_MS);
  answers
    .find((entry) => entry.path.includes(third) && entry.path.endsWith("meta.json"))
    .reject(Object.assign(Error("x"), { status: 404, code: "page_unavailable" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(region.textContent, "");
  pointer("pointerout", b, { relatedTarget: document.body });
  c.advance(PAGE_LINK_GRACE_MS);
  b.focus();
  assert.equal(region.textContent, "Page unavailable");
  c.stop();
  assert.equal(document.querySelector("[data-page-link-announcer]"), null);
});

test("no card while the link menu is open, a button is down, for touch, or without hover", () => {
  for (const [label, setup, options] of [
    ["link menu", (c) => linkMenuOpened(c.menus)],
    ["touch", () => {}, { pointerType: "touch" }],
    ["pen", () => {}, { pointerType: "pen" }],
    ["a selection drag", () => {}, { buttons: 1 }],
  ]) {
    const c = controller();
    const a = link(other);
    setup(c);
    pointer("pointerover", a, options);
    c.advance(PAGE_LINK_OPEN_MS * 2);
    assert.equal(c.state().name, "closed", label);
    c.stop();
  }
  const noHover = controller({ canHover: () => false });
  const a = link(other);
  pointer("pointerover", a);
  a.focus();
  noHover.advance(PAGE_LINK_OPEN_MS * 2);
  assert.equal(noHover.state().name, "closed", "(hover: none)");
  noHover.stop();
  // A mouse button held from a press stops hover until it lifts.
  const c = controller();
  const b = link(other);
  pointer("pointerdown", document.body);
  pointer("pointerover", b);
  c.advance(PAGE_LINK_OPEN_MS);
  assert.equal(c.state().name, "closed", "button down");
  pointer("pointerup", document.body);
  pointer("pointerout", b, { relatedTarget: document.body });
  pointer("pointerover", b);
  c.advance(PAGE_LINK_OPEN_MS);
  assert.equal(c.state().name, "open", "after the button lifts");
  // A press outside the card closes it.
  pointer("pointerdown", document.body);
  assert.equal(c.state().name, "closed");
  c.stop();
  // Signed out: nothing to resolve with.
  const signedOut = controller({ principal: null });
  const d = link(other);
  pointer("pointerover", d);
  signedOut.advance(PAGE_LINK_OPEN_MS);
  assert.equal(signedOut.state().name, "closed", "signed out");
  signedOut.stop();
});

test("only Page links count, and always the Page their href names", () => {
  const c = controller();
  const self = link(here);
  const plain = document.createElement("a");
  plain.href = "https://nteract.io";
  document.body.append(plain);
  // A forged data-page-id that its href doesn't back.
  const forged = link(other, { href: "https://evil.example/p/x" });
  // A same-origin href whose data-page-id names a different Page: no target,
  // never the attribute's Page.
  const mismatched = link(third, { href: `/p/${other}` });
  const preview = document.createElement("div");
  preview.className = "page-card-preview";
  document.body.append(preview);
  const inPreview = link(other, { parent: preview });
  const card = c.card();
  const inCard = link(third, { parent: card });
  for (const element of [self, plain, forged, mismatched, inPreview, inCard]) {
    assert.equal(pageLinkAt(element), null, element.outerHTML);
    pointer("pointerover", element);
    c.advance(PAGE_LINK_OPEN_MS);
    assert.notEqual(c.state().name, "open", element.outerHTML);
    pointer("pointerout", element, { relatedTarget: document.body });
  }
  assert.deepEqual(c.wants, [], "nothing was asked for any of them");
  const good = link(other);
  good.innerHTML = "<b>the plan</b>";
  assert.equal(pageLinkAt(good.firstChild).element, good);
  const found = pageLinkAt(good.firstChild);
  assert.deepEqual(
    { ...found, element: null, elements: found.elements.length },
    {
      element: null,
      elements: 1,
      pageId: other,
      anchor: null,
      href: `https://pages.example/p/${other}`,
      comment: false,
    },
  );
  const comment = document.createElement("div");
  comment.className = "comment-rich-content";
  document.body.append(comment);
  assert.equal(pageLinkAt(link(other, { parent: comment })).comment, true);
  c.stop();
});

test("another account closes the card", () => {
  const c = controller();
  const a = link(other);
  pointer("pointerover", a);
  c.advance(PAGE_LINK_OPEN_MS);
  assert.equal(c.state().name, "open");
  c.refs.account("user:b");
  assert.equal(c.state().name, "closed");
  c.stop();
});

// ---------------------------------------------------------------------------
// The card's faces, rendered.

test("the card's face follows its refs", () => {
  const idle = { name: "idle" };
  const value = { title: "Plan", state: "active", role: "viewer", content_updated_at: null };
  const readable = { name: "readable", value, stale: false };
  const card = { name: "readable", value: { card: { blocks: [] } }, stale: false };
  assert.deepEqual(cardFace(idle, idle), { face: "loading" });
  assert.deepEqual(cardFace({ name: "requested", last: null, attempts: 0 }, idle), {
    face: "loading",
  });
  assert.deepEqual(cardFace({ name: "unavailable", stale: true }, idle), { face: "unavailable" });
  assert.deepEqual(cardFace({ name: "failed", last: null, attempts: 1, ready: false }, idle), {
    face: "failed",
  });
  assert.deepEqual(cardFace(readable, card), {
    face: "readable",
    meta: value,
    card: { blocks: [] },
    cardLoading: false,
  });
  assert.equal(cardFace(readable, idle).cardLoading, true);
  assert.equal(
    cardFace(readable, { name: "failed", last: null, attempts: 1, ready: false }).cardLoading,
    false,
  );
  // A refresh keeps showing what it refreshes.
  assert.equal(
    cardFace({ name: "requested", last: { name: "readable", value }, attempts: 0 }, idle).face,
    "readable",
  );
  const now = Date.parse("2026-11-06T12:00:00Z");
  assert.equal(editedLabel(null, now), null);
  assert.equal(editedLabel("2026-11-06T11:59:30Z", now, "en"), "Edited just now");
  assert.equal(editedLabel("2026-11-06T10:00:00Z", now, "en"), "Edited 2 hours ago");
  assert.equal(editedLabel("2026-11-04T12:00:00Z", now, "en"), "Edited 2 days ago");
});

async function mountCard({ parent } = {}) {
  document.body.replaceChildren();
  const scope = parent?.() ?? document.body;
  const a = link(other, { parent: scope });
  const scheduler = new VirtualTimeScheduler();
  const pendingAnswers = [];
  const refs = new PageRefs({
    get: (path) => new Promise((resolve, reject) => pendingAnswers.push({ path, resolve, reject })),
    scheduler,
  });
  refs.account("user:a");
  const opened = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(PageLinkCard, {
        refs,
        currentPageId: here,
        onOpenRoute: (route, anchor) => opened.push({ route, anchor }),
      }),
    ),
  );
  // Keyboard focus opens the card at once (jsdom matches :focus-visible on
  // any focused element).
  await act(async () => a.focus());
  const answer = async (kind, outcome) => {
    const call = pendingAnswers.find((entry) => entry.path.endsWith(`${kind}.json`));
    await act(async () => {
      if (outcome instanceof Error) call.reject(outcome);
      else call.resolve(outcome);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const card = () => document.querySelector(".page-link-card");
  return { a, refs, opened, root, answer, card, pendingAnswers };
}

test("the card draws loading, readable, unavailable and failed faces", async () => {
  const m = await mountCard();
  assert.equal(m.card().dataset.face, "loading");
  assert.equal(m.card().getAttribute("aria-busy"), "true");
  // The focusable link is described by the card while it shows.
  const described = m.a.getAttribute("aria-describedby");
  assert.equal(described, m.card().getAttribute("aria-labelledby"));
  assert.ok(document.getElementById(described));
  assert.deepEqual(
    m.pendingAnswers.map((entry) => entry.path),
    [`/p/${other}/meta.json`, `/p/${other}/card.json`],
  );
  assert.notEqual(document.activeElement.closest?.(".page-link-card"), m.card(), "no focus stolen");
  await m.answer("meta", {
    v: 1,
    page_id: other,
    title: "\u05e9\u05dc\u05d5\u05dd plan",
    state: "active",
    role: "viewer",
    content_updated_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
  });
  assert.equal(m.card().dataset.face, "readable");
  const title = m.card().querySelector("bdi.page-link-card-title");
  assert.equal(title.textContent, "\u05e9\u05dc\u05d5\u05dd plan");
  assert.equal(title.getAttribute("dir"), "auto");
  assert.match(m.card().querySelector(".page-link-card-meta").textContent, /^Edited 2 hours ago$/);
  // The card is still loading: a quiet box, not the placeholder yet.
  assert.ok(m.card().querySelector(".page-link-card-preview-wait"));
  await m.answer("card", { v: 1, page_id: other, card: null });
  assert.ok(m.card().querySelector(".index-card-placeholder"), "no card yet: the Page icon");
  const [openLink, newTab] = m.card().querySelectorAll(".page-link-card-actions > *");
  assert.equal(openLink.textContent, "Open");
  assert.equal(openLink.getAttribute("href"), `https://pages.example/p/${other}`);
  assert.match(newTab.textContent, /Open in new tab/);
  // Open goes in place through the route opener, and closes the card.
  await act(async () =>
    openLink.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    ),
  );
  assert.deepEqual(m.opened, [{ route: { kind: "page", pageId: other }, anchor: null }]);
  assert.equal(m.card(), null);
  assert.equal(m.a.getAttribute("aria-describedby"), null, "removed with the card");
  await act(async () => m.root.unmount());

  const refused = await mountCard();
  const unavailable = Object.assign(Error("Page unavailable"), {
    status: 404,
    code: "page_unavailable",
  });
  await refused.answer("meta", unavailable);
  assert.equal(refused.card().dataset.face, "unavailable");
  assert.equal(
    refused.card().textContent,
    "Page unavailable",
    "nothing else: no reason, title, time or buttons",
  );
  assert.ok(refused.card().querySelector(".page-link-card-lock svg"));
  assert.equal(refused.card().querySelector("a, button"), null);
  await act(async () => refused.root.unmount());

  const broken = await mountCard();
  await broken.answer("meta", Object.assign(Error("boom"), { status: 500 }));
  assert.equal(broken.card().dataset.face, "failed");
  assert.equal(broken.card().textContent, "Couldn't load a preview");
  await act(async () => broken.root.unmount());
});

const READABLE = {
  v: 1,
  page_id: other,
  title: "Evening focus",
  state: "active",
  role: "viewer",
  content_updated_at: null,
};

test("each action closes the card: Open in new tab, and a modified or middle click on Open", async () => {
  const opened = [];
  const open = globalThis.open;
  globalThis.open = (...args) => opened.push(args);
  try {
    for (const [label, use] of [
      ["Open in new tab", (card) => card.querySelector("button").click()],
      [
        "Cmd-click Open",
        (card) =>
          card.querySelector("a").dispatchEvent(
            new dom.window.MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              button: 0,
              metaKey: true,
            }),
          ),
      ],
      [
        "middle click Open",
        (card) =>
          card
            .querySelector("a")
            .dispatchEvent(
              new dom.window.MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
            ),
      ],
    ]) {
      const m = await mountCard();
      await m.answer("meta", READABLE);
      await m.answer("card", { v: 1, page_id: other, card: null });
      await act(async () => use(m.card()));
      assert.equal(m.card(), null, label);
      assert.deepEqual(m.opened, [], `${label}: nothing opened in place`);
      // Focus went back to the link it came from.
      assert.equal(document.activeElement, m.a, label);
      await act(async () => m.root.unmount());
    }
    assert.deepEqual(opened, [
      [`https://pages.example/p/${other}`, "_blank", "noopener,noreferrer"],
    ]);
  } finally {
    globalThis.open = open;
  }
});

test("a comment link's card offers only Open in new tab", async () => {
  const m = await mountCard({
    parent: () => {
      const comment = document.createElement("div");
      comment.className = "comment-rich-content";
      document.body.append(comment);
      return comment;
    },
  });
  await m.answer("meta", READABLE);
  await m.answer("card", { v: 1, page_id: other, card: null });
  const actions = [...m.card().querySelectorAll(".page-link-card-actions > *")];
  assert.deepEqual(
    actions.map((action) => [action.tagName, action.textContent.trim(), action.className]),
    [["BUTTON", "Open in new tab", "primary"]],
  );
  await act(async () => m.root.unmount());
});

// ---------------------------------------------------------------------------
// The glyph's hooks, on links the editor and comments draw.

test("a formatted link draws as one element with one glyph target, in Page blocks and comments", async () => {
  const { Wordgard } = await import("wordgard/editor");
  const { GardState } = await import("wordgard/state");
  const { Leaf } = await import("wordgard/doc");
  const { schema, Paragraph, PagesLink, PagesHighlight, Strong, Emphasis, Code, Strikethrough } =
    await import("./wordgard-model.mjs");
  const { pagesLinkShape } = await import("./page-link-shape.mjs");
  const { encode } = await import("./wordgard-model.mjs");
  const href = `/p/${other}`;
  const link = PagesLink.of({ href, title: null });
  const rows = [
    ["bold", Strong, "strong"],
    ["italic", Emphasis, "em"],
    ["strike", Strikethrough, "s"],
    ["inline code", Code, "code"],
    ["highlight", PagesHighlight.of("yellow"), "mark"],
  ];
  for (const shape of [pagesLinkShape({ currentPageId: () => here }), pagesLinkShape()])
    for (const [label, mark, tag] of rows) {
      const doc = schema.doc([
        Paragraph.create([
          Leaf.text("See ", []),
          Leaf.text("the ", [link]),
          Leaf.text(
            "evening",
            [link, mark].reduce((set, each) => each.addToSet(set), []),
          ),
          Leaf.text(" focus", [link]),
          Leaf.text(" tonight."),
        ]),
      ]);
      const state = GardState.create({
        doc,
        config: [schema.elements.map((element) => GardState.schemaElement.of(element)), shape],
      });
      const editor = new Wordgard({ state, parent: document.body });
      try {
        editor.flush();
        const links = [...editor.dom.querySelectorAll("a.page-link")];
        assert.equal(links.length, 1, `${label}: one <a>, so one glyph`);
        assert.equal(links[0].textContent, "the evening focus", label);
        assert.equal(links[0].querySelector(tag)?.textContent, "evening", label);
        assert.equal(links[0].dataset.pageId, other, label);
        assert.equal(pageLinkAt(links[0].querySelector(tag)).element, links[0], label);
      } finally {
        editor.dom.remove();
      }
      // Storage writes marks by name, in the order it always had.
      const spans = encode(doc);
      const marked = spans.find((span) => span.value === "evening");
      assert.deepEqual(Object.keys(marked.marks).at(-1), "link", label);
    }
});

test("comments leave the open Page's own links without the glyph", async () => {
  const { Wordgard } = await import("wordgard/editor");
  const { GardState } = await import("wordgard/state");
  const { Leaf } = await import("wordgard/doc");
  const { schema, Paragraph, PagesLink } = await import("./wordgard-model.mjs");
  const { pagesLinkShape } = await import("./page-link-shape.mjs");
  // A Project route names no Page in its address: only the session does.
  history.replaceState(null, "", `/project/prj_${other}`);
  try {
    const doc = schema.doc([
      Paragraph.create([
        Leaf.text("own", [PagesLink.of({ href: `/p/${here}#plan`, title: null })]),
        Leaf.text(" "),
        Leaf.text("other", [PagesLink.of({ href: `/p/${third}`, title: null })]),
      ]),
    ]);
    const state = GardState.create({
      doc,
      config: [
        schema.elements.map((element) => GardState.schemaElement.of(element)),
        pagesLinkShape({ currentPageId: () => here }),
      ],
    });
    const editor = new Wordgard({ state, parent: document.body });
    editor.flush();
    assert.deepEqual(
      [...editor.dom.querySelectorAll("a")].map((a) => [a.textContent, a.dataset.pageId ?? null]),
      [
        ["own", null],
        ["other", third],
      ],
    );
    editor.dom.remove();
    // CommentRichText passes the session's Page through CurrentPage to both
    // its composer and its displayed messages.
    const source = await readFile(new URL("./CommentRichText.jsx", import.meta.url), "utf8");
    assert.equal(source.match(/useContext\(CurrentPage\)/g)?.length, 2);
    assert.equal(source.match(/nativeConfig\(\{ currentPageId: /g)?.length, 2);
  } finally {
    history.replaceState(null, "", `/p/${here}`);
  }
});

test("Page blocks and comments put the glyph's hooks only on links to other Pages", async () => {
  const { Wordgard } = await import("wordgard/editor");
  const { GardState } = await import("wordgard/state");
  const { Leaf } = await import("wordgard/doc");
  const { schema, Paragraph, PagesLink } = await import("./wordgard-model.mjs");
  const { pagesLinkShape } = await import("./page-link-shape.mjs");
  const hrefs = [
    `/p/${other}`,
    `https://pages.example/p/${third}#plan`,
    `/p/${here}#section`,
    `/project/prj_${other}`,
    `https://pages.example.evil.example/p/${other}`,
    `https://page2.example/p/${other}`,
    `/p/${other}/meta.json`,
    "https://nteract.io/docs",
  ];
  const doc = schema.doc([
    Paragraph.create(
      hrefs.flatMap((href, index) => [
        Leaf.text(`link ${index}`, [PagesLink.of({ href, title: null })]),
        Leaf.text(" "),
      ]),
    ),
  ]);
  // Page blocks name the open Page; comments read it from the address.
  for (const shape of [pagesLinkShape({ currentPageId: () => here }), pagesLinkShape()]) {
    const state = GardState.create({
      doc,
      config: [schema.elements.map((element) => GardState.schemaElement.of(element)), shape],
    });
    const editor = new Wordgard({ state, parent: document.body });
    try {
      editor.flush();
      const links = [...editor.dom.querySelectorAll("a")];
      assert.equal(links.length, hrefs.length);
      assert.deepEqual(
        links.map((a) => [a.textContent, a.className, a.dataset.pageId ?? null]),
        [
          ["link 0", "page-link", other],
          ["link 1", "page-link", third],
          ["link 2", "", null],
          ["link 3", "", null],
          ["link 4", "", null],
          ["link 5", "", null],
          ["link 6", "", null],
          ["link 7", "", null],
        ],
      );
      // The link text is the document's; no widget was added.
      assert.equal(editor.dom.querySelectorAll(".wordgard-widget").length, 0);
    } finally {
      editor.dom.remove();
    }
  }
});
