// The Pages library (/ and /pages) and /projects mounted in jsdom under
// StrictMode, with list_pages and list_projects answered by a fake tool.
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
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
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
  stdin: {
    contents: 'export * from "./IndexViews.jsx"; export * from "./Library.jsx";',
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
        build.onResolve({ filter: /^[^./]/ }, ({ path }) => ({
          path: pathToFileURL(require.resolve(path)).href,
          external: true,
        }));
      },
    },
  ],
});
const { IndexNav, Library, ProjectsIndex } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);
const { createElement, act, StrictMode } = await import("react");
const { ListingCache } = await import("./listing-cache.mjs");
const { VirtualTimeScheduler } = await import("rxjs");
const { CLOCK_PERIOD_MS, Clock } = await import("./clock.mjs");
const { createRoot } = await import("react-dom/client");

const id = (n) => `1a160b47-6df1-4983-81eb-${String(n).padStart(12, "0")}`;
const projectId = "prj_2b160b47-6df1-4983-81eb-489ca5a26812";
const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 - 60 * 1000).toISOString();
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

const prjNotes = "prj_3b160b47-6df1-4983-81eb-489ca5a26812";
const PROJECTS = [
  { project_id: projectId, title: "Launch" },
  { project_id: prjNotes, title: "Notes" },
];
const button = (host, name) =>
  [...host.querySelectorAll("button")].find(
    (element) => element.textContent === name || element.getAttribute("aria-label") === name,
  );
const menuButton = (host, label) =>
  host.querySelector(`button[aria-haspopup="menu"][aria-label^="${label}: "]`);
const menuItems = (host) => [...host.querySelectorAll('[role="menuitemradio"]')];
const menuItem = (host, label) =>
  menuItems(host).find((item) => item.querySelector(".library-menu-label").textContent === label);
async function pick(host, label, choice) {
  await click(menuButton(host, label));
  await click(menuItem(host, choice));
  await settle();
}
const tab = (host, label) =>
  [...host.querySelectorAll('[role="group"][aria-label="Show"] button')].find(
    (element) => element.textContent === label,
  );
