import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", {
  url: "http://localhost/p/page-a",
  pretendToBeVisual: true,
});
const saved = new Map();
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  location: dom.window.location,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  dom.window.close();
  for (const [key, descriptor] of saved)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
});
const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./PageControls.jsx", import.meta.url))],
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
        build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "empty" }));
      },
    },
  ],
});
const { PageControls } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const AGENT_MESSAGE = "Checking the shared passage";
function session({ agents = 1 } = {}) {
  const progress = new Map();
  for (let index = 0; index < agents; index++)
    progress.set(`progress-${index}`, {
      progress_id: `progress-${index}`,
      principal: "account-a",
      displayName: "Ada",
      driver: "Codex",
      agent: `agent ${index}`,
      session: null,
      message: AGENT_MESSAGE,
      targets: [],
      until: 60_000,
      updated: 0,
    });
  return {
    pageId: "page-a",
    identity: { principal: "account-a" },
    canManageAccess: true,
    access: { canRead: true, role: "owner", revision: 1 },
    doc: {},
    now: () => 1000,
    watchPresence: () => () => {},
    observeChange: () => () => {},
    agentProgress: progress,
    agentPresence: new Map(),
    peers: new Map(),
  };
}

async function fixture(t, { phone, agents = 1 } = {}) {
  globalThis.fetch = async () =>
    Response.json({
      owner: { principal: "account-a", displayName: "account-a owner" },
      access: { canManageAccess: true, revision: 1 },
      members: [],
      invites: [],
    });
  const container = document.body.appendChild(document.createElement("div"));
  const outside = document.body.appendChild(document.createElement("button"));
  outside.textContent = "Outside";
  const root = createRoot(container);
  const ran = [];
  const actions = [
    { key: "copy-link", label: "Copy link", run: () => ran.push("copy-link") },
    { key: "trash", label: "Move to Trash", danger: true, run: () => ran.push("trash") },
  ];
  await act(() =>
    root.render(
      createElement(
        PageControls,
        { phone, session: session({ agents }), actions, onReveal: () => {} },
        createElement("button", { "aria-label": "Comments" }, "Comments"),
      ),
    ),
  );
  t.after(async () => {
    await act(() => root.unmount());
    container.remove();
    outside.remove();
  });
  const byName = (name, role = "button") =>
    [...container.querySelectorAll(role === "button" ? "button,summary" : `[role="${role}"]`)].find(
      (element) =>
        (element.getAttribute("aria-label") ?? element.textContent.trim()) === name &&
        (role !== "button" || !element.getAttribute("role")),
    ) ?? null;
  const more = () => byName("More page actions");
  const menu = () => container.querySelector('[role="menu"]');
  const item = (name) =>
    [...container.querySelectorAll('[role="menuitem"]')].find(
      (element) => (element.getAttribute("aria-label") ?? element.textContent.trim()) === name,
    );
  return {
    container,
    outside,
    ran,
    byName,
    more,
    menu,
    item,
    async open() {
      await act(() => more().click());
      assert.ok(menu(), "the ⋯ menu opens");
    },
    async click(element) {
      await act(() => element.click());
    },
    async key(name) {
      await act(() =>
        document.activeElement.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true }),
        ),
      );
    },
    async tap(element) {
      await act(() =>
        element.dispatchEvent(
          new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
        ),
      );
    },
    async focus(element) {
      await act(() => element.focus());
    },
  };
}

test("phone header has ⋯ and Comments, without the standalone Share, activity or Document actions", async (t) => {
  const f = await fixture(t, { phone: true });
  const more = f.more();
  assert.ok(more, "⋯ renders");
  assert.equal(more.getAttribute("aria-haspopup"), "menu");
  assert.equal(more.getAttribute("aria-expanded"), "false");
  assert.ok(f.byName("Comments"), "Comments stays in the header");
  assert.equal(f.byName("Share"), null);
  assert.equal(f.container.querySelector(".page-activity"), null);
  assert.equal(f.byName("Document actions"), null);
  assert.equal(f.container.querySelector('[role="dialog"]'), null);
});

test("desktop header keeps activity, Share, Comments and Document actions, and has no ⋯", async (t) => {
  const f = await fixture(t, { phone: false });
  assert.equal(f.more(), null);
  assert.ok(f.byName("Share"));
  assert.ok(f.byName("Page activity, 1 active session"));
  assert.ok(f.byName("Comments"));
  assert.ok(f.byName("Document actions"));
  const order = [...f.container.querySelectorAll(".page-activity, .page-sharing, button, details")]
    .filter((element) => element.parentElement === f.container)
    .map((element) => element.className || element.getAttribute("aria-label"));
  assert.deepEqual(order, ["page-activity", "page-sharing", "Comments", "document-actions"]);
});

