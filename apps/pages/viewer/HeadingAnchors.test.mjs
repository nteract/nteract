import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import * as A from "@automerge/automerge";
import { richFromSource } from "../model/richtext-test-support.mjs";
import { SCROLL_STATE_KEY } from "../shared/routes.mjs";
import { HeadingScroll } from "./heading-scroll.mjs";

const pageId = "1a160b47-6df1-4983-81eb-489ca5a26812";
const otherId = "2b160b47-6df1-4983-81eb-489ca5a26812";
const dom = new JSDOM("<!doctype html><body></body>", {
  url: `http://localhost/p/${pageId}`,
  pretendToBeVisual: true,
});
const scrolled = [];
dom.window.Element.prototype.scrollIntoView = function () {
  scrolled.push(this.textContent);
};
dom.window.scrollTo = (options) => scrolled.push(options.top);
// jsdom lays nothing out: a tall document, so any position fits.
Object.defineProperty(dom.window.document.documentElement, "scrollHeight", {
  configurable: true,
  get: () => 5000,
});
class NoResizeObserver {
  observe() {}
  disconnect() {}
}
const saved = new Map();
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  location: dom.window.location,
  history: dom.window.history,
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
  ResizeObserver: NoResizeObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  CSS: { escape: (value) => String(value).replace(/["\\]/g, "\\$&") },
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
after(() => {
  dom.window.close();
  for (const [key, descriptor] of saved)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
});
const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./HeadingAnchors.jsx", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic",
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
const { HeadingAnchors } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const doc = A.change(A.from({ page_id: pageId, title: "Title", blocks: {} }), (d) => {
  const blocks = [
    ["one", "# Overview\n\n| See |\n| --- |\n| [*Getting lean*](#getting-lean-automerge) |"],
    ["two", "## Plan\n\n## Getting lean: Automerge"],
  ];
  blocks.forEach(([id, markdown], index) => {
    d.blocks[id] = { position: new A.RawString(`a${index}`), markdown };
    richFromSource(d, id);
  });
});
const session = { pageId, doc };

/** What the editor draws for block `id`: its headings, in a section. */
function drawBlock(article, id, html) {
  const section = document.createElement("section");
  section.dataset.blockId = id;
  section.innerHTML = `<div><wg-content>${html}</wg-content></div>`;
  article.append(section);
  return section;
}
const frames = () =>
  act(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));

/** The shell's scroll controller, started as at page load. */
const controllers = [];
after(() => controllers.forEach((scroll) => scroll.stop()));
function controller({ fromAddress = false } = {}) {
  const scroll = new HeadingScroll();
  controllers.push(scroll);
  scroll.start();
  if (fromAddress) scroll.requestFromAddress();
  return scroll;
}

async function mount(props = {}) {
  const scroll = props.scroll ?? controller();
  const article = document.createElement("article");
  document.body.replaceChildren(article);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const opened = [];
  const notices = [];
  await act(async () =>
    root.render(
      createElement(HeadingAnchors, {
        article: { current: article },
        session,
        projectId: null,
        onOpenRoute: (route, anchor) => opened.push({ route, anchor }),
        onNotice: (message) => notices.push(message),
        onError: (message) => notices.push(message),
        ...props,
        scroll,
      }),
    ),
  );
  return { article, root, opened, notices, scroll };
}

test("a fragment in the address scrolls to its heading once the editor draws it", async () => {
  history.replaceState(null, "", `/p/${pageId}#getting-lean-automerge`);
  scrolled.length = 0;
  const { article, root, scroll } = await mount({ scroll: controller({ fromAddress: true }) });
  drawBlock(article, "one", "<h1>Overview</h1>");
  await frames();
  assert.deepEqual(scrolled, [], "nothing to scroll to before the heading draws");
  // Late sync: the block holding the heading draws after the Page opened.
  drawBlock(article, "two", "<h2>Plan</h2><h2>Getting lean: Automerge</h2>");
  await frames();
  assert.deepEqual(scrolled, ["Getting lean: Automerge"]);
  await act(async () => root.unmount());
  scroll.stop();
});

test("the reader scrolling before the Page opens cancels its scroll", async () => {
  history.replaceState(null, "", `/p/${pageId}#plan`);
  scrolled.length = 0;
  // Page load: the loading preview shows, and the reader wheels it.
  const scroll = controller({ fromAddress: true });
  window.dispatchEvent(new window.Event("wheel"));
  const { article, root } = await mount({ scroll });
  drawBlock(article, "two", "<h2>Plan</h2><h2>Getting lean: Automerge</h2>");
  await frames();
  assert.deepEqual(scrolled, []);
  assert.equal(scroll.store.snapshot().name, "cancelled");
  await act(async () => root.unmount());
  scroll.stop();
});

test("the reader scrolling while the Page is open cancels a pending scroll", async () => {
  history.replaceState(null, "", `/p/${pageId}#plan`);
  scrolled.length = 0;
  const scroll = controller({ fromAddress: true });
  const { article, root } = await mount({ scroll });
  await act(async () => window.dispatchEvent(new window.Event("wheel")));
  drawBlock(article, "two", "<h2>Plan</h2><h2>Getting lean: Automerge</h2>");
  await frames();
  assert.deepEqual(scrolled, []);
  await act(async () => root.unmount());
  scroll.stop();
});

test("Back returns to the entry's recorded position once the Page draws", async () => {
  history.replaceState(null, "", `/p/${pageId}`);
  scrolled.length = 0;
  const scroll = controller();
  const { article, root } = await mount({ scroll });
  history.replaceState({ pageId, [SCROLL_STATE_KEY]: { path: `/p/${pageId}`, y: 900 } }, "");
  await act(async () => window.dispatchEvent(new window.PopStateEvent("popstate")));
  await frames();
  assert.deepEqual(scrolled, [], "nothing drawn yet");
  drawBlock(article, "one", "<h1>Overview</h1>");
  await frames();
  assert.deepEqual(scrolled, [900]);
  assert.equal(scroll.store.snapshot().name, "settling");
  await act(async () => root.unmount());
  scroll.stop();
});

test("scrolling records the position in the history entry showing the Page", async () => {
  history.replaceState({ pageId }, "", `/p/${pageId}`);
  const scroll = controller();
  const { root } = await mount({ scroll });
  Object.defineProperty(window, "scrollY", { configurable: true, value: 333 });
  await act(async () => window.dispatchEvent(new window.Event("scroll")));
  await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
  assert.deepEqual(history.state, { pageId, [SCROLL_STATE_KEY]: { path: `/p/${pageId}`, y: 333 } });
  // Not while the address shows another Page (mid-swap after a link or Back).
  history.replaceState({ pageId: otherId }, "", `/p/${otherId}`);
  Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  await act(async () => window.dispatchEvent(new window.Event("scroll")));
  await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
  assert.deepEqual(history.state, { pageId: otherId });
  await act(async () => root.unmount());
  scroll.stop();
});

test("a read-only link to a heading scrolls in place and puts it in the address", async () => {
  history.replaceState(null, "", `/p/${pageId}`);
  scrolled.length = 0;
  const { article, root, opened } = await mount();
  const one = drawBlock(
    article,
    "one",
    `<h1>Overview</h1><a href="http://localhost/p/${pageId}#getting-lean-automerge" target="_blank">Getting lean</a>`,
  );
  drawBlock(article, "two", "<h2>Plan</h2><h2>Getting lean: Automerge</h2>");
  const click = new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  await act(async () => one.querySelector("a").dispatchEvent(click));
  await frames();
  assert.equal(click.defaultPrevented, true, "no new tab");
  assert.equal(location.hash, "#getting-lean-automerge");
  assert.deepEqual(scrolled, ["Getting lean: Automerge"]);
  assert.deepEqual(opened, []);
  // Another Page's heading opens that Page with its anchor.
  const link = document.createElement("a");
  link.href = `/p/${otherId}#intro`;
  one.append(link);
  await act(async () =>
    link.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })),
  );
  assert.deepEqual(opened, [
    {
      route: { kind: "page", pageId: otherId, path: `/p/${otherId}`, slug: null },
      anchor: "intro",
    },
  ]);
  // A modified click keeps the browser's new tab; an outside link is left alone.
  const modified = new window.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    metaKey: true,
  });
  await act(async () => one.querySelector("a").dispatchEvent(modified));
  assert.equal(modified.defaultPrevented, false);
  const outside = document.createElement("a");
  outside.href = "https://example.com/#plan";
  one.append(outside);
  const away = new window.MouseEvent("click", { bubbles: true, cancelable: true });
  // jsdom doesn't navigate; only whether the click was taken matters.
  outside.addEventListener("click", (event) => event.preventDefault(), { once: true });
  await act(async () => outside.dispatchEvent(away));
  assert.equal(opened.length, 1);
  await act(async () => root.unmount());
});