const key = (target, init) =>
  act(() => {
    target.dispatchEvent(
      new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
const frame = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
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
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => ((resolve = yes), (reject = no)));
  return { promise, resolve, reject };
}
const libraryProps = (overrides) => ({
  view: {},
  projects: [],
  onNavigate: () => {},
  onViewChange: () => {},
  onOpen: () => {},
  onOpenProject: () => {},
  onCreate: () => {},
  onTrash: () => {},
  onCopyLink: () => {},
  onWarm: () => {},
  onError: () => {},
  onRetry: (retry) => retry(),
  ...overrides,
});

// Noon local time, so the date groups below never straddle midnight.
const NOW = new Date(2026, 10, 3, 12, 0).getTime();
const HOUR = 60 * 60 * 1000;
const ago = (ms) => new Date(NOW - ms).toISOString();
/** A fixed clock for date groups and Last activity labels. */
const fixedClock = () => {
  const scheduler = new VirtualTimeScheduler();
  scheduler.maxFrames = 0;
  return new Clock({ now: () => NOW, scheduler });
};
const CATALOG = [
  { page_id: id(1), title: "Roadmap", project_id: projectId, updated_at: ago(HOUR) },
  { page_id: id(2), title: "Their plan", shared: true, updated_at: ago(26 * HOUR) },
  { page_id: id(3), title: "Loose notes", updated_at: ago(3 * 24 * HOUR) },
  { page_id: id(4), title: "Launch", project_id: projectId, home: true, updated_at: ago(2 * HOUR) },
  {
    page_id: id(5),
    title: "Archive",
    project_id: prjNotes,
    updated_at: new Date(2026, 8, 2, 12).toISOString(),
  },
];
/** list_pages over CATALOG: access, project_id, query and sort, as the
 * server applies them. Records each call's arguments. */
function catalogTool(calls = [], pages = CATALOG) {
  return async (name, args) => {
    calls.push(args);
    let listed = pages.filter(
      (page) =>
        (!args.access || (args.access === "shared") === (page.shared === true)) &&
        (!args.project_id || (page.project_id === args.project_id && !page.shared)) &&
        (!args.query || page.title.toLowerCase().includes(args.query.toLowerCase())),
    );
    if (args.sort === "title") listed = [...listed].sort((a, b) => a.title.localeCompare(b.title));
    return { pages: listed, next_cursor: null };
  };
}

test("the library lists every Page with Project labels, opens rows and Projects separately, and loads more", async () => {
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
        {
          page_id: id(1),
          title: "Roadmap",
          project_id: projectId,
          parent_id: null,
          updated_at: twoDaysAgo,
        },
        { page_id: id(2), title: "", shared: true, updated_at: "not a time" },
      ],
      next_cursor: "next",
    };
  };
  const events = [];
  const app = await mount(
    createElement(
      Library,
      libraryProps({
        tool,
        projects: [{ project_id: projectId, title: "Launch" }],
        onNavigate: (kind) => events.push(["navigate", kind]),
        onViewChange: (view, how) => events.push(["view", view, how]),
        onOpen: (pageId) => events.push(["open", pageId]),
        onOpenProject: (id) => events.push(["project", id]),
        onCopyLink: (pageId) => events.push(["copy", pageId]),
        onWarm: () => events.push(["warm"]),
        onError: (message) => events.push(["error", message]),
      }),
    ),
  );
  const { host } = app;
  assert.equal(host.querySelector("h1").textContent, "Pages");
  assert.deepEqual(text(host, ".index-columns span"), ["Name", "Source", "Last activity", ""]);
  assert.deepEqual(text(host, ".index-row-link"), ["Roadmap", "Untitled"]);
  assert.ok(host.querySelector('ul.index-page-list[aria-label="Pages"]'), "one list named Pages");
  assert.deepEqual(
    [...host.querySelectorAll(".index-row-link")].map((link) => link.getAttribute("href")),
    [`/p/${id(1)}`, `/p/${id(2)}`],
  );
  const label = host.querySelector(".index-row-project");
  assert.equal(label.getAttribute("href"), `/project/${projectId}`);
  assert.equal(label.getAttribute("aria-label"), "Project Launch");
  assert.deepEqual(text(host, ".index-row-shared"), ["Shared"]);
  const updated = host.querySelector(".index-cell-updated time");
  assert.equal(updated.getAttribute("dateTime"), twoDaysAgo);
  assert.equal(updated.getAttribute("title"), null, "the row link covers the cell, so no tooltip");
  assert.deepEqual(text(host, ".index-cell-updated [aria-hidden=true]"), ["2d", "—"]);
  const spoken = text(host, ".index-cell-updated .sr-only");
  assert.match(spoken[0], /^Last active .+, .*2\d{3}/, "screen readers hear the age and full time");
  assert.equal(spoken[1], "Last active unknown");
  assert.equal(host.querySelectorAll(".index-cell-updated time").length, 1, "no time, no <time>");
  assert.equal(
    host.querySelector(".index-nav [aria-current=page]").textContent,
    "Pages",
    "the nav marks where you are",
  );
  assert.deepEqual(calls[0], ["list_pages", { limit: 50 }]);
  assert.equal(host.querySelector('[role="group"][aria-label="Display"]'), null, "no grid toggle");

  const row = host.querySelector(".index-row-link");
  act(() => row.dispatchEvent(new window.Event("pointerdown", { bubbles: true })));
  await click(row);
  await click(label);
  await click(row, { metaKey: true });
  await click(button(host, "Copy link to Roadmap"));
  assert.deepEqual(
    events.filter(([kind]) => kind !== "view"),
    [["warm"], ["open", id(1)], ["project", projectId], ["copy", id(1)]],
    "a Project label opens the Project, and a modified click stays with the browser",
  );

  await click(button(host, "Load more Pages"));
  await settle();
  assert.deepEqual(text(host, ".index-row-link"), ["Roadmap", "Untitled", "Older"]);
  assert.equal(calls.at(-1)[1].cursor, "next");
  assert.equal(
    [...host.querySelectorAll("button")].some((b) => b.textContent.startsWith("Load more")),
    false,
  );

  const input = host.querySelector('input[type="search"]');
  assert.equal(input.getAttribute("aria-label"), "Search Pages");
  await setInput(input, "road");
  await submitSearch(host);
  await settle();
  assert.deepEqual(text(host, ".index-row-link"), ["Roadmap"]);
  const views = events.filter(([kind]) => kind === "view");
  assert.equal(views.at(-1)[1].query, "road");
  assert.deepEqual(views.at(-1)[2], { replace: true }, "a search replaces the history entry");
  await setInput(input, "zzz");
  await submitSearch(host);
  await settle();
  assert.equal(host.querySelector(".index-list"), null);
  assert.match(host.textContent, /No Pages match “zzz”\./);
  await app.unmount();
});

