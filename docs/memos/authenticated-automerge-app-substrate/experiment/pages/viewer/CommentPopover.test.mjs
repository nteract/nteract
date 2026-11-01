// CommentPopover's keyboard and button contract over a real CommentComposer,
// and how it shares narrow windows with CommentsPanel. Layout and focus
// movement across the Page are covered by scripts/rich-comments-smoke.mjs.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost" });
let sheet = false;
const mediaListeners = new Set();
const media = {
  get matches() {
    return sheet;
  },
  addEventListener: (_, listener) => mediaListeners.add(listener),
  removeEventListener: (_, listener) => mediaListeners.delete(listener),
};
const saved = new Map();
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  CSS: { escape: (value) => value },
  matchMedia: () => media,
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
  innerWidth: 1200,
  innerHeight: 800,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
// jsdom has no dialog modality; record which way the panel opened.
Object.assign(dom.window.HTMLDialogElement.prototype, {
  show() {
    this.open = true;
    this.dataset.modal = "false";
  },
  showModal() {
    this.open = true;
    this.dataset.modal = "true";
  },
  close() {
    this.open = false;
  },
});
after(() => {
  dom.window.close();
  for (const [key, descriptor] of saved)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
});
const require = createRequire(import.meta.url);
const bundled = await build({
  stdin: {
    contents: `export * from "./CommentPopover.jsx"; export { CommentsPanel } from "./CommentsPanel.jsx";`,
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    loader: "js",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  plugins: [
    {
      name: "test-component",
      setup(build) {
        build.onResolve({ filter: /CommentRichText\.jsx$/ }, () => ({
          path: "comment-editor",
          namespace: "test-stub",
        }));
        // The draft's anchors are covered by comment-draft.test.mjs. Here a
        // draft is broken only when the test says so.
        build.onResolve({ filter: /comment-draft\.mjs$/ }, () => ({
          path: "comment-draft",
          namespace: "test-stub",
        }));
        build.onLoad({ filter: /^comment-editor$/, namespace: "test-stub" }, () => ({
          contents: `import React from "react";
            export function CommentRichText({value, onChange, disabled, label}) {
              return React.createElement("textarea", {role: "textbox", "aria-label": label, value, disabled, onChange: e => onChange(e.target.value)});
            }
            export function CommentContent({message}) { return React.createElement("p", null, message.body); }`,
          loader: "js",
        }));
        build.onLoad({ filter: /^comment-draft$/, namespace: "test-stub" }, () => ({
          contents: `export function resolveCommentDraft(doc, draft) {
              if (draft.broken) throw Error("Selected passage was removed or replaced; select it again");
              return { block_id: draft.blockId };
            }`,
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
const { CommentPopover, CommentsPanel, COMMENT_POPOVER_LABEL, PASSAGE_REMOVED_NOTE } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`
);
const { CommentComposer } = await import("./comment-composer.mjs");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 5)));
const setSheet = (value) =>
  act(() => {
    sheet = value;
    for (const listener of mediaListeners) listener();
  });

async function fixture(t, { canWrite = true, send = () => "thread-1", draft = {} } = {}) {
  const container = document.body.appendChild(document.createElement("div"));
  const article = document.body.appendChild(document.createElement("article"));
  const root = createRoot(container);
  const calls = [];
  const composer = new CommentComposer({
    send: (current, body) => {
      calls.push(["send", body]);
      return send(current, body);
    },
    returnFocus: () => calls.push(["returnFocus"]),
    flash: (id) => calls.push(["flash", id]),
  });
  const session = { doc: {}, canWrite };
  await act(() =>
    root.render(
      createElement(CommentPopover, { composer, session, containerRef: { current: article } }),
    ),
  );
  t.after(async () => {
    await act(() => root.unmount());
    container.remove();
    article.remove();
  });
  const open = async (text = "") => {
    await act(() => {
      composer.start({ blockId: "block", target: { kind: "selection" }, ...draft }, "quote");
      if (text) composer.change(text);
    });
  };
  const key = async (target, init) => {
    await act(async () => {
      target.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
      );
    });
    await settle();
  };
  return {
    composer,
    calls,
    open,
    key,
    dialog: () => container.querySelector("dialog"),
    textbox: () => container.querySelector('[role="textbox"]'),
    button: (name) =>
      [...container.querySelectorAll("button")].find((button) => button.textContent === name),
  };
}

test("nothing renders until Comment is chosen; then a labelled dialog holds the composer", async (t) => {
  const view = await fixture(t);
  assert.equal(view.dialog(), null);
  await view.open();
  const dialog = view.dialog();
  assert.equal(dialog.getAttribute("aria-label"), COMMENT_POPOVER_LABEL);
  assert.equal(dialog.getAttribute("aria-label"), "Comment on selection");
  assert.equal(dialog.open, true);
  assert.equal(view.textbox().getAttribute("aria-label"), "Comment on selection");
  assert.ok(view.button("Cancel"));
  assert.equal(view.button("Comment").disabled, true, "an empty draft can't be sent");
});

test("Escape closes the popover, keeps the text, and asks for focus back", async (t) => {
  const view = await fixture(t);
  await view.open("Keep this");
  await view.key(view.textbox(), { key: "Escape" });
  assert.equal(view.dialog(), null);
  assert.equal(view.composer.snapshot().state.name, "dismissed");
  assert.equal(view.composer.snapshot().body, "Keep this");
  assert.deepEqual(view.calls, [["returnFocus"]]);
  await act(() => view.composer.reopen());
  assert.equal(view.textbox().value, "Keep this", "reopening restores the draft");
});

test("an Escape a nested control already handled leaves the popover open", async (t) => {
  const view = await fixture(t);
  await view.open("Text");
  const textbox = view.textbox();
  textbox.addEventListener("keydown", (event) => event.preventDefault());
  await view.key(textbox, { key: "Escape" });
  assert.equal(view.composer.snapshot().state.name, "open");
});

for (const modifier of ["metaKey", "ctrlKey"])
  test(`Mod+Enter (${modifier}) sends, closes, and flashes the new thread`, async (t) => {
    const view = await fixture(t);
    await view.open("Ship it");
    await view.key(view.textbox(), { key: "Enter", [modifier]: true });
    assert.deepEqual(view.calls, [["send", "Ship it"], ["flash", "thread-1"], ["returnFocus"]]);
    assert.equal(view.dialog(), null);
    assert.equal(view.composer.snapshot().state.name, "idle");
  });

test("Mod+Enter on an empty draft sends nothing", async (t) => {
  const view = await fixture(t);
  await view.open();
  await view.key(view.textbox(), { key: "Enter", metaKey: true });
  assert.deepEqual(view.calls, []);
  assert.equal(view.composer.snapshot().state.name, "open");
});

test("the Comment button sends; while sending the controls are disabled", async (t) => {
  let finish;
  const view = await fixture(t, { send: () => new Promise((resolve) => (finish = resolve)) });
  await view.open("Pending");
  await act(async () => view.button("Comment").click());
  assert.equal(view.composer.snapshot().state.name, "sending");
  assert.equal(view.textbox().disabled, true);
  assert.equal(view.button("Cancel").disabled, true);
  assert.equal(view.button("Commenting…").disabled, true);
  await view.key(view.textbox(), { key: "Escape" });
  assert.ok(view.dialog(), "Escape waits for the send");
  await act(async () => finish("thread-2"));
  await settle();
  assert.equal(view.dialog(), null);
  assert.deepEqual(view.calls.slice(1), [["flash", "thread-2"], ["returnFocus"]]);
});

test("a failed send stays open with the reason and the text", async (t) => {
  const view = await fixture(t, {
    send: () => Promise.reject(Error("This Page is read only")),
  });
  await view.open("Not yet");
  await act(async () => view.button("Comment").click());
  await settle();
  assert.equal(view.dialog().querySelector('[role="alert"]').textContent, "This Page is read only");
  assert.equal(view.textbox().value, "Not yet");
  assert.equal(view.button("Retry").disabled, false, "the writer can retry");
});

test("Cancel discards the draft", async (t) => {
  const view = await fixture(t);
  await view.open("Throw away");
  await act(async () => view.button("Cancel").click());
  assert.equal(view.dialog(), null);
  assert.deepEqual(view.composer.snapshot(), {
    state: { name: "idle" },
    composer: null,
    body: "",
  });
});

test("a pointer outside closes the popover and keeps the text without moving focus", async (t) => {
  const view = await fixture(t);
  await view.open("Kept");
  await act(async () => {
    document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
  });
  assert.equal(view.composer.snapshot().state.name, "dismissed");
  assert.deepEqual(view.calls, []);
});

test("a pointer inside the popover keeps it open", async (t) => {
  const view = await fixture(t);
  await view.open("Kept");
  await act(async () => {
    view.textbox().dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
  });
  assert.equal(view.composer.snapshot().state.name, "open");
});

test("a deleted passage or block keeps the composer, its note and Cancel visible", async (t) => {
  // The article holds no highlight and no block: both were deleted.
  const view = await fixture(t, { draft: { broken: true } });
  await view.open("Orphan");
  const dialog = view.dialog();
  assert.equal(dialog.dataset.placement, "detached");
  assert.match(dialog.className, /comment-popover-detached/);
  assert.equal(dialog.style.visibility, "", "never hidden");
  assert.equal(dialog.querySelector('[role="alert"]').textContent, PASSAGE_REMOVED_NOTE);
  assert.equal(view.textbox().value, "Orphan", "the draft text stays");
  assert.equal(view.button("Comment").disabled, true, "a removed passage can't be sent");
  assert.equal(view.button("Cancel").disabled, false);
  await view.key(view.textbox(), { key: "Enter", metaKey: true });
  assert.deepEqual(view.calls, [], "Mod+Enter sends nothing either");
  await view.key(view.textbox(), { key: "Escape" });
  assert.equal(view.composer.snapshot().state.name, "dismissed", "Escape keeps it for the panel");
});

test("narrow windows show the composer alone as a bottom sheet", async (t) => {
  sheet = true;
  t.after(() => (sheet = false));
  const view = await fixture(t);
  await view.open();
  assert.match(view.dialog().className, /comment-popover-sheet/);
  assert.equal(view.dialog().dataset.placement, "sheet");
  assert.equal(document.querySelector(".comments"), null, "the thread panel stays closed");
});

class FakeVisualViewport extends dom.window.EventTarget {
  offsetTop = 0;
  height = 844;
  width = 390;
  offsetLeft = 0;
  listeners = 0;
  addEventListener(...args) {
    this.listeners++;
    super.addEventListener(...args);
  }
  removeEventListener(...args) {
    this.listeners--;
    super.removeEventListener(...args);
  }
}

function withVisualViewport(t, viewport) {
  const previous = Object.getOwnPropertyDescriptor(window, "visualViewport");
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  Object.defineProperty(document.documentElement, "clientHeight", {
    configurable: true,
    value: 844,
  });
  t.after(() => {
    if (previous) Object.defineProperty(window, "visualViewport", previous);
    else delete window.visualViewport;
    delete document.documentElement.clientHeight;
  });
}

test("the sheet follows the visual viewport above an on-screen keyboard", async (t) => {
  sheet = true;
  t.after(() => (sheet = false));
  const viewport = new FakeVisualViewport();
  withVisualViewport(t, viewport);
  const view = await fixture(t);
  await view.open();
  assert.equal(view.dialog().style.bottom, "0px");
  assert.equal(view.dialog().style.maxHeight, "560px");
  assert.equal(viewport.listeners, 2, "resize and scroll are watched while open");
  // The keyboard takes the bottom 340px and the page scrolls 40px under it.
  viewport.height = 504;
  viewport.offsetTop = 40;
  await act(async () => viewport.dispatchEvent(new dom.window.Event("resize")));
  await settle();
  assert.equal(view.dialog().style.bottom, "300px");
  assert.equal(view.dialog().style.maxHeight, "353px");
  await act(async () => view.button("Cancel").click());
  assert.equal(view.dialog(), null);
  assert.equal(viewport.listeners, 0, "closing removes the listeners");
});

test("without visualViewport the sheet keeps the stylesheet's placement", async (t) => {
  sheet = true;
  t.after(() => (sheet = false));
  withVisualViewport(t, undefined);
  const view = await fixture(t);
  await view.open();
  assert.equal(view.dialog().style.bottom, "");
  assert.equal(view.dialog().style.maxHeight, "");
});

test("a send that fails after the window narrows stays usable above the thread sheet", async (t) => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const pending = [];
  const composer = new CommentComposer({
    send: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  });
  const session = {
    doc: { blocks: { block: {} } },
    canWrite: true,
    comment: async () => {},
  };
  const render = () =>
    root.render(
      createElement(
        "div",
        null,
        createElement(CommentsPanel, {
          open: true,
          session,
          threads: [],
          composer,
          target: null,
          onClose() {},
          onReveal() {},
          onSelect() {},
        }),
        createElement(CommentPopover, { composer, session, containerRef: { current: null } }),
      ),
    );
  await act(render);
  t.after(async () => {
    await act(() => root.unmount());
    container.remove();
    sheet = false;
  });
  const panel = () => container.querySelector("#page-comments");
  const popover = () => container.querySelector("#comment-popover");
  const button = (name) =>
    [...popover().querySelectorAll("button")].find((element) => element.textContent === name);
  assert.equal(panel().dataset.modal, "false", "docked beside the Page on desktop");
  await act(() => {
    composer.start({ blockId: "block", target: { kind: "selection" } });
    composer.change("Sending");
  });
  await act(async () => button("Comment").click());
  assert.equal(composer.snapshot().state.name, "sending");
  await setSheet(true);
  assert.equal(panel().dataset.modal, "false", "the sheet waits for the send");
  await act(async () => pending[0].reject(Error("This Page is read only")));
  await settle();
  assert.equal(composer.snapshot().state.name, "open");
  assert.equal(panel().dataset.modal, "false", "a failed send keeps the composer usable");
  assert.equal(popover().querySelector('[role="alert"]').textContent, "This Page is read only");
  const retry = button("Retry");
  assert.equal(retry.disabled, false);
  assert.equal(popover().querySelector('[role="textbox"]').disabled, false);
  await act(async () => retry.click());
  assert.equal(pending.length, 2, "Retry sends again");
  await act(async () => pending[1].resolve("thread-1"));
  await settle();
  assert.equal(popover(), null);
  assert.equal(panel().dataset.modal, "true", "the sheet turns modal once the composer closes");
});

test("a composer closed with text while the sheet waits shows as the kept draft", async (t) => {
  sheet = true;
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const composer = new CommentComposer({ send: () => null });
  const session = { doc: { blocks: { block: {} } }, canWrite: true, comment: async () => {} };
  await act(() =>
    root.render(
      createElement(
        "div",
        null,
        createElement(CommentsPanel, {
          open: true,
          session,
          threads: [],
          composer,
          target: null,
          onClose() {},
          onReveal() {},
          onSelect() {},
        }),
        createElement(CommentPopover, { composer, session, containerRef: { current: null } }),
      ),
    ),
  );
  t.after(async () => {
    await act(() => root.unmount());
    container.remove();
    sheet = false;
  });
  const panel = () => container.querySelector("#page-comments");
  assert.equal(panel().dataset.modal, "true");
  await act(() => {
    composer.start({ blockId: "block", target: { kind: "selection" } });
    composer.change("Keep me");
  });
  assert.equal(panel().dataset.modal, "false", "an open composer keeps the sheet non-modal");
  await act(async () => {
    panel().dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
  });
  assert.equal(composer.snapshot().state.name, "dismissed");
  assert.equal(panel().dataset.modal, "true");
  assert.equal(container.querySelector(".comment-kept-draft-text").textContent, "Keep me");
});

async function surfaces(t) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const calls = [];
  const composer = new CommentComposer({
    send: () => null,
    focusComposer: () => calls.push("focusComposer"),
  });
  const session = { doc: { blocks: { block: {} } }, canWrite: true, comment: async () => {} };
  await act(() =>
    root.render(
      createElement(
        "div",
        null,
        createElement(CommentsPanel, {
          open: true,
          session,
          threads: [],
          composer,
          target: null,
          onClose() {},
          onReveal() {},
          onSelect() {},
        }),
        createElement(CommentPopover, { composer, session, containerRef: { current: null } }),
      ),
    ),
  );
  t.after(async () => {
    await act(() => root.unmount());
    container.remove();
    sheet = false;
  });
  return {
    composer,
    calls,
    panel: () => container.querySelector("#page-comments"),
    popover: () => container.querySelector("#comment-popover"),
  };
}

test("beside the Page the panel stays focusable while composing", async (t) => {
  const view = await surfaces(t);
  await act(() => view.composer.start({ blockId: "block", target: { kind: "selection" } }));
  assert.equal(view.panel().hasAttribute("inert"), false);
  const tab = new dom.window.KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
  });
  view.popover().querySelector("button").dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, false, "Tab is not trapped beside the Page");
});

test("at sheet width the panel is inert under the composer and hands focus over", async (t) => {
  const view = await surfaces(t);
  await act(() => view.composer.start({ blockId: "block", target: { kind: "selection" } }));
  view.calls.length = 0;
  view.panel().querySelector("button").focus();
  assert.ok(view.panel().contains(document.activeElement));
  await setSheet(true);
  assert.equal(view.panel().hasAttribute("inert"), true);
  assert.equal(view.popover().hasAttribute("inert"), false, "the sibling composer stays live");
  assert.equal(view.popover().closest("[inert]"), null);
  assert.deepEqual(view.calls, ["focusComposer"], "focus moves from the panel into the composer");
  await act(() => view.composer.cancel());
  assert.equal(view.panel().hasAttribute("inert"), false, "closing the composer frees the panel");
  assert.equal(view.panel().dataset.modal, "true");
});

test("at sheet width Tab and Shift+Tab wrap inside the composer", async (t) => {
  sheet = true;
  const view = await surfaces(t);
  await act(() => {
    view.composer.start({ blockId: "block", target: { kind: "selection" } });
    view.composer.change("Text");
  });
  const stops = [...view.popover().querySelectorAll("textarea, button:not(:disabled)")];
  const [first, last] = [stops[0], stops.at(-1)];
  const press = (target, shiftKey = false) => {
    const event = new dom.window.KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    act(() => target.dispatchEvent(event));
    return event;
  };
  first.focus();
  assert.equal(press(first, true).defaultPrevented, true);
  assert.equal(document.activeElement, last, "Shift+Tab from the first stop wraps to the last");
  assert.equal(press(last).defaultPrevented, true);
  assert.equal(document.activeElement, first, "Tab from the last stop wraps to the first");
  first.focus();
  assert.equal(press(first).defaultPrevented, false, "Tab between inner stops is the browser's");
});
