import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { MOBILE_COMMENT_HINT, mobileCommentScope } from "./mobile-comment.mjs";

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
  entryPoints: [fileURLToPath(new URL("./MobileBar.jsx", import.meta.url))],
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
const { MobileBar } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

const STYLES = [
  ["p", "Paragraph"],
  ["h1", "Heading 1"],
];

async function renderBar(t, { format = {}, onComment = () => true, onRun = () => {} } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const props = {
    format: { focused: true, ...format },
    editable: true,
    styles: STYLES,
    onRun,
    onStyle: () => {},
    onImage: () => {},
    onComment,
    onFocusChange: () => {},
    barRef: { current: null },
    editorDom: null,
  };
  await act(async () => root.render(createElement(MobileBar, props)));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const bar = document.querySelector("[role='toolbar'][aria-label='Text formatting']");
  return {
    bar,
    rerender: (format) =>
      act(async () =>
        root.render(createElement(MobileBar, { ...props, format: { focused: true, ...format } })),
      ),
    button: (name) => [...bar.querySelectorAll("button")].find((b) => b.ariaLabel === name),
    status: () => bar.querySelector("[role='status']"),
  };
}

const click = (element) =>
  act(async () =>
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })),
  );

test("the comment scope is the selection, else a paragraph with text, else nothing", () => {
  assert.equal(mobileCommentScope({ selected: true, paragraphText: "" }), "selection");
  assert.equal(mobileCommentScope({ selected: false, paragraphText: "Ship it" }), "paragraph");
  for (const paragraphText of [undefined, "", "   ", "\ufffc", " \ufffc "])
    assert.equal(mobileCommentScope({ selected: false, paragraphText }), "none");
});

test("the bar's Comment button is an action named for its target, never a comments toggle", async (t) => {
  const view = await renderBar(t, { format: { commentScope: "selection" } });
  const names = [...view.bar.querySelectorAll("button")].map((button) => button.ariaLabel);
  assert.deepEqual(names, [
    "Bold",
    "Italic",
    "Bulleted list",
    "Insert image",
    "Comment on selection",
    "More formatting",
  ]);
  assert.equal(
    names.some((name) => /^Comments\b/.test(name)),
    false,
    "showing the comments list is the header's job",
  );
  const comment = view.button("Comment on selection");
  assert.equal(comment.hasAttribute("aria-pressed"), false);
  assert.equal(comment.hasAttribute("aria-expanded"), false);
  assert.equal(comment.disabled, false);
  assert.equal(view.bar.querySelector(".mobile-bar-count"), null, "no open-comment badge");
  await view.rerender({ commentScope: "paragraph" });
  assert.ok(view.button("Comment on paragraph"));
  await view.rerender({ commentScope: "none" });
  assert.equal(view.button("Comment").disabled, false, "an empty paragraph still explains itself");
});

test("Comment runs the comment action, and asks for a selection when there's nothing to comment on", async (t) => {
  const results = [true, false];
  let calls = 0;
  const view = await renderBar(t, {
    format: { commentScope: "paragraph" },
    onComment: () => results[calls++],
  });
  assert.equal(view.status().textContent, "", "the live region starts empty");
  await click(view.button("Comment on paragraph"));
  assert.equal(calls, 1);
  assert.equal(view.status().textContent, "");
  await view.rerender({ commentScope: "none" });
  await click(view.button("Comment"));
  assert.equal(calls, 2);
  assert.equal(view.status().textContent, MOBILE_COMMENT_HINT);
});

test("the More menu no longer repeats Comment on selection", async (t) => {
  const ran = [];
  const view = await renderBar(t, { onRun: (name) => ran.push(name) });
  await click(view.button("More formatting"));
  const items = [...document.querySelectorAll("[role='menuitem']")].map((item) => item.textContent);
  assert.ok(items.includes("Highlight"));
  assert.equal(items.includes("Comment on selection"), false);
  assert.deepEqual(ran, []);
});