test("tabs list All, Your items or Shared with you, and each choice pushes the address", async () => {
  const calls = [];
  const views = [];
  const app = await mount(
    createElement(
      Library,
      libraryProps({
        tool: catalogTool(calls),
        projects: PROJECTS,
        clock: fixedClock(),
        onViewChange: (view, how) => views.push([view, how]),
      }),
    ),
  );
  const { host } = app;
  const pressed = () =>
    [...host.querySelectorAll('[role="group"][aria-label="Show"] button')].map((element) => [
      element.textContent,
      element.getAttribute("aria-pressed"),
    ]);
  assert.deepEqual(pressed(), [
    ["All", "true"],
    ["Your items", "false"],
    ["Shared with you", "false"],
  ]);
  assert.equal(text(host, ".index-row-link").length, 5);

  await click(tab(host, "Shared with you"));
  await settle();
  assert.deepEqual(calls.at(-1), { limit: 50, access: "shared" });
  assert.deepEqual(text(host, ".index-row-link"), ["Their plan"]);
  assert.equal(views.at(-1)[0].access, "shared");
  assert.deepEqual(views.at(-1)[1], { replace: false }, "a tab pushes a history entry");
  assert.equal(pressed()[2][1], "true");
  const project = menuButton(host, "Project");
  assert.equal(project.getAttribute("aria-disabled"), "true");
  assert.match(project.getAttribute("title"), /Projects hold only your own Pages/);
  assert.match(
    document.getElementById(project.getAttribute("aria-describedby")).textContent,
    /Switch to All or Your items/,
  );
  await click(project);
  assert.equal(menuItems(host).length, 0, "the Project menu doesn't open on the shared tab");

  await click(tab(host, "Your items"));
  await settle();
  assert.deepEqual(calls.at(-1), { limit: 50, access: "owned" });
  assert.deepEqual(text(host, ".index-row-link"), ["Roadmap", "Loose notes", "Launch", "Archive"]);
  assert.equal(project.getAttribute("aria-disabled"), null);

  await click(tab(host, "All"));
  await settle();
  assert.deepEqual(calls.at(-1), { limit: 50 });
  assert.equal(
    views.length,
    3,
    "each choice reports once; the listing that follows reports nothing new",
  );
  await app.unmount();
});

test("a Project filter lists Your items in that Project; Any project clears it", async () => {
  const calls = [];
  const views = [];
  const app = await mount(
    createElement(
      Library,
      libraryProps({
        tool: catalogTool(calls),
        projects: PROJECTS,
        clock: fixedClock(),
        onViewChange: (view, how) => views.push([view, how]),
      }),
    ),
  );
  const { host } = app;
  await click(menuButton(host, "Project"));
  assert.deepEqual(
    menuItems(host).map((item) => [item.textContent, item.getAttribute("aria-checked")]),
    [
      ["Any project", "true"],
      ["Launch", "false"],
      ["Notes", "false"],
    ],
  );
  await click(menuItem(host, "Launch"));
  await settle();
  assert.deepEqual(calls.at(-1), { limit: 50, access: "owned", project_id: projectId });
  assert.deepEqual(text(host, ".index-row-link"), ["Roadmap", "Launch"]);
  assert.deepEqual(views.at(-1), [
    { query: "", access: "owned", sort: "activity", projectId, group: null },
    { replace: false },
  ]);
  assert.equal(tab(host, "Your items").getAttribute("aria-pressed"), "true", "Your items");
  assert.equal(menuButton(host, "Project").getAttribute("aria-label"), "Project: Launch");

  await click(tab(host, "Shared with you"));
  await settle();
  assert.deepEqual(calls.at(-1), { limit: 50, access: "shared" }, "the shared tab drops it");
  await click(tab(host, "Your items"));
  await pick(host, "Project", "Notes");
  await pick(host, "Project", "Any project");
  assert.deepEqual(calls.at(-1), { limit: 50, access: "owned" });
  await app.unmount();

  // An address naming a Project the account hasn't listed yet still filters.
  const unknown = await mount(
    createElement(
      Library,
      libraryProps({ tool: catalogTool(), view: { projectId: prjNotes }, clock: fixedClock() }),
    ),
  );
  assert.equal(menuButton(unknown.host, "Project").getAttribute("aria-label"), "Project: Project");
  assert.deepEqual(text(unknown.host, ".index-row-link"), ["Archive"]);
  assert.equal(unknown.host.querySelector(".library-filter-notice"), null, "not until they load");
  await unknown.unmount();
});

