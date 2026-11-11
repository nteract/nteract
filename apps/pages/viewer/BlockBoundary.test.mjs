import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/p/page-a" });
const saved = new Map();
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
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
  entryPoints: [fileURLToPath(new URL("./BlockBoundary.jsx", import.meta.url))],
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
const { PageBlocks, ScreenBoundary } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");

// React reports a caught render error through console.error; keep the
// output quiet and count what the boundary logs.
function quietErrors(t) {
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args.join(" ")));
  dom.window.addEventListener("error", (event) => event.preventDefault());
  return logged;
}
async function mount(t, element) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  t.after(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () => root.render(element));
  return container;
}

test("a block that throws while drawing leaves the other blocks drawn", async (t) => {
  const logged = quietErrors(t);
  const blocks = [{ id: "first" }, { id: "broken" }, { id: "last" }];
  const container = await mount(
    t,
    createElement(PageBlocks, {
      blocks,
      renderBlock: (block) => {
        if (block.id === "broken") throw Error("Token type aside not supported");
        return createElement("p", null, `text of ${block.id}`);
      },
    }),
  );
  const sections = [...container.querySelectorAll("section.page-block")];
  assert.deepEqual(
    sections.map((section) => section.dataset.blockId),
    ["first", "broken", "last"],
    "every block keeps its place",
  );
  assert.equal(sections[0].textContent, "text of first");
  assert.equal(sections[2].textContent, "text of last");
  const notice = sections[1].querySelector("[data-block-error]");
  assert.ok(notice, "the failed block shows a notice");
  assert.match(notice.textContent, /can't be shown/);
  assert.ok(
    logged.some((line) => line.includes("Pages block broken failed to draw")),
    "the failure is logged with its block",
  );
});

test("a throw outside any block shows a reload notice, not a blank screen", async (t) => {
  quietErrors(t);
  let reloads = 0;
  const Broken = () => {
    throw Error("render failed");
  };
  const container = await mount(
    t,
    createElement(ScreenBoundary, { reload: () => reloads++ }, createElement(Broken)),
  );
  const alert = container.querySelector("[role=alert]");
  assert.ok(alert, "the fallback replaces the screen");
  assert.match(alert.textContent, /wasn't changed/);
  await act(async () => alert.querySelector("button").click());
  assert.equal(reloads, 1, "the button reloads");
});