test("the # beside a hovered heading copies its link", async () => {
  history.replaceState(null, "", `/p/${pageId}`);
  scrolled.length = 0;
  let copied = null;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => (copied = text) },
  });
  const { article, root, notices } = await mount();
  drawBlock(article, "two", "<h2>Plan</h2><h2>Getting lean: Automerge</h2>");
  const heading = article.querySelectorAll("h2")[1];
  await act(async () =>
    heading.dispatchEvent(new window.MouseEvent("pointerover", { bubbles: true })),
  );
  await frames();
  const button = document.querySelector(".heading-anchor");
  assert.ok(button, "the # shows");
  assert.equal(button.getAttribute("aria-label"), "Copy link to section Getting lean: Automerge");
  await act(async () => button.click());
  await frames();
  assert.equal(copied, `http://localhost/p/${pageId}#getting-lean-automerge`);
  assert.deepEqual(notices, ["Link to section copied"]);
  assert.deepEqual(scrolled, ["Getting lean: Automerge"]);
  await act(async () =>
    article.dispatchEvent(new window.MouseEvent("pointerleave", { bubbles: false })),
  );
  assert.equal(document.querySelector(".heading-anchor"), null);
  await act(async () => root.unmount());
});

/**
 * Lays out block "two" as the browser would: an 848px article 100px from
 * the viewport's left, whose 24px left padding is the gutter, and "Plan"
 * 32px tall at the content's left edge. `under.current` is what the column shows at the pointer's height.
 */