test("a Project the account can't list says so and offers to clear the filter", async () => {
  const calls = [];
  const views = [];
  const missing = "prj_9b160b47-6df1-4983-81eb-489ca5a26812";
  const app = await mount(
    createElement(
      Library,
      libraryProps({
        tool: async (name, args) => {
          calls.push(args);
          if (args.project_id) throw Object.assign(Error("Project not found"), { status: 404 });
          return catalogTool()(name, args);
        },
        view: { projectId: missing },
        projects: PROJECTS,
        projectsReady: true,
        clock: fixedClock(),
        onViewChange: (view, how) => views.push([view, how]),
      }),
    ),
  );
  const { host } = app;
  assert.equal(menuButton(host, "Project").getAttribute("aria-label"), "Project: Unknown Project");
  const notice = host.querySelector(".library-filter-notice");
  assert.match(notice.textContent, /This Project isn't one you can open\./);
  assert.equal(button(host, "Try again"), undefined, "clearing the filter is the way out");
  await click(button(host, "Clear Project filter"));
  await settle();
  assert.deepEqual(calls.at(-1), { limit: 50, access: "owned" });
  assert.deepEqual(views.at(-1), [
    { query: "", access: "owned", sort: "activity", projectId: null, group: null },
    { replace: false },
  ]);
  assert.equal(host.querySelector(".library-filter-notice"), null);
  assert.equal(text(host, ".index-row-link").length, 4);
  await app.unmount();
});

test("an empty listing says why, for its tab, Project and search", async () => {
  for (const [view, message] of [
    [{}, "Start a page and write together."],
    [{ access: "owned" }, "You have no Pages yet. Start one with New Page."],
    [{ access: "shared" }, "Nothing is shared with you yet."],
    [{ projectId }, "No Pages in this Project."],
    [{ query: "zz" }, "No Pages match “zz”."],
  ]) {
    const app = await mount(
      createElement(Library, libraryProps({ tool: catalogTool([], []), view })),
    );
    assert.equal(app.host.querySelector(".library-empty").textContent, message);
    await app.unmount();
  }
});

test("sort by title, and group by Project or date with headings and counts", async () => {
  const calls = [];
  const views = [];
  const opened = [];
  const app = await mount(
    createElement(
      Library,
      libraryProps({
        tool: catalogTool(calls),
        projects: PROJECTS,
        clock: fixedClock(),
        onViewChange: (view, how) => views.push([view, how]),
        onOpenProject: (id) => opened.push(id),
      }),
    ),
  );
  const { host } = app;
  const headings = () =>
    [...host.querySelectorAll(".library-group-heading")].map((heading) => [
      heading.querySelector(".library-group-label").textContent,
      heading.querySelector(".library-group-count [aria-hidden=true]").textContent,
    ]);

  await pick(host, "Group", "Date");
  assert.equal(calls.length, 2, "grouping is presentation: StrictMode's two loads, no request");
  assert.deepEqual(headings(), [
    ["Today", "2"],
    ["Yesterday", "1"],
    ["Previous 7 days", "1"],
    ["September 2026", "1"],
  ]);
  assert.deepEqual(views.at(-1)[0].group, "date");
  assert.deepEqual(views.at(-1)[1], { replace: false });
  const today = host.querySelector('ul[aria-label="Today"]');
  assert.deepEqual(
    [...today.querySelectorAll(".index-row-link")].map((link) => link.textContent),
    ["Roadmap", "Launch"],
  );
  assert.equal(host.querySelectorAll(".index-columns").length, 1, "one column header");

  await pick(host, "Group", "Project");
  assert.deepEqual(
    text(host, ".index-columns span"),
    ["Name", "Last activity", ""],
    "the group heading names the source, so the column goes",
  );
  assert.equal(host.querySelector(".index-cell-source"), null);
  assert.deepEqual(headings(), [
    ["Launch", "2"],
    ["Shared with you", "1"],
    ["Your items", "1"],
    ["Notes", "1"],
  ]);
  const launch = host.querySelector(".library-group-heading a");
  assert.equal(launch.getAttribute("href"), `/project/${projectId}`);
  await click(launch);
  assert.deepEqual(opened, [projectId], "a Project heading opens the Project");
  assert.equal(
    host.querySelector('ul[aria-label="Shared with you"] .index-row-project'),
    null,
    "a shared row never reveals a Project",
  );

  await pick(host, "Sort", "Title");
  assert.deepEqual(calls.at(-1), { limit: 50, sort: "title" });
  assert.deepEqual(text(host, ".index-row-link"), [
    "Archive",
    "Launch",
    "Roadmap",
    "Loose notes",
    "Their plan",
  ]);
  assert.deepEqual(headings(), [
    ["Notes", "1"],
    ["Launch", "2"],
    ["Your items", "1"],
    ["Shared with you", "1"],
  ]);
  await click(menuButton(host, "Group"));
  const date = menuItem(host, "Date");
  assert.equal(date.getAttribute("aria-disabled"), "true", "date groups need Last activity");
  assert.match(date.textContent, /Sort by Last activity to group by date/);
  await click(date);
  assert.equal(menuButton(host, "Group").getAttribute("aria-label"), "Group: Project");
  await key(host.querySelector('[role="menu"]'), { key: "Escape" });

  await pick(host, "Sort", "Last activity");
  await pick(host, "Group", "Date");
  await pick(host, "Sort", "Title");
  assert.equal(host.querySelector(".library-group"), null, "title sort ungroups date groups");
  assert.equal(menuButton(host, "Group").getAttribute("aria-label"), "Group: None");
  assert.deepEqual(views.at(-1), [
    { query: "", access: null, sort: "title", projectId: null, group: null },
    { replace: false },
  ]);
  await app.unmount();
});

test("the menus open from the keyboard, move with arrows, and Escape returns focus", async () => {
  const app = await mount(
    createElement(Library, libraryProps({ tool: catalogTool(), clock: fixedClock() })),
  );
  const { host } = app;
  const sort = menuButton(host, "Sort");
  assert.equal(sort.getAttribute("aria-expanded"), "false");
  await key(sort, { key: "ArrowDown" });
  await frame();
  assert.equal(sort.getAttribute("aria-expanded"), "true");
  const menu = host.querySelector('[role="menu"]');
  assert.equal(menu.getAttribute("aria-label"), "Sort");
  assert.equal(sort.getAttribute("aria-controls"), menu.id);
  assert.equal(document.activeElement, menuItem(host, "Last activity"), "focus on the checked one");
  await key(menu, { key: "ArrowDown" });
  assert.equal(document.activeElement, menuItem(host, "Title"));
  await key(menu, { key: "ArrowDown" });
  assert.equal(document.activeElement, menuItem(host, "Last activity"), "arrows wrap");
  await key(menu, { key: "End" });
  assert.equal(document.activeElement, menuItem(host, "Title"));
  await key(menu, { key: "Escape" });
  assert.equal(host.querySelector('[role="menu"]'), null);
  assert.equal(document.activeElement, sort);
  await click(sort);
  await act(() =>
    document.body.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true })),
  );
  assert.equal(host.querySelector('[role="menu"]'), null, "a pointer outside closes it");
  await app.unmount();
});

