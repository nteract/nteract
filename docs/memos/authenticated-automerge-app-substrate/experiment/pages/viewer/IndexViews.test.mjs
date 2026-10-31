// /pages and /projects mounted in jsdom under StrictMode, with list_pages and
// list_projects answered by a fake tool.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", {
  url: "http://localhost/pages",
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
after(() => {
  dom.window.close();
  for (const [key, descriptor] of saved)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
});
// jsdom can't follow a link. Modified clicks reach here only after React's
// handlers have left them alone, so stopping them here keeps that check real.
document.addEventListener("click", (event) => event.preventDefault());
const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./IndexViews.jsx", import.meta.url))],
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
const { IndexNav, PagesIndex, ProjectsIndex } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);
const { createElement, act, StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");

const id = (n) => `1a160b47-6df1-4983-81eb-${String(n).padStart(12, "0")}`;
const projectId = "prj_2b160b47-6df1-4983-81eb-489ca5a26812";
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

async function mount(element) {
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(() => root.render(createElement(StrictMode, null, element)));
  await settle();
  return { host, unmount: () => act(() => root.unmount()) };
}
const click = (element, init = {}) =>
  act(() => {
    element.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }),
    );
  });
const text = (host, selector) =>
  [...host.querySelectorAll(selector)].map((node) => node.textContent);

test("/pages lists every Page with Project labels, opens rows and Projects separately, and loads more", async () => {
  const calls = [];
  const tool = async (name, args) => {
    calls.push([name, args]);
    if (args.cursor === "next")
      return {
        pages: [
          { page_id: id(2), title: "Old" },
          { page_id: id(3), title: "Older" },
        ],
      };
    if (args.query === "road")
      return { pages: [{ page_id: id(1), title: "Roadmap", project_id: projectId }] };
    if (args.query) return { pages: [], next_cursor: null };
    return {
      pages: [
        { page_id: id(1), title: "Roadmap", project_id: projectId, parent_id: null },
        { page_id: id(2), title: "", shared: true },
      ],
      next_cursor: "next",
    };
  };
  const events = [];
  const app = await mount(
    createElement(PagesIndex, {
      tool,
      query: "",
      projects: [{ project_id: projectId, title: "Launch" }],
      onNavigate: (kind) => events.push(["navigate", kind]),
      onQueryChange: (query) => events.push(["query", query]),
      onOpen: (pageId) => events.push(["open", pageId]),
      onOpenProject: (id) => events.push(["project", id]),
      onWarm: () => events.push(["warm"]),
      onError: (message) => events.push(["error", message]),
      onRetry: (retry) => retry(),
    }),
  );
  const { host } = app;
  assert.equal(host.querySelector("h1").textContent, "All Pages");
  assert.deepEqual(text(host, ".index-row-link"), ["Roadmap", "Untitled"]);
  assert.deepEqual(
    [...host.querySelectorAll(".index-row-link")].map((link) => link.getAttribute("href")),
    [`/p/${id(1)}`, `/p/${id(2)}`],
  );
  const label = host.querySelector(".index-row-project");
  assert.equal(label.getAttribute("href"), `/project/${projectId}`);
  assert.equal(label.getAttribute("aria-label"), "Project Launch");
  assert.deepEqual(text(host, ".index-row-shared"), ["Shared with you"]);
  assert.equal(
    host.querySelector(".index-nav [aria-current=page]").textContent,
    "All Pages",
    "the nav marks where you are",
  );
  assert.deepEqual(calls[0], ["list_pages", { limit: 50 }]);

  const row = host.querySelector(".index-row-link");
  act(() => row.dispatchEvent(new window.Event("pointerdown", { bubbles: true })));
  await click(row);
  await click(label);
  await click(row, { metaKey: true });
  assert.deepEqual(
    events.filter(([kind]) => kind !== "query"),
    [["warm"], ["open", id(1)], ["project", projectId]],
    "a Project label opens the Project, and a modified click stays with the browser",
  );

  const more = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Load more Pages",
  );
  await click(more);
  await settle();
  assert.deepEqual(text(host, ".index-row-link"), ["Roadmap", "Untitled", "Older"]);
  assert.equal(calls.at(-1)[1].cursor, "next");
  assert.equal(
    [...host.querySelectorAll("button")].some((b) => b.textContent.startsWith("Load more")),
    false,
  );

  const input = host.querySelector('input[type="search"]');
  const type = (value) =>
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
        input,
        value,
      );
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  await type("road");
  await act(() =>
    host
      .querySelector("form[role=search]")
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
  );
  await settle();
  assert.deepEqual(text(host, ".index-row-link"), ["Roadmap"]);
  assert.deepEqual(events.filter(([kind]) => kind === "query").at(-1), ["query", "road"]);
  await type("zzz");
  await act(() =>
    host
      .querySelector("form[role=search]")
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
  );
  await settle();
  assert.equal(host.querySelector(".index-list"), null);
  assert.match(host.textContent, /No Pages match “zzz”\./);
  await app.unmount();
});