test("⋯ lists Share, Activity and the page actions, and focus moves into the menu", async (t) => {
  const f = await fixture(t, { phone: true });
  await f.open();
  assert.equal(f.more().getAttribute("aria-expanded"), "true");
  assert.equal(f.more().getAttribute("aria-controls"), f.menu().id);
  assert.deepEqual(
    [...f.menu().querySelectorAll('[role="menuitem"]')].map(
      (element) => element.getAttribute("aria-label") ?? element.textContent.trim(),
    ),
    ["Share", "Activity, 1 active session", "Copy link", "Move to Trash"],
  );
  for (const element of f.menu().querySelectorAll('[role="menuitem"]'))
    assert.equal(element.tagName, "BUTTON");
  assert.equal(document.activeElement, f.item("Share"));
  await f.key("ArrowDown");
  assert.equal(document.activeElement, f.item("Activity, 1 active session"));
  await f.key("End");
  assert.equal(document.activeElement, f.item("Move to Trash"));
});

test("choosing Share opens the sharing panel; Escape closes it and returns to ⋯", async (t) => {
  const f = await fixture(t, { phone: true });
  await f.open();
  await f.click(f.item("Share"));
  assert.equal(f.menu(), null, "choosing an item closes the menu");
  const dialog = f.container.querySelector('[role="dialog"][aria-label="Share Page"]');
  assert.ok(dialog, "Share opens the sharing panel");
  assert.match(dialog.textContent, /Share Page/);
  assert.equal(document.activeElement, dialog);
  await f.key("Escape");
  assert.equal(f.container.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, f.more());
});

test("choosing Activity shows the agents and their progress; Escape returns to ⋯", async (t) => {
  const f = await fixture(t, { phone: true });
  await f.open();
  await f.click(f.item("Activity, 1 active session"));
  assert.equal(f.menu(), null);
  const panel = f.container.querySelector('[role="dialog"][aria-label="Page activity"]');
  assert.ok(panel, "Activity opens the activity panel");
  assert.match(panel.textContent, /Page activity/);
  assert.match(panel.textContent, new RegExp(AGENT_MESSAGE));
  assert.match(panel.textContent, /Codex · agent 0/);
  assert.equal(document.activeElement, panel);
  await f.key("Escape");
  assert.equal(f.container.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, f.more());
});

test("the ⋯ menu closes on Escape, a tap outside, focus leaving, and a chosen action", async (t) => {
  const f = await fixture(t, { phone: true });
  await f.open();
  await f.key("Escape");
  assert.equal(f.menu(), null);
  assert.equal(document.activeElement, f.more());
  assert.equal(f.more().getAttribute("aria-expanded"), "false");

  await f.open();
  await f.tap(f.outside);
  assert.equal(f.menu(), null, "a tap outside closes the menu");

  await f.open();
  await f.focus(f.outside);
  assert.equal(f.menu(), null, "focus leaving closes the menu");

  await f.open();
  await f.click(f.more());
  assert.equal(f.menu(), null, "⋯ toggles the menu closed");

  await f.open();
  await f.click(f.item("Copy link"));
  assert.equal(f.menu(), null);
  assert.deepEqual(f.ran, ["copy-link"]);
  assert.equal(document.activeElement, f.more());
});

test("the activity panel closes on a tap outside and when focus leaves", async (t) => {
  const f = await fixture(t, { phone: true });
  const panel = () => f.container.querySelector('[role="dialog"][aria-label="Page activity"]');
  await f.open();
  await f.click(f.item("Activity, 1 active session"));
  assert.ok(panel());
  await f.tap(f.outside);
  assert.equal(panel(), null);
  await f.open();
  await f.click(f.item("Activity, 1 active session"));
  await f.focus(f.outside);
  assert.equal(panel(), null);
});

test("⋯ carries a dot and the session count while anyone is active", async (t) => {
  const f = await fixture(t, { phone: true, agents: 2 });
  assert.ok(f.more().querySelector(".page-menu-indicator"));
  const description = document.getElementById(f.more().getAttribute("aria-describedby"));
  assert.equal(description.textContent, "2 active sessions");
});

test("without activity, ⋯ has no dot and the menu has no Activity entry", async (t) => {
  const f = await fixture(t, { phone: true, agents: 0 });
  assert.equal(f.more().querySelector(".page-menu-indicator"), null);
  assert.equal(f.more().getAttribute("aria-describedby"), null);
  await f.open();
  assert.deepEqual(
    [...f.menu().querySelectorAll('[role="menuitem"]')].map((element) => element.textContent),
    ["Share", "Copy link", "Move to Trash"],
  );
});