test("/ focuses the search unless a field or editor has the keyboard", async () => {
  const app = await mount(
    createElement(Library, libraryProps({ tool: catalogTool(), clock: fixedClock() })),
  );
  const input = app.host.querySelector('input[type="search"]');
  assert.equal(input.getAttribute("aria-keyshortcuts"), "/");
  await key(document.body, { key: "/" });
  assert.equal(document.activeElement, input);
  input.blur();
  const field = document.createElement("textarea");
  document.body.append(field);
  field.focus();
  await key(field, { key: "/" });
  assert.equal(document.activeElement, field, "typing a slash stays in the field");
  field.remove();
  await key(document.body, { key: "/", metaKey: true });
  assert.notEqual(document.activeElement, input, "a shortcut with a modifier is someone else's");
  await app.unmount();
});

test("drafts on this device lead All and Your items, and the offline fallback lists local copies", async () => {
  const drafts = [
    { page_id: id(8), title: "Draft", pending: true, updated_at: ago(60 * 1000) },
    { page_id: id(1), title: "Roadmap", pending: false, updated_at: ago(HOUR) },
  ];
  const app = await mount(
    createElement(
      Library,
      libraryProps({ tool: catalogTool(), projects: PROJECTS, drafts, clock: fixedClock() }),
    ),
  );
  const { host } = app;
  assert.deepEqual(text(host, ".index-row-link").slice(0, 2), ["Draft", "Roadmap"]);
  assert.deepEqual(text(host, ".index-row-local"), ["On this device"]);
  assert.equal(text(host, ".index-row-link").filter((title) => title === "Roadmap").length, 1);
  // The server's search can't see a draft; its title is searched here.
  const input = host.querySelector('input[type="search"]');
  await setInput(input, "dra");
  await submitSearch(host);
  await settle();
  assert.deepEqual(text(host, ".index-row-link"), ["Draft"]);
  await setInput(input, "road");
  await submitSearch(host);
  await settle();
  assert.deepEqual(text(host, ".index-row-link"), ["Roadmap"]);
  await setInput(input, "");
  await submitSearch(host);
  await settle();
  await pick(host, "Group", "Date");
  assert.equal(host.querySelector(".library-group-label").textContent, "On this device");
  assert.deepEqual(text(host, ".index-row-local"), [], "one label: the heading says it");
  await pick(host, "Group", "Project");
  assert.equal(host.querySelector(".library-group-label").textContent, "On this device");
  await pick(host, "Group", "None");
  await click(tab(host, "Your items"));
  await settle();
  assert.deepEqual(text(host, ".index-row-local"), ["On this device"]);
  await click(tab(host, "Shared with you"));
  await settle();
  assert.deepEqual(text(host, ".index-row-local"), [], "a draft is never shared");
  await app.unmount();

  const errors = [];
  const offline = await mount(
    createElement(
      Library,
      libraryProps({
        tool: async () => {
          throw new TypeError("Failed to fetch");
        },
        drafts,
        clock: fixedClock(),
        onError: (message) => errors.push(message),
      }),
    ),
  );
  assert.deepEqual(text(offline.host, ".index-row-link"), ["Draft", "Roadmap"]);
  assert.deepEqual(text(offline.host, ".index-row-local"), ["On this device", "On this device"]);
  assert.ok(button(offline.host, "Try again"));
  assert.equal(errors.length > 0, true, "the banner says the server is unreachable");
  await offline.unmount();
});

