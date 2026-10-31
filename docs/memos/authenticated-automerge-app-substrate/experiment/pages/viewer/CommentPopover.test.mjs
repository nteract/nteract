// CommentPopover's keyboard and button contract over a real CommentComposer.
// Layout and focus movement across the Page are covered by
// scripts/rich-comments-smoke.mjs in a browser.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost" });
let sheet = false;
const saved = new Map();
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  CSS: { escape: (value) => value },
  matchMedia: () => ({ matches: sheet, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
  innerWidth: 1200,
  innerHeight: 800,
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
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("./CommentPopover.jsx", import.meta.url))],
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
            }`,
          loader: "js",
        }));
        build.onLoad({ filter: /^comment-draft$/, namespace: "test-stub" }, () => ({
          contents: `export function resolveCommentDraft(doc, draft) {
              if (draft.broken) throw Error("Selected passage was removed or replaced; select it again");
              return { block_id: draft.blockId };
            }`,
          loader: "js",
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
const { CommentPopover, COMMENT_POPOVER_LABEL, PASSAGE_REMOVED_NOTE } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`
);
const { CommentComposer } = await import("./comment-composer.mjs");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 5)));

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
  assert.equal(view.button("Comment").disabled, false, "the writer can retry");
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