async function hoverLayout() {
  history.replaceState(null, "", `/p/${pageId}`);
  const mounted = await mount();
  const { article } = mounted;
  // The shell draws the "#" inside the article, so its events reach it.
  article.append(document.body.lastElementChild);
  drawBlock(article, "two", "<h2>Plan</h2><p>Body</p><h2>Getting lean: Automerge</h2>");
  const [plan, body] = [article.querySelector("h2"), article.querySelector("p")];
  article.getBoundingClientRect = () => ({ left: 100, top: 0, right: 948, width: 848 });
  plan.getBoundingClientRect = () => ({ left: 124, top: 0, right: 948, height: 32 });
  const under = { current: plan };
  document.elementFromPoint = (x) => (x < 124 ? article : under.current);
  const pointer = (type, target, clientX) =>
    act(async () =>
      target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, clientX, clientY: 10 })),
    );
  const button = () => document.querySelector(".heading-anchor");
  const shown = () => button()?.getAttribute("aria-label");
  const wait = (ms) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
  const done = async () => {
    delete document.elementFromPoint;
    await act(async () => mounted.root.unmount());
  };
  return { ...mounted, plan, body, under, pointer, button, shown, wait, done };
}
const PLAN = "Copy link to section Plan";

test("the gutter beside a heading shows its #, which stays while the pointer is on it", async () => {
  const { article, body, under, pointer, button, shown, wait, done } = await hoverLayout();
  try {
    await pointer("pointermove", article, 110);
    await frames();
    assert.equal(shown(), PLAN, "the gutter beside a heading shows its #");
    assert.deepEqual([button().style.left, button().style.top], ["0px", "4px"]);

    under.current = body;
    await pointer("pointermove", body, 200);
    await frames();
    assert.equal(shown(), PLAN, "a brief detour keeps the #");
    await pointer("pointerover", button(), 112);
    await frames();
    await wait(200);
    assert.equal(shown(), PLAN, "reaching the # cancels its hiding");

    await pointer("pointermove", body, 200);
    await frames();
    await wait(200);
    assert.equal(shown(), undefined, "off the row, the # goes");
  } finally {
    await done();
  }
});

test("moving on through the Page hides the # without stopping", async () => {
  const { article, body, under, pointer, shown, wait, done } = await hoverLayout();
  try {
    await pointer("pointermove", article, 110);
    await frames();
    assert.equal(shown(), PLAN);
    under.current = body;
    for (let x = 200; x < 500; x += 40) {
      await pointer("pointermove", body, x);
      await frames();
      await wait(30);
    }
    assert.equal(shown(), undefined, "hidden while the pointer is still moving");
  } finally {
    await done();
  }
});

test("scrolling a heading under a still pointer shows its #, but not while typing", async () => {
  const { article, body, plan, under, pointer, shown, done } = await hoverLayout();
  try {
    under.current = body;
    await pointer("pointermove", body, 200);
    await frames();
    assert.equal(shown(), undefined);

    under.current = plan;
    await act(async () => window.dispatchEvent(new window.Event("scroll")));
    await frames();
    assert.equal(shown(), PLAN, "scrolling a heading under the pointer shows its #");

    await act(async () => article.dispatchEvent(new window.KeyboardEvent("keydown")));
    assert.equal(shown(), undefined, "a key hides the #");
    await act(async () => window.dispatchEvent(new window.Event("scroll")));
    await pointer("pointerover", plan, 200);
    await frames();
    assert.equal(shown(), undefined, "a scroll after a key, PageDown say, keeps it hidden");

    await pointer("pointermove", plan, 210);
    await frames();
    assert.equal(shown(), PLAN, "moving the pointer shows it again");
  } finally {
    await done();
  }
});

test("a sample from before the pointer left the Page doesn't show the #", async () => {
  const { article, plan, pointer, shown, done } = await hoverLayout();
  try {
    await pointer("pointermove", plan, 200);
    await act(async () =>
      article.dispatchEvent(new window.MouseEvent("pointerleave", { bubbles: false })),
    );
    await frames();
    assert.equal(shown(), undefined);
  } finally {
    await done();
  }
});