test("the grid shows only when enabled, switches with the list, and never nests links", async () => {
  const events = [];
  const props = libraryProps({
    tool: async () => ({
      pages: [
        { page_id: id(1), title: "Roadmap", project_id: projectId, updated_at: twoDaysAgo },
        { page_id: id(2), title: "Launch", project_id: projectId, home: true },
        { page_id: id(3), title: "Loose notes" },
      ],
      next_cursor: null,
    }),
    projects: [{ project_id: projectId, title: "Launch" }],
    onOpen: (pageId) => events.push(["open", pageId]),
    onWarm: () => events.push(["warm"]),
    grid: true,
  });
  window.localStorage.clear();
  try {
    const app = await mount(createElement(Library, props));
    const group = app.host.querySelector('[role=group][aria-label="Display"]');
    const toggle = (name) => group.querySelector(`button[aria-label="${name}"]`);
    assert.deepEqual(
      [...group.querySelectorAll("button")].map((b) => [
        b.getAttribute("aria-label"),
        b.getAttribute("aria-pressed"),
      ]),
      [
        ["Grid view", "false"],
        ["List view", "true"],
      ],
      "the list is the default",
    );
    assert.deepEqual(
      [...app.host.querySelectorAll(".index-cell-source")].map((cell) => cell.textContent),
      ["Launch", "Launch", "—"],
      "a Page outside any Project shows a dash for its Source",
    );
    assert.equal(app.host.querySelector(".index-grid"), null);

    await click(toggle("Grid view"));
    assert.equal(window.localStorage.getItem("nteract.pages.view"), "grid");
    assert.equal(toggle("Grid view").getAttribute("aria-pressed"), "true");
    assert.equal(app.host.querySelector(".index-columns"), null, "no column header in the grid");
    const grid = app.host.querySelector('ul.index-grid[aria-label="Pages"]');
    assert.ok(grid, "the grid keeps the list's name");
    const cards = [...grid.querySelectorAll(".index-card-link")];
    assert.deepEqual(
      cards.map((card) => [card.textContent, card.getAttribute("href")]),
      [
        ["Roadmap", `/p/${id(1)}`],
        ["Launch", `/p/${id(2)}`],
        ["Loose notes", `/p/${id(3)}`],
      ],
    );
    assert.equal(grid.querySelectorAll("a a").length, 0, "a card holds no link inside its link");
    assert.equal(grid.querySelectorAll("a").length, 3, "each card is one link");
    assert.equal(grid.querySelectorAll(".index-card-preview").length, 3);
    act(() => cards[0].dispatchEvent(new window.Event("pointerdown", { bubbles: true })));
    await click(cards[0]);
    await click(cards[1], { metaKey: true });
    assert.deepEqual(events, [["warm"], ["open", id(1)]]);
    await pick(app.host, "Group", "Project");
    assert.ok(app.host.querySelector('ul.index-grid[aria-label="Launch"]'), "grouped grid");
    await app.unmount();

    const again = await mount(createElement(Library, props));
    assert.ok(again.host.querySelector(".index-grid"), "a remount reads the stored mode");
    await click(again.host.querySelector('button[aria-label="List view"]'));
    assert.equal(window.localStorage.getItem("nteract.pages.view"), "list");
    await again.unmount();

    window.localStorage.setItem("nteract.pages.view", "grid");
    const off = await mount(createElement(Library, { ...props, grid: false }));
    assert.ok(off.host.querySelector(".index-page-list"), "without the flag, always the list");
    assert.equal(off.host.querySelector('[role=group][aria-label="Display"]'), null);
    await off.unmount();
  } finally {
    window.localStorage.clear();
  }
});

test("the library refreshes its Last activity times once a minute", async () => {
  const scheduler = new VirtualTimeScheduler();
  scheduler.maxFrames = 0;
  const edited = Date.parse("2026-11-03T17:00:00.000Z");
  const start = edited + 59 * 60 * 1000;
  const clock = new Clock({ now: () => start + scheduler.frame, scheduler });
  const app = await mount(
    createElement(
      Library,
      libraryProps({
        clock,
        tool: async () => ({
          pages: [{ page_id: id(1), title: "Roadmap", updated_at: new Date(edited).toISOString() }],
        }),
      }),
    ),
  );
  const label = () => text(app.host, ".index-cell-updated [aria-hidden=true]")[0];
  assert.equal(label(), "59m");
  await act(() => {
    scheduler.maxFrames += CLOCK_PERIOD_MS;
    scheduler.flush();
  });
  assert.equal(label(), "1h");
  await app.unmount();
  scheduler.maxFrames += 10 * CLOCK_PERIOD_MS;
  scheduler.flush();
  assert.equal(clock.snapshot(), start + CLOCK_PERIOD_MS, "an unmounted screen stops its clock");
});