test("/projects lists each Project with its description and opens it", async () => {
  const opened = [];
  const { host, unmount } = await mount(
    createElement(ProjectsIndex, {
      tool: async (name, args) => {
        assert.deepEqual([name, args], ["list_projects", { limit: 100 }]);
        return {
          projects: [
            { project_id: projectId, title: "Launch", description: "Where the launch lives." },
            { project_id: projectId.replace("prj_2", "prj_3"), title: "Plain", description: "" },
          ],
          next_cursor: null,
        };
      },
      onNavigate: () => {},
      onOpenProject: (id) => opened.push(id),
      onError: () => {},
      onRetry: (retry) => retry(),
    }),
  );
  assert.equal(host.querySelector("h1").textContent, "Projects");
  assert.deepEqual(text(host, ".index-row-link"), ["Launch", "Plain"]);
  assert.deepEqual(text(host, ".index-row-detail"), ["Where the launch lives."]);
  assert.equal(host.querySelector(".index-row-link").getAttribute("href"), `/project/${projectId}`);
  await click(host.querySelector(".index-row-link"));
  assert.deepEqual(opened, [projectId]);
  await unmount();
});

test("a listing that fails reports to the banner, offers Try again, and recovers", async () => {
  let fail = true;
  const errors = [],
    retries = [];
  const { host, unmount } = await mount(
    createElement(ProjectsIndex, {
      tool: async () => {
        if (fail) throw new TypeError("Failed to fetch");
        return { projects: [] };
      },
      onNavigate: () => {},
      onOpenProject: () => {},
      onError: (message) => errors.push(message),
      onRetry: (retry) => (retries.push(true), retry()),
    }),
  );
  assert.deepEqual(errors.at(-1), "Pages can't reach the server. Try again in a moment.");
  assert.equal(host.querySelector("[role=status]"), null);
  fail = false;
  await click([...host.querySelectorAll("button")].find((b) => b.textContent === "Try again"));
  await settle();
  assert.equal(retries.length, 1);
  assert.match(host.textContent, /No Projects yet/);
  await unmount();
});

test("the index nav links each screen and leaves modified clicks to the browser", async () => {
  const kinds = [];
  const { host, unmount } = await mount(
    createElement(IndexNav, { current: "home", onNavigate: (kind) => kinds.push(kind) }),
  );
  const links = [...host.querySelectorAll("a")];
  assert.deepEqual(
    links.map((link) => [link.textContent, link.getAttribute("href")]),
    [
      ["Home", "/"],
      ["All Pages", "/pages"],
      ["Projects", "/projects"],
    ],
  );
  assert.equal(links[0].getAttribute("aria-current"), "page");
  await click(links[2]);
  await click(links[1], { ctrlKey: true });
  assert.deepEqual(kinds, ["projects"]);
  await unmount();
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => ((resolve = yes), (reject = no)));
  return { promise, resolve, reject };
}
const setInput = (input, value) =>
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
      input,
      value,
    );
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
const submitSearch = (host) =>
  act(() =>
    host
      .querySelector("form[role=search]")
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
  );
