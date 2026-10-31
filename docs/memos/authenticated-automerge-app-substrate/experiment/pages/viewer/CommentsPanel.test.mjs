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
      canWrite: true,
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

test("threads start with full first messages, collapsed replies, and no exposed empty editors", async (t) => {
  const f = await fixture(t);
  const first = f.element("first");
  assert.match(first.querySelector(".message").textContent, /Full first comment first/);
  const toggle = first.querySelector(".thread-replies-toggle");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.textContent.trim(), "2 replies");
  assert.ok(first.querySelector(".thread-replies").hidden);
  for (const textarea of f.container.querySelectorAll("textarea"))
    assert.ok(textarea.closest("[hidden]"));
  await f.click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.match(
    first.querySelector(".thread-replies").textContent,
    /ChatGPTon behalf of Kyle Kelley/,
  );
  await f.click(toggle);
  assert.ok(first.querySelector(".thread-replies").hidden);
  await f.click(first.querySelector(".quote"));
  assert.deepEqual(f.revealed, ["first"]);
  assert.deepEqual(f.calls, []);
});

test("hiding replies and switching threads preserve reply drafts, errors and pending submissions", async (t) => {
  const f = await fixture(t);
  const first = f.element("first"),
    reply = first.querySelector(".thread-reply-button");
  await f.click(reply);
  const textarea = first.querySelector("textarea"),
    form = first.querySelector("form");
  assert.equal(document.activeElement, textarea);
  await f.type(textarea, "Keep this draft");
  const hide = form.querySelector('button[type="button"]');
  await f.click(hide);
  assert.equal(document.activeElement, reply);
  assert.equal(reply.textContent, "Continue reply");
  await f.click(reply);
  assert.equal(first.querySelector("textarea"), textarea);
  assert.equal(textarea.value, "Keep this draft");
  let reject;
  f.props.session.comment = () =>
    new Promise((_, failure) => {
      reject = failure;
    });
  await act(() =>
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })),
  );
  assert.ok(textarea.disabled);
  assert.ok(first.querySelector('[aria-label="Resolve"]').disabled);
  assert.ok(hide.disabled);
  await f.click(f.element("next").querySelector(".quote"));
  await act(async () => {
    reject(Error("Try again later"));
    await Promise.resolve();
  });
  assert.equal(textarea.value, "Keep this draft");
  assert.match(form.querySelector('[role="alert"]').textContent, /Try again later/);
  await f.click(hide);
  await f.click(reply);
  assert.equal(textarea.value, "Keep this draft");
  assert.match(form.querySelector('[role="alert"]').textContent, /Try again later/);
  await f.click(f.element("next").querySelector(".quote"));
  let finish;
  f.props.session.comment = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  await act(() =>
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })),
  );
  const otherFocus = document.activeElement;
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  await tick();
  assert.equal(
    document.activeElement,
    otherFocus,
    "completing a reply must not steal another thread's focus",
  );
  assert.equal(textarea.value, "");
});

test("pointer focus keeps thread controls still until their click, while keyboard focus selects", async (t) => {
  const f = await fixture(t);
  const first = f.element("first"),
    reply = first.querySelector(".thread-reply-button");
  await act(() => {
    reply.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
    reply.focus();
  });
  assert.equal(f.props.target, null, "pointer focus must not expand the quote before pointerup");
  assert.ok(first.querySelector(".thread-replies").hidden);
  await act(() => {
    reply.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
    reply.click();
  });
  await tick();
  assert.equal(f.props.target.id, "first");
  assert.equal(document.activeElement, first.querySelector("textarea"));
  assert.equal(first.querySelector("textarea").closest("[hidden]"), null);

  const next = f.element("next").querySelector(".thread-reply-button");
  await act(() => next.focus());
  assert.equal(f.props.target.id, "next", "keyboard focus still selects its passage");
});

test("selecting a thread never competes with its explicit replies disclosure", async (t) => {
  const f = await fixture(t);
  const first = f.element("first"),
    toggle = first.querySelector(".thread-replies-toggle");
  await act(() => first.querySelector(".quote").focus());
  assert.equal(f.props.target.id, "first");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  await f.click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  await f.click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  await f.click(f.element("next").querySelector(".quote"));
  await act(() => {
    toggle.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
    toggle.focus();
  });
  await act(() => {
    toggle.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
    toggle.click();
  });
  assert.equal(f.props.target.id, "first");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
});

test("switching dialog modality preserves the active reply and its caret", async (t) => {
  const previousMatchMedia = globalThis.matchMedia;
  const listeners = new Set();
  const media = {
    matches: false,
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener),
  };
  globalThis.matchMedia = () => media;
  const prototype = dom.window.HTMLDialogElement.prototype;
  const previousShow = prototype.show,
    previousModal = prototype.showModal;
  // Opening a native dialog can focus its first control. The resize must restore
  // the reply that was focused before close/reopen rather than keeping that focus.
  prototype.show = prototype.showModal = function () {
    this.open = true;
    this.querySelector("button")?.focus();
  };
  t.after(() => {
    globalThis.matchMedia = previousMatchMedia;
    prototype.show = previousShow;
    prototype.showModal = previousModal;
  });
  const f = await fixture(t);
  const first = f.element("first");
  await f.click(first.querySelector(".thread-reply-button"));
  const textarea = first.querySelector("textarea");
  await f.type(textarea, "A reply in progress");
  textarea.setSelectionRange(2, 7, "backward");
  for (const mobile of [true, false]) {
    await act(() => {
      media.matches = mobile;
      for (const listener of listeners) listener();
    });
    assert.equal(document.activeElement, textarea);
    assert.equal(textarea.value, "A reply in progress");
    assert.deepEqual(
      [textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection],
      [2, 7, "backward"],
    );
    assert.equal(f.container.querySelector("dialog").classList.contains("comments-sheet"), mobile);
  }
});