test("mounting the library never reports a view change; only a typed search does", async () => {
  const changes = [];
  const requests = [];
  const props = libraryProps({
    view: { query: "  road  ", access: "owned", sort: "title", group: "project" },
    tool: async (_, args) => (requests.push(args), { pages: [] }),
    onViewChange: (view, how) => changes.push([view, how]),
  });
  const app = await mount(createElement(Library, props));
  // StrictMode mounts twice; each mount lists the route's own view.
  assert.deepEqual(
    [...new Set(requests.map((args) => JSON.stringify(args)))],
    [JSON.stringify({ limit: 50, query: "road", access: "owned", sort: "title" })],
  );
  assert.deepEqual(changes, [], "a mount never reports a change");
  const input = app.host.querySelector('input[type="search"]');
  await setInput(input, "plan");
  await submitSearch(app.host);
  await settle();
  assert.deepEqual(changes, [
    [
      { query: "plan", access: "owned", sort: "title", projectId: null, group: "project" },
      { replace: true },
    ],
  ]);
  await app.unmount();
  // A remount after a failed Page open lists the latest view and is silent.
  const again = await mount(createElement(Library, { ...props, view: changes[0][0] }));
  assert.equal(again.host.querySelector('input[type="search"]').value, "plan");
  assert.equal(changes.length, 1);
  assert.equal(requests.at(-1).query, "plan");
  await again.unmount();
});

test("a pasted search longer than list_pages allows is cut once, everywhere", async () => {
  const queries = [];
  const changes = [];
  const app = await mount(
    createElement(
      Library,
      libraryProps({
        tool: async (_, args) => (queries.push(args.query), { pages: [] }),
        onViewChange: (view) => changes.push(view.query),
      }),
    ),
  );
  const input = app.host.querySelector('input[type="search"]');
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
      Library,
      libraryProps({
        tool: async (_, args) =>
          args.cursor
            ? next.promise
            : { pages: [{ page_id: id(1), title: "One" }], next_cursor: "next" },
        onError: (message) => errors.push(message),
      }),
    ),
  );
  await click(button(app.host, "Load more Pages"));
  await app.unmount();
  next.reject(new TypeError("Failed to fetch"));
  await settle();
  assert.deepEqual(errors, []);
});