const pagesProps = (overrides) => ({
  query: "",
  projects: [],
  onNavigate: () => {},
  onQueryChange: () => {},
  onOpen: () => {},
  onOpenProject: () => {},
  onWarm: () => {},
  onError: () => {},
  onRetry: (retry) => retry(),
  ...overrides,
});

test("mounting /pages never reports a query change; only a typed search does", async () => {
  const changes = [];
  const queries = [];
  const props = pagesProps({
    query: "  road  ",
    tool: async (_, args) => (queries.push(args.query), { pages: [] }),
    onQueryChange: (query) => changes.push(query),
  });
  const app = await mount(createElement(PagesIndex, props));
  // StrictMode mounts twice; each mount lists the route's own query.
  assert.deepEqual([...new Set(queries)], ["road"]);
  assert.deepEqual(changes, [], "a mount never reports a change");
  const input = app.host.querySelector('input[type="search"]');
  await setInput(input, "plan");
  await submitSearch(app.host);
  await settle();
  assert.deepEqual(changes, ["plan"]);
  await app.unmount();
  // A remount after a failed Page open lists the latest search and is silent.
  const again = await mount(createElement(PagesIndex, { ...props, query: "plan" }));
  assert.equal(again.host.querySelector('input[type="search"]').value, "plan");
  assert.deepEqual(changes, ["plan"]);
  assert.equal(queries.at(-1), "plan");
  await again.unmount();
});

test("a pasted search longer than list_pages allows is cut once, everywhere", async () => {
  const queries = [];
  const changes = [];
  const app = await mount(
    createElement(
      PagesIndex,
      pagesProps({
        tool: async (_, args) => (queries.push(args.query), { pages: [] }),
        onQueryChange: (query) => changes.push(query),
      }),
    ),
  );
  const input = app.host.querySelector('input[type="search"]');
  assert.equal(input.maxLength, 200);
  await setInput(input, " " + "z".repeat(300));
  assert.equal(input.value.length, 200, "the box holds what a request may send");
  await submitSearch(app.host);
  await settle();
  assert.equal(queries.at(-1), "z".repeat(199));
  assert.deepEqual(changes, ["z".repeat(199)]);
  await app.unmount();
});

test("a Load more that fails after the screen unmounts reports nothing", async () => {
  const errors = [];
  const next = deferred();
  const app = await mount(
    createElement(
      PagesIndex,
      pagesProps({
        tool: async (_, args) =>
          args.cursor
            ? next.promise
            : { pages: [{ page_id: id(1), title: "One" }], next_cursor: "next" },
        onError: (message) => errors.push(message),
      }),
    ),
  );
  await click(
    [...app.host.querySelectorAll("button")].find((b) => b.textContent === "Load more Pages"),
  );
  await app.unmount();
  next.reject(new TypeError("Failed to fetch"));
  await settle();
  assert.deepEqual(errors, []);
});

test("an expired cursor reloads /pages from its first page instead of offering Try again", async () => {
  const errors = [];
  const cursors = [];
  let expired = false;
  const app = await mount(
    createElement(
      PagesIndex,
      pagesProps({
        tool: async (_, args) => {
          cursors.push(args.cursor ?? null);
          if (args.cursor && expired)
            throw Object.assign(Error("Invalid cursor; restart from the first page"), {
              status: 400,
              code: "invalid_cursor",
            });
          return { pages: [{ page_id: id(cursors.length), title: "Row" }], next_cursor: "old" };
        },
        onError: (message) => errors.push(message),
      }),
    ),
  );
  expired = true;
  await click(
    [...app.host.querySelectorAll("button")].find((b) => b.textContent === "Load more Pages"),
  );
  await settle();
  assert.deepEqual(cursors.slice(cursors.indexOf("old")), ["old", null]);
  assert.deepEqual(errors, []);
  assert.equal(
    [...app.host.querySelectorAll("button")].some((b) => b.textContent === "Try again"),
    false,
  );
  assert.deepEqual(text(app.host, ".index-row-link"), ["Row"]);
  await app.unmount();
});