test("resolve/reopen restore focus and selected resolved threads remain discoverable", async (t) => {
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
  await f.click(f.element("first").querySelector('[aria-label="Resolve"]'));
  assert.equal(document.activeElement, f.element("next").querySelector(".quote"));
  f.props.target = { id: "first" };
  await f.render();
  assert.ok(f.container.querySelector(".resolved-threads").open);
  await f.click(f.element("first").querySelector('[aria-label="Reopen"]'));
  assert.equal(document.activeElement, f.element("first").querySelector(".quote"));
  assert.deepEqual(
    f.calls.map(({ action }) => action),
    ["resolve", "reopen"],
  );
});

test("viewers retain discussion and passage access without reply or state-changing controls", async (t) => {
  const f = await fixture(t, { session: { doc: { blocks: { block: {} } }, canWrite: false } });
  assert.equal(f.container.querySelectorAll("textarea").length, 0);
  assert.equal(
    f.container.querySelectorAll(".thread-state-action, .thread-reply-button").length,
    0,
  );
  await f.click(f.element("first").querySelector(".thread-replies-toggle"));
  assert.equal(f.element("first").querySelector(".thread-replies").hidden, false);
  await f.click(f.element("first").querySelector(".quote"));
  assert.deepEqual(f.revealed, ["first"]);
});

test("a reply draft on a resolved thread blocks Reload and stays reachable to copy or discard", async (t) => {
  const copied = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => void copied.push(text) },
  });
  t.after(() => delete navigator.clipboard);
  const f = await fixture(t);
  assert.equal(reloadGate.hasDrafts(), false);
  await f.click(f.element("first").querySelector(".thread-reply-button"));
  await f.type(f.element("first").querySelector("textarea"), "Reply typed before resolve");
  assert.equal(reloadGate.hasDrafts(), true);
  // Another collaborator resolves the thread while the reply is unsent.
  f.props.threads = f.props.threads.map((thread) =>
    thread.id === "first" ? { ...thread, state: "resolved" } : thread,
  );
  await f.render();
  assert.equal(reloadGate.hasDrafts(), true, "resolved threads still count");
  const disclosure = f.container.querySelector(".resolved-threads");
  assert.ok(disclosure.open, "the disclosure opens to show the draft");
  assert.match(disclosure.querySelector("summary").textContent, /unsent reply/);
  const first = f.element("first");
  assert.equal(first.querySelector("textarea").closest("[hidden]"), null);
  assert.match(first.textContent, /Unsent reply/);
  const textarea = first.querySelector("textarea");
  assert.equal(textarea.value, "Reply typed before resolve");
  assert.equal(textarea.disabled, true);
  const button = (name) =>
    [...first.querySelectorAll("button")].find((b) => b.textContent.trim() === name);
  assert.equal(button("Send").disabled, true);
  assert.equal(button("Hide reply"), undefined);
  await f.click(button("Copy"));
  assert.deepEqual(copied, ["Reply typed before resolve"]);
  assert.ok(button("Copied"));
  await f.click(button("Discard"));
  assert.equal(reloadGate.hasDrafts(), false);
  assert.equal(f.element("first").querySelector("textarea"), null);
  assert.deepEqual(f.calls, []);
});

test("a reply draft kept after write access ends can still be copied or discarded", async (t) => {
  const f = await fixture(t);
  await f.click(f.element("next").querySelector(".thread-reply-button"));
  await f.type(f.element("next").querySelector("textarea"), "Draft before downgrade");
  f.props.session = { ...f.props.session, canWrite: false };
  await f.render();
  const next = f.element("next");
  assert.equal(next.querySelector(".thread-reply-button"), null);
  assert.equal(next.querySelector("textarea").disabled, true);
  assert.equal(next.querySelector("textarea").closest("[hidden]"), null);
  assert.equal(reloadGate.hasDrafts(), true);
  const discard = [...next.querySelectorAll("button")].find((b) => b.textContent === "Discard");
  await f.click(discard);
  assert.equal(reloadGate.hasDrafts(), false);
  assert.equal(f.element("next").querySelector("textarea"), null);
});

test("turning into the modal sheet closes the inline composer back to its kept draft", async (t) => {
  const previousMatchMedia = globalThis.matchMedia;
  const listeners = new Set();
  const media = {
    matches: false,
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener),
  };
  globalThis.matchMedia = () => media;
  t.after(() => {
    globalThis.matchMedia = previousMatchMedia;
  });
  const { CommentComposer } = await import("./comment-composer.mjs");
  const composer = new CommentComposer({ send: () => null });
  const f = await fixture(t, { composer });
  // Desktop: the panel is docked open and Continue (or Comment) opened the
  // composer beside it.
  await act(() => {
    composer.start({ blockId: "block", target: { kind: "block", blockId: "block" } }, "quote");
    composer.change("Still writing");
  });
  assert.equal(composer.snapshot().state.name, "open");
  assert.equal(f.container.querySelector(".comment-kept-draft"), null);
  await act(() => {
    media.matches = true;
    for (const listener of listeners) listener();
  });
  assert.equal(composer.snapshot().state.name, "dismissed");
  assert.equal(composer.snapshot().body, "Still writing");
  const dialog = f.container.querySelector("dialog");
  assert.ok(dialog.classList.contains("comments-sheet"));
  assert.equal(
    f.container.querySelector(".comment-kept-draft-text").textContent,
    "Still writing",
    "the draft shows as an unsent comment in the sheet",
  );
});