test("an expired cursor reloads the library from its first page instead of offering Try again", async () => {
  const errors = [];
  const cursors = [];
  let expired = false;
  const app = await mount(
    createElement(
      Library,
      libraryProps({
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
  await click(button(app.host, "Load more Pages"));
  await settle();
  assert.deepEqual(cursors.slice(cursors.indexOf("old")), ["old", null]);
  assert.deepEqual(errors, []);
  assert.equal(button(app.host, "Try again"), undefined);
  assert.deepEqual(text(app.host, ".index-row-link"), ["Row"]);
  await app.unmount();
});

test("199 ASCII characters and an emoji, typed or pasted, leave one string everywhere", async () => {
  const ascii = "x".repeat(199);
  for (const [label, steps] of [
    // Typing: the box reaches 199 characters, then the emoji arrives. A
    // browser's maxLength may already have kept only its high surrogate.
    ["typed", [ascii, ascii + "😀"]],
    ["typed past maxLength", [ascii, ascii + "\uD83D"]],
    ["pasted", [ascii + "😀 and more"]],
  ]) {
    const queries = [];
    const changes = [];
    const app = await mount(
      createElement(
        Library,
        libraryProps({
          tool: async (_, args) => (queries.push(args.query), { pages: [] }),
          onViewChange: (view) => changes.push(view.query),
        }),
      ),
    );
    const input = app.host.querySelector('input[type="search"]');
    for (const value of steps) await setInput(input, value);
    assert.equal(input.value, ascii, `${label}: the box drops the emoji whole`);
    await submitSearch(app.host);
    await settle();
    assert.equal(queries.at(-1), ascii, `${label}: the request`);
    assert.deepEqual(changes, [ascii], `${label}: the address`);
    await app.unmount();
  }
});

test("the index nav links Pages and Projects and leaves modified clicks to the browser", async () => {
  const kinds = [];
  const { host, unmount } = await mount(
    createElement(IndexNav, { current: "pages", onNavigate: (kind) => kinds.push(kind) }),
  );
  const links = [...host.querySelectorAll("a")];
  assert.deepEqual(
    links.map((link) => [link.textContent, link.getAttribute("href")]),
    [
      ["Pages", "/"],
      ["Projects", "/projects"],
    ],
  );
  assert.equal(links[0].getAttribute("aria-current"), "page");
  await click(links[1]);
  await click(links[0], { ctrlKey: true });
  assert.deepEqual(kinds, ["projects"]);
  await unmount();
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

test("date groups and the Last activity column read the content time, as the sort does", async () => {
  // list_pages orders by content_updated_at || updated_at. A content edit
  // doesn't move updated_at, so this Page's catalog time is September while
  // its last edit was half an hour ago, and it lists first.
  const pages = [
    {
      page_id: id(1),
      title: "Edited today",
      updated_at: new Date(2026, 8, 2, 12).toISOString(),
      content_updated_at: ago(HOUR / 2),
    },
    { page_id: id(2), title: "Renamed today", updated_at: ago(HOUR), content_updated_at: null },
    {
      page_id: id(3),
      title: "Edited this week",
      updated_at: ago(40 * 24 * HOUR),
      content_updated_at: ago(3 * 24 * HOUR),
    },
  ];
  const app = await mount(
    createElement(
      Library,
      libraryProps({
        tool: async () => ({ pages, next_cursor: null }),
        view: { group: "date" },
        clock: fixedClock(),
      }),
    ),
  );
  const { host } = app;
  assert.deepEqual(
    [...host.querySelectorAll(".library-group-heading .library-group-label")].map(
      (label) => label.textContent,
    ),
    ["Today", "Previous 7 days"],
    "groups follow the row order: no September between Today and this week",
  );
  assert.deepEqual(text(host, ".index-cell-updated [aria-hidden=true]"), ["30m", "1h", "3d"]);
  assert.match(text(host, ".index-cell-updated .sr-only")[0], /^Last active 30 minutes ago, /);
  await app.unmount();
});

test("choosing what already shows, like the current tab, pushes nothing", async () => {
  const calls = [];
  const views = [];
  const app = await mount(
    createElement(
      Library,
      libraryProps({
        tool: catalogTool(calls),
        clock: fixedClock(),
        onViewChange: (view, how) => views.push([view, how]),
      }),
    ),
  );
  const before = calls.length;
  await click(tab(app.host, "All"));
  await settle();
  assert.deepEqual(views, []);
  assert.equal(calls.length, before);
  await app.unmount();
});

test("a new view from Back or Forward applies in place: a grouping alone asks for nothing", async () => {
  const calls = [];
  const views = [];
  let render;
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  const props = libraryProps({
    tool: catalogTool(calls),
    projects: PROJECTS,
    clock: fixedClock(),
    onViewChange: (view, how) => views.push([view, how]),
  });
  render = (view) => act(() => root.render(createElement(Library, { ...props, view })));
  await render({});
  await settle();
  const listed = calls.length;
  const group = menuButton(host, "Group");
  group.focus();
  // Back to ?group=project: the same rows, grouped.
  await render({ group: "project" });
  await settle();
  assert.equal(calls.length, listed, "no request for a grouping");
  assert.equal(menuButton(host, "Group").getAttribute("aria-label"), "Group: Project");
  assert.ok(host.querySelector(".library-group"));
  assert.equal(document.activeElement, group, "focus stays on the control");
  // Back to ?show=shared&q=plan: one request, and the box shows the search.
  await render({ access: "shared", query: "plan" });
  await settle();
  assert.equal(calls.length, listed + 1);
  assert.deepEqual(calls.at(-1), { limit: 50, query: "plan", access: "shared" });
  assert.equal(host.querySelector('input[type="search"]').value, "plan");
  assert.equal(tab(host, "Shared with you").getAttribute("aria-pressed"), "true");
  assert.deepEqual(views, [], "a view the owner handed in is never reported back");
  await act(() => root.unmount());
});

test("a return visit paints the rows this tab showed, then refreshes them", async () => {
  const cache = new ListingCache();
  const replies = [];
  const tool = (name, args) => {
    const reply = deferred();
    replies.push({ args, ...reply });
    return reply.promise;
  };
  const props = libraryProps({ tool, principal: "alice", cache, clock: fixedClock() });
  const first = await mount(createElement(Library, props));
  assert.match(first.host.textContent, /Loading…/, "a first visit has nothing to paint");
  for (const reply of replies)
    reply.resolve({ pages: [{ page_id: id(1), title: "Roadmap" }], next_cursor: null });
  await settle();
  assert.deepEqual(text(first.host, ".index-row-link"), ["Roadmap"]);
  await first.unmount();

  replies.length = 0;
  const again = await mount(createElement(Library, props));
  assert.deepEqual(text(again.host, ".index-row-link"), ["Roadmap"], "painted from memory");
  assert.doesNotMatch(again.host.textContent, /Loading…/);
  assert.equal(again.host.querySelector(".library-results").getAttribute("aria-busy"), "true");
  assert.ok(replies.length > 0, "and asked for again");
  for (const reply of replies)
    reply.resolve({
      pages: [
        { page_id: id(2), title: "New" },
        { page_id: id(1), title: "Roadmap" },
      ],
      next_cursor: null,
    });
  await settle();
  assert.deepEqual(text(again.host, ".index-row-link"), ["New", "Roadmap"]);
  assert.equal(again.host.querySelector(".library-results").getAttribute("aria-busy"), "false");
  await again.unmount();

  // Another account remembers nothing.
  replies.length = 0;
  const bob = await mount(createElement(Library, { ...props, principal: "bob" }));
  assert.deepEqual(text(bob.host, ".index-row-link"), []);
  assert.match(bob.host.textContent, /Loading…/);
  for (const reply of replies) reply.resolve({ pages: [], next_cursor: null });
  await settle();
  await bob.unmount();
});
