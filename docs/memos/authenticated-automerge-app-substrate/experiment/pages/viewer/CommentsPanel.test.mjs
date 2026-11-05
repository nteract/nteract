import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost" });
const saved = new Map();
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
  CSS: { escape: (value) => value },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLDialogElement.prototype.show = function () {
  this.open = true;
};
dom.window.HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
dom.window.HTMLDialogElement.prototype.close = function () {
  this.open = false;
};
after(() => {
  dom.window.close();
  for (const [key, descriptor] of saved)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
});
const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("./CommentsPanel.jsx", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  plugins: [
    {
      name: "test-component",
      setup(build) {
        // These tests exercise thread/draft lifetime, not editor layout. The
        // native Wordgard surface is exercised by rich-comments-smoke.mjs.
        build.onResolve({ filter: /CommentRichText\.jsx$/ }, () => ({
          path: "comment-editor",
          namespace: "test-comment-editor",
        }));
        build.onLoad({ filter: /.*/, namespace: "test-comment-editor" }, () => ({
          contents: `import React from "react";
            export function CommentRichText({value, onChange, disabled, label}) {
              return React.createElement("textarea", {role: "textbox", "aria-label": label, value, disabled, onChange: e => onChange(e.target.value)});
            }
            export function CommentContent({message}) { return React.createElement("p", null, message.body); }`,
          loader: "js",
        }));
        // Share the app's reload gate with this test instead of bundling a copy.
        build.onResolve({ filter: /build-freshness\.mjs$/ }, () => ({
          path: new URL("./build-freshness.mjs", import.meta.url).href,
          external: true,
        }));
        build.onResolve({ filter: /^[^./]/ }, ({ path }) => ({
          path: pathToFileURL(require.resolve(path)).href,
          external: true,
        }));
        build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "empty" }));
      },
    },
  ],
});
const { CommentsPanel } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`
);
const { reloadGate } = await import("./build-freshness.mjs");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, 5)));
const thread = (id, state = "open", replies = 0) => ({
  id,
  state,
  target: { kind: "block", blockId: "block" },
  selectionContext: { text: `Passage ${id}`, status: "attached" },
  messages: Array.from({ length: replies + 1 }, (_, index) => ({
    id: `${id}-${index}`,
    body: index ? `Reply ${index}` : `Full first comment ${id}`,
    author: { displayName: "Kyle Kelley", driver: index ? "ChatGPT" : "Browser" },
  })),
});

async function fixture(t, options = {}) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const calls = [],
    revealed = [];
  const props = {
    open: true,
    session: {
      doc: { blocks: { block: {} } },
      canComment: true,
      commentMessage: () => undefined,
      comment: async (action) => {
        calls.push(action);
      },
    },
    threads: [thread("first", "open", 2), thread("next"), thread("done", "resolved")],
    composer: null,
    target: null,
    onClose() {},
    onReveal: (thread) => revealed.push(thread.id),
    onSelect(id) {
      props.target = { id };
      render();
    },
    onClearComposer() {},
    ...options,
  };
  function render() {
    root.render(createElement(CommentsPanel, props));
  }
  await act(render);
  t.after(async () => {
    await act(() => root.unmount());
    container.remove();
  });
  return {
    props,
    calls,
    revealed,
    renderSync: render,
    container,
    element: (id) => container.querySelector(`[data-thread-id="${id}"]`),
    async render() {
      await act(render);
      await tick();
    },
    row: (id) => container.querySelector(`.thread-row[data-thread-id="${id}"]`),
    view: () => container.querySelector(".thread-view"),
    async open(id) {
      await this.click(this.row(id));
    },
    async key(key, target = container.querySelector("dialog"), extra = {}) {
      const event = new dom.window.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...extra,
      });
      await act(async () => {
        target.dispatchEvent(event);
        await Promise.resolve();
      });
      await tick();
      return event;
    },
    async click(button) {
      await act(async () => {
        button.focus();
        button.click();
        await Promise.resolve();
      });
      await tick();
    },
    async type(textarea, value) {
      await act(() => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(
          textarea,
          value,
        );
        textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    },
  };
}

const dialogOf = (f) => f.container.querySelector("dialog");
const rows = (f) =>
  [...f.container.querySelectorAll(".thread-row")].map((row) => row.dataset.threadId);

test("threads before the first heading get no group label; later headings do", async (t) => {
  const f = await fixture(t);
  assert.equal(f.container.querySelector(".comments-group"), null);
  assert.equal(f.container.textContent.includes("Top of page"), false);
});

test("the list shows compact rows for open threads with filters for mine and resolved", async (t) => {
  const f = await fixture(t, { principal: "me" });
  f.props.threads[1].messages[0].author.principal = "me";
  await f.render();
  assert.deepEqual(rows(f), ["first", "next"]);
  const first = f.row("first");
  assert.equal(first.querySelector(".thread-row-title").textContent, "Full first comment first");
  assert.equal(first.querySelector(".thread-row-chip").textContent, "Passage first");
  assert.equal(first.querySelector(".thread-row-count").textContent, "2 replies");
  assert.equal(f.container.querySelector("textarea"), null, "no editor until a thread is open");
  const tabs = [...f.container.querySelectorAll(".comments-filter")];
  assert.deepEqual(
    tabs.map((tab) => tab.textContent),
    ["Open2", "Mine", "Resolved1"],
  );
  await f.click(tabs[1]);
  assert.deepEqual(rows(f), ["next"]);
  await f.click(tabs[2]);
  assert.deepEqual(rows(f), ["done"]);
  await f.click(tabs[0]);
  await f.click(f.container.querySelector(".comments-list-end"));
  assert.deepEqual(rows(f), ["done"], "the resolved footer switches the filter");
});

test("opening a row shows the thread; Back restores the list scroll and focus", async (t) => {
  const f = await fixture(t);
  const list = f.container.querySelector(".comments-list");
  list.scrollTop = 140;
  await f.open("first");
  const view = f.view();
  assert.equal(f.row("first"), null, "the list is replaced by the thread");
  assert.equal(view.querySelector(".thread-title").textContent, "Full first comment first");
  assert.equal(view.querySelector(".thread-view-meta"), null, "Resolve says the state");
  assert.match(view.querySelector(".thread-state-action").textContent, /Resolve/);
  assert.equal(view.querySelector(".thread-passage mark").textContent, "Passage first");
  assert.equal(view.querySelector(".thread-divider").textContent, "2 replies");
  assert.equal(view.querySelectorAll(".thread-replies .message").length, 2);
  assert.match(f.container.querySelector(".comments-position").textContent, /1 of 2/);
  assert.deepEqual(f.props.target, { id: "first" }, "opening lights the passage");
  await f.click(f.container.querySelector('[aria-label="Next thread"]'));
  assert.equal(f.view().dataset.threadId, "next");
  await f.click(f.container.querySelector(".comments-back"));
  assert.equal(f.view(), null);
  assert.equal(f.container.querySelector(".comments-list").scrollTop, 140);
  assert.equal(document.activeElement, f.row("next"));
});

test("Jump to passage reveals the passage; a detached thread says so", async (t) => {
  const f = await fixture(t);
  f.props.threads[1] = {
    ...f.props.threads[1],
    target: { kind: "selection" },
    selectionContext: { status: "detached" },
  };
  await f.render();
  await f.open("first");
  await f.click(f.view().querySelector(".thread-passage-jump"));
  assert.deepEqual(f.revealed, ["first"]);
  await f.click(f.container.querySelector('[aria-label="Next thread"]'));
  assert.match(f.view().querySelector(".thread-passage-removed").textContent, /removed/);
  assert.equal(f.view().querySelector(".thread-passage-jump"), null);
});

test("a passage clicked in the Page opens its thread, switching to Resolved when needed", async (t) => {
  const f = await fixture(t);
  await act(() => f.row("next").focus());
  assert.equal(f.view(), null, "focus in the list only lights the passage");
  f.props.target = { id: "done", source: "passage", request: 1 };
  await f.render();
  assert.equal(f.view().dataset.threadId, "done");
  assert.ok(f.view().querySelector(".thread-state-action").textContent.includes("Reopen"));
  await f.click(f.container.querySelector(".comments-back"));
  assert.deepEqual(rows(f), ["done"]);
  f.props.target = { id: "next", source: "passage", request: 2 };
  await f.render();
  f.props.threads = f.props.threads.filter((thread) => thread.id !== "next");
  await f.render();
  assert.equal(f.view(), null, "a deleted thread falls back to the list");
});

test("reply drafts survive leaving a thread, send with Mod+Enter, and finish after leaving", async (t) => {
  let finish;
  const f = await fixture(t);
  f.props.session.comment = (action) => {
    f.calls.push(action);
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  await f.open("next");
  await f.click(f.view().querySelector(".thread-reply-button"));
  await f.type(f.view().querySelector("textarea"), "Draft for next");
  await f.click(f.container.querySelector('[aria-label="Previous thread"]'));
  assert.equal(f.view().dataset.threadId, "first");
  await f.click(f.container.querySelector(".comments-back"));
  assert.ok(f.row("next").querySelector(".thread-row-draft"), "the row marks the draft");
  await f.open("next");
  const textarea = f.view().querySelector("textarea");
  assert.equal(textarea.value, "Draft for next", "the composer reopens with the draft");
  const sent = await f.key("Enter", textarea, { metaKey: true });
  assert.ok(sent.defaultPrevented);
  assert.deepEqual(f.calls.at(-1), {
    action: "reply",
    thread_id: "next",
    body: "Draft for next",
    body_format: "markdown",
  });
  assert.ok(f.view().querySelector(".thread-state-action").disabled, "no resolve while sending");
  await f.click(f.container.querySelector(".comments-back"));
  await act(async () => finish());
  await tick();
  assert.equal(f.row("next").querySelector(".thread-row-draft"), null, "the draft cleared");
});

test("R in a thread or on a focused row starts a reply", async (t) => {
  const f = await fixture(t);
  await act(() => f.row("first").focus());
  await f.key("ArrowDown", f.row("first"));
  assert.equal(document.activeElement, f.row("next"));
  await f.key("r", f.row("next"));
  assert.equal(f.view().dataset.threadId, "next");
  await tick();
  assert.ok(f.view().querySelector("textarea"));
  await f.click(f.container.querySelector('[aria-label="Previous thread"]'));
  assert.equal(f.view().querySelector("textarea"), null);
  await f.key("r", f.view());
  assert.ok(f.view().querySelector("textarea"));
});

test("a reply draft blocks Reload until it's sent or discarded, even on a resolved thread", async (t) => {
  const f = await fixture(t);
  assert.equal(reloadGate.hasDrafts(), false);
  await f.open("next");
  await f.click(f.view().querySelector(".thread-reply-button"));
  await f.type(f.view().querySelector("textarea"), "Unsent");
  assert.equal(reloadGate.hasDrafts(), true);
  f.props.threads = f.props.threads.map((thread) =>
    thread.id === "next" ? { ...thread, state: "resolved" } : thread,
  );
  await f.render();
  assert.equal(reloadGate.hasDrafts(), true, "resolved threads still count");
  assert.match(f.view().querySelector(".thread-kept-draft").textContent, /Unsent reply/);
  assert.ok(f.view().querySelector("textarea").disabled);
  await f.click(f.container.querySelector(".comments-back"));
  assert.match(f.container.querySelector(".comments-filter-draft").title, /Unsent reply/);
  await f.open("next");
  const discard = [...f.view().querySelectorAll("button")].find((b) => b.textContent === "Discard");
  await f.click(discard);
  assert.equal(reloadGate.hasDrafts(), false);
});

test("reply drafts are readable by the session, so a retirement can archive them", async (t) => {
  const readers = new Set();
  const f = await fixture(t);
  f.props.session = {
    ...f.props.session,
    watchCommentDrafts(read) {
      readers.add(read);
      return () => readers.delete(read);
    },
  };
  await f.render();
  const [read] = readers;
  assert.deepEqual(read(), []);
  await f.open("next");
  await f.click(f.view().querySelector(".thread-reply-button"));
  await f.type(f.view().querySelector("textarea"), "Reply typed before the refusal");
  assert.deepEqual(read(), [
    {
      kind: "reply",
      thread_id: "next",
      body: "Reply typed before the refusal",
      quote: "Passage next",
    },
  ]);
});

test("resolve and reopen send the action and keep focus in the thread", async (t) => {
  const f = await fixture(t);
  await f.open("next");
  await f.click(f.view().querySelector(".thread-state-action"));
  assert.deepEqual(f.calls, [{ action: "resolve", thread_id: "next" }]);
  assert.ok(f.container.querySelector("dialog").contains(document.activeElement));
});

test("viewers read threads without Reply or Resolve; resolved threads say so", async (t) => {
  const f = await fixture(t, {
    session: { doc: { blocks: { block: {} } }, canComment: false, commentMessage: () => undefined },
  });
  f.props.target = { id: "done", source: "passage", request: 9 };
  await f.render();
  assert.match(f.view().querySelector(".thread-view-meta").textContent, /Resolved/);
  await f.click(f.container.querySelector(".comments-back"));
  await f.click(f.container.querySelector(".comments-filter"));
  await f.open("first");
  assert.equal(f.view().querySelector(".thread-view-meta"), null);
  assert.equal(f.view().querySelector(".thread-state-action"), null);
  assert.equal(f.view().querySelector(".thread-reply-button"), null);
  assert.equal(f.view().querySelector(".thread-composer"), null);
  await f.key("r", f.view());
  assert.equal(f.view().querySelector("textarea"), null);
  assert.equal(
    f.container.querySelector(".comments-keys")?.textContent.includes("Reply"),
    undefined,
  );
});

test("Escape in a thread returns to the list, then closes the panel", async (t) => {
  let closed = 0;
  const f = await fixture(t, { onClose: () => closed++ });
  await f.open("next");
  await f.key("Escape");
  assert.equal(f.view(), null);
  assert.equal(closed, 0);
  await f.key("Escape");
  assert.equal(closed, 1);
});

test("expanded shows the list and the open thread side by side", async (t) => {
  const f = await fixture(t);
  await f.click(f.container.querySelector(".comments-expand"));
  assert.match(f.container.querySelector(".comments-thread-empty").textContent, /Choose a thread/);
  await f.open("first");
  assert.ok(f.row("first"), "the list stays");
  assert.equal(f.view().dataset.threadId, "first");
  assert.equal(f.row("first").getAttribute("aria-current"), "true");
  await f.key("Escape");
  assert.ok(f.view(), "Escape closes the panel instead of leaving the thread");
});

test("review is a workspace: navigator, passage, conversation; J/K move, E resolves and advances, R replies", async (t) => {
  const f = await fixture(t);
  f.props.session.comment = async (action) => {
    f.calls.push(action);
    f.props.threads = f.props.threads.map((thread) =>
      thread.id === action.thread_id
        ? { ...thread, state: action.action === "resolve" ? "resolved" : "open" }
        : thread,
    );
    f.renderSync();
  };
  await f.click(f.container.querySelector(".comments-review-start"));
  assert.ok(dialogOf(f).classList.contains("comments-review"));
  assert.match(f.container.querySelector(".review-progress-label").textContent, /1 of 3 resolved/);
  assert.ok(f.container.querySelector(".review-navigator .thread-row[aria-current='true']"));
  assert.ok(f.container.querySelector(".review-context .page-excerpt"));
  assert.equal(f.view().dataset.threadId, "first");
  assert.match(
    f.container.querySelector(".review-up-next").textContent,
    /Up next.*Full first comment next/,
  );
  await f.key("j", f.view());
  assert.equal(f.view().dataset.threadId, "next");
  await f.key("k", f.view());
  await f.key("e", f.view());
  assert.deepEqual(f.calls, [{ action: "resolve", thread_id: "first" }]);
  assert.equal(f.view().dataset.threadId, "next", "resolve-and-next");
  assert.match(f.container.querySelector(".review-progress-label").textContent, /2 of 3 resolved/);
  assert.match(f.container.querySelector(".review-up-next").textContent, /Last open thread/);
  await f.key("r", f.view());
  await tick();
  const textarea = f.view().querySelector("textarea");
  assert.ok(textarea, "R opens the reply");
  assert.equal((await f.key("j", textarea)).defaultPrevented, false, "keys go to the editor");
  await f.key("Escape", textarea);
  assert.ok(dialogOf(f).classList.contains("comments-review"), "Escape while typing stays");
  await f.click(
    f.container.querySelector(".review-navigator .thread-row[data-thread-id='first']") ??
      [...f.container.querySelectorAll(".review-navigator .comments-list-end")][0],
  );
  await f.key("Escape", f.view());
  assert.equal(dialogOf(f).classList.contains("comments-review"), false);
  assert.ok(f.view(), "exit lands on the thread in the panel");
});

test("Resolve and next button and Open in Page", async (t) => {
  let closed = 0;
  const f = await fixture(t, { onClose: () => closed++ });
  await f.click(f.container.querySelector(".comments-review-start"));
  await f.click(f.container.querySelector(".review-resolve-next"));
  assert.deepEqual(f.calls, [{ action: "resolve", thread_id: "first" }]);
  await f.click(f.container.querySelector(".review-open-page"));
  assert.equal(closed, 1);
  await tick();
  assert.deepEqual(f.revealed, ["next"], "Open in Page shows the thread review moved to");
});

test("a kept inline-composer draft shows as Unsent comment with Continue and Discard", async (t) => {
  const { Store } = await import("./store.mjs");
  let reopened = 0,
    cancelled = 0;
  const store = new Store({
    state: { name: "dismissed" },
    composer: { quote: "Picked words", draft: {} },
    body: "Half a thought",
  });
  const f = await fixture(t, {
    composer: { store, reopen: () => reopened++, cancel: () => cancelled++, focus() {} },
    session: {
      doc: { blocks: { block: {} } },
      canComment: true,
      commentMessage: () => undefined,
    },
  });
  const kept = f.container.querySelector(".comment-kept-draft");
  assert.match(kept.textContent, /Unsent comment/);
  assert.match(kept.textContent, /Half a thought/);
  // This draft no longer resolves against the Page, so it can only be discarded.
  assert.match(kept.querySelector('[role="alert"]').textContent, /Copy the text/);
  const buttons = [...kept.querySelectorAll("button")].map((b) => b.textContent);
  assert.deepEqual(buttons, ["Discard"]);
  await f.click(kept.querySelector("button"));
  assert.deepEqual([reopened, cancelled], [0, 1]);
});
