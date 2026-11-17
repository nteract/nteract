// main.jsx's real session startup, mounted in jsdom: the shell, browser
// session maintenance and the banner region, with only the network and the
// editor chunk replaced.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";
import { SERVER_UNREACHABLE_ACTION } from "./alerts.mjs";
import { PRODUCT_NAME } from "../shared/product.mjs";
import { readPageRoute } from "../shared/routes.mjs";

// Sign-out leaves for / through location.href, a navigation jsdom can't
// follow. Every other jsdom error still prints.
const virtualConsole = new VirtualConsole();
virtualConsole.sendTo(console, { omitJSDOMErrors: true });
virtualConsole.on("jsdomError", (error) => {
  if (!error.message.startsWith("Not implemented: navigation")) console.error(error);
});
const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', {
  url: "http://localhost/",
  pretendToBeVisual: true,
  virtualConsole,
});
// jsdom has <dialog> without its modal methods; the Browse picker uses them.
{
  const proto = dom.window.HTMLDialogElement.prototype;
  proto.showModal ??= function () {
    this.setAttribute("open", "");
  };
  proto.close ??= function () {
    this.removeAttribute("open");
  };
}
const saved = new Map();
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  location: dom.window.location,
  history: dom.window.history,
  localStorage: dom.window.localStorage,
  sessionStorage: dom.window.sessionStorage,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const originalFetch = globalThis.fetch;
// The shell's own timers (build checks, session renewals) outlive a test;
// record them so the file can end.
const timers = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval };
const pending = new Set();
globalThis.setTimeout = (...args) => {
  const id = timers.setTimeout(...args);
  pending.add(id);
  return id;
};
globalThis.setInterval = (...args) => {
  const id = timers.setInterval(...args);
  pending.add(id);
  return id;
};
after(() => {
  for (const id of pending) clearTimeout(id);
  Object.assign(globalThis, timers);
  globalThis.fetch = originalFetch;
  dom.window.close();
  for (const [key, descriptor] of saved)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
});

const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./main.jsx", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  plugins: [
    {
      name: "test-shell",
      setup(build) {
        // The editor chunk loads the WASM runtimes; the landing never needs it.
        build.onResolve({ filter: /\/page-editor\.mjs$/ }, () => ({
          path: "page-editor",
          namespace: "stub",
        }));
        // Counts imports, so a test can tell whether a route loaded it.
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents:
            "globalThis.__editorImports = (globalThis.__editorImports ?? 0) + 1;\n" +
            'if (globalThis.__editorFails) throw new TypeError("Failed to fetch dynamically imported module");\n' +
            "export function onRendererUnavailable() {}\n" +
            // A test that opens a Page supplies __openPage; others fail the open.
            "export const PageSession = { open: (id) => globalThis.__openPage ? globalThis.__openPage(id) : Promise.reject(new Error('No Page in this fixture')), create: () => globalThis.__createPage ? globalThis.__createPage() : Promise.reject(new Error('No Page in this fixture')) };\n" +
            // The rest of the editor's surface, from __editor when a test
            // installs a Page, else inert.
            "const pick = (name, fallback) => (...args) => (globalThis.__editor?.[name] ?? fallback)(...args);\n" +
            "export const SaveStatus = pick('SaveStatus', () => null);\n" +
            "export const PageControls = pick('PageControls', () => null);\n" +
            "export const CommentsPanel = pick('CommentsPanel', () => null);\n" +
            "export const CommentPopover = pick('CommentPopover', () => null);\n" +
            "export const WordgardEditor = pick('WordgardEditor', () => null);\n" +
            "export const orderedBlockIds = pick('orderedBlockIds', () => []);\n" +
            "export const isEmptyPage = pick('isEmptyPage', () => false);\n" +
            "export const pageHeads = pick('pageHeads', () => []);\n" +
            "export const titleSnapshot = pick('titleSnapshot', () => null);\n" +
            "export const composingTitle = pick('composingTitle', () => false);",
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
const source = Buffer.from(bundle.outputFiles[0].contents).toString("base64");
const popstateListeners = [];
{
  const add = window.addEventListener.bind(window);
  window.addEventListener = (type, listener, options) => {
    if (type === "popstate") popstateListeners.push(listener);
    return add(type, listener, options);
  };
}
const { act } = await import("react");

/** Mount main.jsx once, with `session` answering /api/auth/session and
 * `tools` answering /api/tools operations (a value, or a function of the
 * arguments that returns one or a Response). `connect` answers /api/connect,
 * `paths` answers other paths by pathname, and `head` runs where theme.js
 * would, before the app script. */
async function boot(session, tools = {}, { connect, head, paths = {} } = {}) {
  // Each boot's App stays mounted on its detached root. Retire the earlier
  // ones' popstate listeners, so Back and Forward drive only this App and its
  // requests are the only ones counted.
  for (const listener of popstateListeners.splice(0))
    window.removeEventListener("popstate", listener);
  document.body.innerHTML = '<div id="root"></div>';
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(url, "http://localhost/").pathname;
    requests.push(path);
    if (path === "/api/auth/session") return session();
    if (path === "/api/connect" && connect) return connect();
    if (paths[path]) return paths[path]();
    if (path === "/api/tools") {
      const { operation, arguments: args } = JSON.parse(init.body);
      requests.push(operation);
      const answer = tools[operation];
      if (typeof answer === "function") {
        const value = await answer(args ?? {});
        return value instanceof Response ? value : Response.json(value);
      }
      if (answer) return Response.json(answer);
    }
    return Response.json({ error: "Not in this fixture" }, { status: 404 });
  };
  head?.();
  // A fresh module instance per boot: main.jsx renders at import.
  await act(
    () => import(`data:text/javascript;base64,${source}#${requests.length}${Math.random()}`),
  );
  for (
    let i = 0;
    i < 20 && document.querySelector('[role="status"]')?.textContent === "Connecting…";
    i++
  )
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  return {
    requests,
    banners: () =>
      [...document.querySelectorAll(".error[role=alert]")].map((node) => node.textContent),
  };
}

/** The Page route the address shows, without its slug, which names nothing
 * and follows the Page's title. */
const shownPagePath = () => readPageRoute(location.href).path;

test("a first visit whose session check answers 401 lands signed out with no banner", async () => {
  const app = await boot(() => Response.json({ error: "Sign in required" }, { status: 401 }));
  assert.ok(app.requests.includes("/api/auth/session"));
  assert.equal(document.querySelector("h1")?.textContent, "A place to write together.");
  assert.ok([...document.querySelectorAll("a")].some((link) => link.textContent === "Sign in"));
  assert.deepEqual(app.banners(), []);
  // A first-time visitor learns what this is and where agents start.
  assert.match(
    document.querySelector(".welcome p")?.textContent,
    /people and agents edit together/,
  );
  const connect = [...document.querySelectorAll("a")].find(
    (link) => link.textContent === "Connect an agent",
  );
  assert.equal(connect?.getAttribute("href"), "/connect");
  assert.equal(document.title, PRODUCT_NAME);
  assert.equal(document.querySelector(".brand")?.textContent, PRODUCT_NAME);
});

test("a signed-out visit to a Page link asks to sign in to that Page and returns to it", async () => {
  const pageId = "44444444-4444-4444-8444-444444444444";
  history.replaceState(null, "", `/p/${pageId}`);
  try {
    await boot(() => Response.json({ error: "Sign in required" }, { status: 401 }));
    assert.equal(document.querySelector("h1")?.textContent, "Sign in to open this Page.");
    const signIn = [...document.querySelectorAll("a")].find(
      (link) => link.textContent === "Sign in",
    );
    assert.equal(
      signIn?.getAttribute("href"),
      `/api/auth/login?return_to=${encodeURIComponent(`/p/${pageId}`)}`,
    );
  } finally {
    history.replaceState(null, "", "/");
  }
});

test("a first visit that can't reach the server says so once", async () => {
  const app = await boot(
    () =>
      new Response("<!DOCTYPE html><title>503 | Cloudflare</title>", {
        status: 503,
        headers: { "Content-Type": "text/html" },
      }),
  );
  assert.equal(document.querySelector("h1")?.textContent, "A place to write together.");
  assert.deepEqual(app.banners(), [SERVER_UNREACHABLE_ACTION]);
});

const signedIn = () =>
  Response.json({ identity: { principal: "one", displayName: "Kyle" }, canWrite: true });
const catalog = {
  list_pages: { pages: [], next_cursor: null, principal: "one" },
  list_projects: { projects: [], next_cursor: null, principal: "one" },
};
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
};

test("/pages and /projects render from the shell without importing the editor", async () => {
  for (const [path, heading, tab, listing] of [
    ["/pages", "Pages", "Pages", "list_pages"],
    ["/projects/", "Projects", "Projects · Pages", "list_projects"],
  ]) {
    history.replaceState(null, "", path);
    const before = globalThis.__editorImports ?? 0;
    const app = await boot(signedIn, catalog);
    await settle();
    assert.equal(document.querySelector("main h1")?.textContent, heading, path);
    assert.equal(document.title, tab, `${path} tab title`);
    assert.ok(app.requests.includes(listing), path);
    assert.equal(globalThis.__editorImports ?? 0, before, `${path} imported the editor`);
    assert.deepEqual(app.banners(), []);
  }
  assert.equal(location.pathname, "/projects", "the trailing slash is dropped");
});

test("Home is the Pages library and starts the editor import at boot", async () => {
  history.replaceState(null, "", "/");
  const before = globalThis.__editorImports ?? 0;
  await boot(signedIn, catalog);
  await settle();
  assert.equal(document.querySelector("main h1")?.textContent, "Pages");
  assert.equal(globalThis.__editorImports, before + 1);
  const nav = [...document.querySelectorAll(".index-nav a")].map((link) => link.textContent);
  assert.deepEqual(nav, ["Pages", "Projects"]);
  assert.equal(document.querySelector(".index-nav [aria-current=page]")?.textContent, "Pages");
  assert.ok(document.querySelector('[role="group"][aria-label="Display"]'), "no flag needed");
  assert.equal(
    document.querySelector('[aria-label="List view"]').getAttribute("aria-pressed"),
    "true",
  );
});

test("?grid=1 opens the library on the grid; a no-query reload keeps the stored choice", async () => {
  const listing = {
    ...catalog,
    list_pages: {
      pages: [{ page_id: "1a160b47-6df1-4983-81eb-489ca5a26812", title: "Roadmap" }],
      next_cursor: null,
      principal: "one",
    },
  };
  window.localStorage.removeItem("nteract.pages.view");
  window.localStorage.removeItem("pages.grid");
  try {
    history.replaceState(null, "", "/pages?grid=1");
    await boot(signedIn, listing);
    await settle();
    assert.ok(document.querySelector('ul.index-grid[aria-label="Pages"]'), "the grid shows");
    const toggle = document.querySelector('[role="group"][aria-label="Display"]');
    assert.equal(
      toggle.querySelector('[aria-label="Grid view"]').getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(location.pathname + location.search, "/pages", "the library's own address");
    assert.equal(window.localStorage.getItem("nteract.pages.view"), "grid");
    // The preference survives without the query or a stored flag.
    await boot(signedIn, listing);
    await settle();
    assert.ok(document.querySelector(".index-grid"));
    assert.ok(document.querySelector('[role="group"][aria-label="Display"]'));
    await act(() => document.querySelector('[aria-label="List view"]').click());
    assert.equal(window.localStorage.getItem("nteract.pages.view"), "list");
    await boot(signedIn, listing);
    await settle();
    assert.equal(document.querySelector(".index-grid"), null);
    assert.equal(
      document.querySelector('[aria-label="List view"]').getAttribute("aria-pressed"),
      "true",
    );
  } finally {
    window.localStorage.removeItem("nteract.pages.view");
    window.localStorage.removeItem("pages.grid");
    history.replaceState(null, "", "/");
  }
});

test("a library choice pushes the address at / and /pages, and Back restores the view", async () => {
  for (const base of ["/", "/pages"]) {
    history.replaceState(null, "", base);
    const app = await boot(signedIn, {
      ...catalog,
      list_pages: {
        pages: [{ page_id: "1a160b47-6df1-4983-81eb-489ca5a26812", title: "Roadmap" }],
        next_cursor: null,
      },
    });
    await settle();
    const tab = (label) =>
      [...document.querySelectorAll('[role="group"][aria-label="Show"] button')].find(
        (element) => element.textContent === label,
      );
    await act(() => {
      tab("Shared with you").dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    await settle();
    const shared = base === "/" ? "/?show=shared" : "/pages?show=shared";
    assert.equal(location.pathname + location.search, shared, base);
    assert.equal(tab("Shared with you").getAttribute("aria-pressed"), "true");
    history.back();
    await settle();
    assert.equal(location.pathname + location.search, base, `${base}: Back`);
    assert.equal(tab("All").getAttribute("aria-pressed"), "true", `${base}: Back restores All`);
    history.forward();
    await settle();
    assert.equal(location.pathname + location.search, shared, `${base}: Forward`);
    assert.equal(tab("Shared with you").getAttribute("aria-pressed"), "true");
    assert.deepEqual(app.banners(), []);
  }
  history.replaceState(null, "", "/");
});

test("a Page opened from a /pages search keeps its address when the editor fails to load", async () => {
  const pageId = "1a160b47-6df1-4983-81eb-489ca5a26812";
  history.replaceState(null, "", "/pages");
  globalThis.__editorFails = true;
  try {
    await boot(signedIn, {
      ...catalog,
      list_pages: { pages: [{ page_id: pageId, title: "Roadmap" }], next_cursor: null },
    });
    await settle();
    const input = document.querySelector('input[type="search"]');
    await act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
        input,
        "road",
      );
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(() =>
      document
        .querySelector("form[role=search]")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
    await settle();
    assert.equal(location.pathname + location.search, "/pages?q=road");
    const row = [...document.querySelectorAll(".index-row-link")].find(
      (link) => link.textContent === "Roadmap",
    );
    await act(() => {
      row.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    await settle();
    // Reload reloads this address, so it must still name the Page.
    assert.equal(shownPagePath(), `/p/${pageId}`);
    assert.ok(document.querySelector(".build-update[role=alert]"), "the reload banner shows");
    // The listing behind the banner kept the search that was typed.
    assert.equal(document.querySelector("main h1")?.textContent, "Pages");
    assert.equal(document.querySelector('input[type="search"]').value, "road");
    // Back returns to that search, and from there the address follows it again.
    history.back();
    await settle();
    assert.equal(location.pathname + location.search, "/pages?q=road");
    assert.equal(document.querySelector('input[type="search"]').value, "road");
  } finally {
    globalThis.__editorFails = false;
  }
});

// What each library visit costs on the wire, counted at /api/tools.
const ROADMAP = "1a160b47-6df1-4983-81eb-489ca5a26812";
/** list_pages and list_projects calls in `requests` from `from` on. */
const listings = (requests, from = 0) => {
  const made = requests.slice(from);
  return {
    list_pages: made.filter((name) => name === "list_pages").length,
    list_projects: made.filter((name) => name === "list_projects").length,
  };
};
/** A catalog whose library listing waits on `gate.promise` while it is set.
 * list_pages answers for `who.current` with `pages`; a call without a limit
 * (the retry authority before a write) never waits. `gate.refuse` answers
 * the listing 401 instead. */
const gatedCatalog = (
  gate,
  { who = { current: "one" }, pages = [{ page_id: ROADMAP, title: "Roadmap" }] } = {},
) => ({
  ...catalog,
  list_pages: async (args) => {
    if (args.limit && gate.promise) await gate.promise;
    if (args.limit && gate.refuse)
      return Response.json({ error: "Sign in required", code: "unauthenticated" }, { status: 401 });
    return { pages, next_cursor: null, principal: who.current };
  },
});
const rows = () =>
  [...document.querySelectorAll(".index-row-link")].map((link) => link.textContent);
/** The start of what `selector` matches, or null. Assert on this, not on the
 * element: a failing assertion holding a jsdom node makes the test runner
 * serialize the whole DOM, which hangs the file instead of naming the test. */
const markup = (selector) => document.querySelector(selector)?.outerHTML.slice(0, 200) ?? null;
const click = (element) =>
  act(() => {
    element.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
  });

test("a cold library visit lists once and asks list_projects once, at / and /pages", async () => {
  for (const base of ["/", "/pages"]) {
    history.replaceState(null, "", base);
    const app = await boot(signedIn, gatedCatalog({}));
    await settle();
    assert.deepEqual(rows(), ["Roadmap"], base);
    assert.deepEqual(listings(app.requests), { list_pages: 1, list_projects: 1 }, base);
  }
  history.replaceState(null, "", "/projects");
  const projects = await boot(signedIn, catalog);
  await settle();
  assert.deepEqual(
    listings(projects.requests),
    { list_pages: 0, list_projects: 1 },
    "/projects and the shell share one list_projects",
  );
  history.replaceState(null, "", "/");
});

test("/ keeps its view in the canonical address", async () => {
  history.replaceState(null, "", "/?sort=activity&show=everyone&group=project&q=%20");
  await boot(signedIn, catalog);
  await settle();
  assert.equal(location.pathname + location.search, "/?group=project");
  history.replaceState(null, "", "/");
});

test("Back and Forward over a grouping ask for nothing", async () => {
  history.replaceState(null, "", "/");
  const app = await boot(signedIn, gatedCatalog({}));
  await settle();
  const from = app.requests.length;
  const group = document.querySelector('button[aria-label^="Group: "]');
  await click(group);
  await click(
    [...document.querySelectorAll('[role="menuitemradio"]')].find(
      (item) => item.querySelector(".library-menu-label").textContent === "Project",
    ),
  );
  await settle();
  assert.equal(location.pathname + location.search, "/?group=project");
  const control = document.querySelector('button[aria-label^="Group: "]');
  control.focus();
  history.back();
  await settle();
  assert.equal(location.pathname + location.search, "/");
  assert.equal(markup(".library-group"), null);
  history.forward();
  await settle();
  assert.equal(location.pathname + location.search, "/?group=project");
  assert.ok(document.querySelector(".library-group"), "the groups come back");
  assert.deepEqual(listings(app.requests, from), { list_pages: 0, list_projects: 0 });
  assert.equal(document.activeElement, control, "focus stays on the control");
  history.replaceState(null, "", "/");
});

test("Back from a Page paints the library from memory and lists it once", async (t) => {
  t.after(() => delete globalThis.__openPage);
  // The Page open never finishes, so the library leaves the screen.
  globalThis.__openPage = () => new Promise(() => {});
  history.replaceState(null, "", "/pages");
  const gate = {};
  const app = await boot(signedIn, gatedCatalog(gate));
  await settle();
  const row = [...document.querySelectorAll(".index-row-link")].find(
    (link) => link.textContent === "Roadmap",
  );
  await click(row);
  await settle();
  // The row knew the title: the address carries its slug from the click on,
  // though the Page never opens.
  assert.equal(location.pathname, `/p/${ROADMAP}/Roadmap`);
  assert.equal(markup(".library-view"), null, "the library left the screen");
  const from = app.requests.length;
  let release;
  gate.promise = new Promise((resolve) => (release = resolve));
  history.back();
  await settle();
  assert.equal(location.pathname + location.search, "/pages");
  assert.deepEqual(rows(), ["Roadmap"], "the rows paint before list_pages answers");
  assert.equal(markup(".index-status[role=status]"), null, "no Loading…");
  release();
  await settle();
  assert.deepEqual(rows(), ["Roadmap"]);
  assert.deepEqual(listings(app.requests, from), { list_pages: 1, list_projects: 1 });
  history.replaceState(null, "", "/");
});

// A Page whose host refuses its format shows a stopped screen
// (UnopenedPage.jsx). It is what the Page route shows: every route change
// leaves it, and it never stays over the library.
test("the stopped screen for a Page in an unopened format leaves with its route", async (t) => {
  t.after(() => delete globalThis.__openPage);
  globalThis.__openPage = () =>
    Promise.reject(
      Object.assign(Error("This Page is stored in a format this version of Pages doesn't open."), {
        status: 409,
        code: "document_format_unsupported",
      }),
    );
  history.replaceState(null, "", "/pages");
  await boot(signedIn, gatedCatalog({}), {
    paths: {
      "/api/access": () =>
        Response.json({ access: { role: "owner", canRead: true, canDelete: true } }),
    },
  });
  await settle();
  const stopped = () => document.querySelector("main.unopened-page")?.dataset.state ?? null;
  const open = () =>
    click(
      [...document.querySelectorAll(".index-row-link")].find((l) => l.textContent === "Roadmap"),
    );
  await open();
  await settle();
  assert.equal(shownPagePath(), `/p/${ROADMAP}`);
  assert.equal(stopped(), "owner");
  assert.deepEqual(rows(), [], "the library left the screen");
  // Back to the library: the stopped screen goes with its Page.
  history.back();
  await settle();
  assert.equal(location.pathname, "/pages");
  assert.equal(stopped(), null);
  assert.deepEqual(rows(), ["Roadmap"]);
  // Forward to the Page again shows it again.
  history.forward();
  await settle();
  assert.equal(shownPagePath(), `/p/${ROADMAP}`);
  assert.equal(stopped(), "owner");
  // An address that isn't a Page link leaves it too.
  history.pushState(null, "", "/p/not-a-page");
  await act(() => window.dispatchEvent(new window.PopStateEvent("popstate")));
  await settle();
  assert.equal(stopped(), null);
  history.replaceState(null, "", "/");
});

test("the stopped screen asks the host again for an account that signs in over it", async (t) => {
  t.after(() => delete globalThis.__openPage);
  globalThis.__openPage = () =>
    Promise.reject(
      Object.assign(Error("Refused"), { status: 409, code: "document_format_unsupported" }),
    );
  const who = { current: "one" };
  history.replaceState(null, "", `/p/${ROADMAP}`);
  await boot(accountSession(who), catalog, {
    paths: {
      "/api/access": () =>
        Response.json({ access: { canRead: true, canDelete: who.current === "one" } }),
    },
  });
  await settle();
  const stopped = () => document.querySelector("main.unopened-page")?.dataset.state ?? null;
  assert.equal(stopped(), "owner");
  who.current = "two";
  await sessionCheck();
  assert.equal(shownPagePath(), `/p/${ROADMAP}`);
  assert.equal(stopped(), "reader", "the other account is asked, and isn't the owner");
  history.replaceState(null, "", "/");
});

// The boot preview in the real shell: the head script's discovery, the
// session check, and an editor whose Page open never finishes, so the shell
// stays in "Opening" where the preview may show.
const { startEarlyConnect } = await import("./early-session.mjs");
const PREVIEW_PAGE = "5f0c4a5e-6c1e-4b0e-9a8f-0d0d4c5e6f70";
const SECRET = "Only Alice can read this.";
const accountSession = (who) => () =>
  Response.json({ identity: { principal: who.current, displayName: who.current }, canWrite: true });
const previewAnswer = (principal) =>
  Response.json({
    page_id: PREVIEW_PAGE,
    identity: { principal, displayName: principal },
    access: { canRead: true },
    preview: {
      title: "Private plan",
      blocks: [{ id: "b1", content: [["p", {}, SECRET]] }],
      truncated: false,
    },
  });
const showing = () =>
  !!document.querySelector(".page-preview") || document.body.textContent.includes(SECRET);
/** Boot on the Page route with the head script's discovery waiting on `answer`. */
async function bootPreview(who, answer) {
  history.replaceState(null, "", `/p/${PREVIEW_PAGE}`);
  // The open takes the early request, as openConnection does, and then waits.
  globalThis.__openPage = () => {
    delete globalThis.__pagesEarlyConnect;
    return new Promise(() => {});
  };
  await boot(accountSession(who), catalog, {
    connect: () => answer.promise,
    head: () => startEarlyConnect(globalThis),
  });
}
const sessionCheck = async () => {
  // A visible tab rechecks the session (browser-session.mjs).
  await act(() => document.dispatchEvent(new window.Event("visibilitychange")));
  await settle();
};
function deferredAnswer() {
  let resolve;
  const promise = new Promise((yes) => (resolve = yes));
  return { promise, resolve };
}

test("the shell shows the boot preview to the account the host answered for", async (t) => {
  t.after(() => delete globalThis.__openPage);
  const who = { current: "alice" };
  const answer = deferredAnswer();
  await bootPreview(who, answer);
  await settle();
  assert.equal(showing(), false, "nothing before the host answers");
  assert.equal(document.querySelector('[role="status"]')?.textContent, "Opening…");
  answer.resolve(previewAnswer("alice"));
  await settle();
  assert.ok(document.querySelector(".page-preview"), "the preview shows");
  assert.ok(document.body.textContent.includes(SECRET));
});

test("an account change after the preview showed hides it for the rest of the load", async (t) => {
  t.after(() => delete globalThis.__openPage);
  const who = { current: "alice" };
  const answer = deferredAnswer();
  await bootPreview(who, answer);
  answer.resolve(previewAnswer("alice"));
  await settle();
  assert.equal(showing(), true);
  // Another tab signs in as Bob; this tab's next session check sees it.
  who.current = "bob";
  await sessionCheck();
  assert.equal(showing(), false, "Bob never sees Alice's preview");
  // Switching back in this load doesn't bring it back.
  who.current = "alice";
  await sessionCheck();
  assert.equal(showing(), false);
});

test("an account change before the preview resolves ignores the late answer", async (t) => {
  t.after(() => delete globalThis.__openPage);
  const who = { current: "alice" };
  const answer = deferredAnswer();
  await bootPreview(who, answer);
  await settle();
  who.current = "bob";
  await sessionCheck();
  answer.resolve(previewAnswer("alice"));
  await settle();
  assert.equal(showing(), false);
});

test("navigating away and back to the Page doesn't bring the boot preview back", async (t) => {
  t.after(() => delete globalThis.__openPage);
  const who = { current: "alice" };
  const answer = deferredAnswer();
  await bootPreview(who, answer);
  answer.resolve(previewAnswer("alice"));
  await settle();
  assert.equal(showing(), true);
  history.pushState(null, "", "/");
  await act(() => window.dispatchEvent(new window.PopStateEvent("popstate")));
  await settle();
  assert.equal(showing(), false);
  history.back();
  await settle();
  assert.equal(shownPagePath(), `/p/${PREVIEW_PAGE}`);
  assert.equal(document.querySelector('[role="status"]')?.textContent, "Opening…");
  assert.equal(showing(), false);
});

// What the shell remembers for an account (the library's first pages and the
// account's Projects) and the edits that change it, through the real shell.
const { BehaviorSubject } = await import("rxjs");
const { RECOVERY_RERUNS } = await import("./signed-out-recovery.mjs");
const { CHECK_FAILED_MESSAGE, SAME_ACCOUNT_MESSAGE, SIGNED_OUT_MESSAGE } =
  await import("./picker-walk.mjs");
const { createElement } = await import("react");
const PLAN = "2b160b47-6df1-4983-81eb-489ca5a26812";
const PROJECT = "prj_3b160b47-6df1-4983-81eb-489ca5a26812";
const ROADMAP_AND_PLAN = [
  { page_id: ROADMAP, title: "Roadmap" },
  { page_id: PLAN, title: "Plan" },
];
/** A Page session the shell can install: it owns the Page, reads only, and
 * holds `title`. `rename` changes the title as an edit would. */
function fakeSession(pageId, principal, title, { draft = false } = {}) {
  const phase = new BehaviorSubject({ name: "open" });
  const sources = new BehaviorSubject({});
  const doc = { title };
  const listeners = new Set();
  const close = async () => phase.next({ name: "closed" });
  return {
    pageId,
    identity: { principal, displayName: principal },
    doc,
    alive: true,
    phase$: { snapshot: () => phase.value, state$: phase },
    pageSources: { snapshot: () => sources.value, sources$: sources.asObservable() },
    sources: { demand: () => () => {} },
    canWrite: false,
    canComment: false,
    canDelete: true,
    canRestore: false,
    hidden: false,
    authRequired: false,
    accessReloadRequired: false,
    recoveryPending: false,
    // A draft made in this tab registers later (`register`); until then
    // read_page can't find it.
    localPage: draft ? { registration: {}, registered: false } : { registered: true },
    connection: draft ? null : {},
    status: "saved",
    statusKey: "saved",
    saveState: "saving",
    savedHeads: [],
    snapshot: () => ({ page_id: pageId, title: doc.title, blocks: [], comments: [] }),
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    watchCommentDrafts() {},
    listRecoveries: async () => [],
    retryConnection: async () => {},
    leave: close,
    close,
    closeSettled: async () => {},
    rename(next) {
      doc.title = next;
      for (const listener of listeners) listener();
    },
    // Another account's session answer leaves this Page waiting to sign in
    // again, as a real session does.
    acceptAuthentication(result) {
      if (result.identity?.principal === principal) {
        this.authRequired = false;
        return true;
      }
      this.authRequired = true;
      return false;
    },
    register() {
      this.localPage = { ...this.localPage, registered: true };
      this.connection = {};
      for (const listener of listeners) listener();
    },
  };
}
/** The page menu as plain buttons, one per action. */
const editorSurface = {
  PageControls: ({ actions }) =>
    createElement(
      "div",
      { className: "fake-page-actions" },
      actions.map((action) =>
        createElement("button", { key: action.key, onClick: action.run }, action.label),
      ),
    ),
};

test("comment close returns focus only while the closing interaction still owns it", async (t) => {
  t.after(() => {
    delete globalThis.__openPage;
    delete globalThis.__editor;
    history.replaceState(null, "", "/");
  });
  let close;
  globalThis.__editor = {
    ...editorSurface,
    PageControls: ({ children }) => children,
    CommentsPanel: ({ open, onClose }) => {
      close = onClose;
      return open
        ? createElement(
            "div",
            { id: "page-comments" },
            createElement("button", { id: "fixture-close", onClick: onClose }, "Close fixture"),
          )
        : null;
    },
  };
  globalThis.__openPage = async (id) => fakeSession(id, "one", "Focus fixture");
  history.replaceState(null, "", `/p/${ROADMAP}`);
  await boot(signedIn, { ...catalog, read_page: { breadcrumbs: [] } });
  await settle();
  const trigger = document.querySelector('[aria-label="Comments"]');
  assert.ok(trigger);
  const raf = globalThis.requestAnimationFrame,
    frames = [];
  globalThis.requestAnimationFrame = (callback) => (frames.push(callback), frames.length);
  t.after(() => (globalThis.requestAnimationFrame = raf));
  const flush = async () => {
    await act(() => {
      for (const callback of frames.splice(0)) callback(0);
    });
  };
  const open = async () => {
    await click(trigger);
    await flush();
  };
  await open();
  const closeButton = document.querySelector("#fixture-close");
  closeButton.focus();
  await act(() => close());
  await flush();
  assert.ok(document.activeElement === trigger, "ordinary close returns trigger focus");

  await open();
  trigger.focus(); // Native modal close already returned focus.
  await act(() => close());
  const editable = document.body.appendChild(document.createElement("div"));
  editable.contentEditable = "true";
  editable.tabIndex = 0;
  editable.textContent = "fox";
  editable.focus();
  const range = document.createRange();
  range.selectNodeContents(editable);
  document.getSelection().removeAllRanges();
  document.getSelection().addRange(range);
  await flush();
  assert.ok(document.activeElement === editable, "editor focus acquired before the frame survives");
  assert.equal(document.getSelection().toString(), "fox");

  await open();
  await act(() => close());
  const other = document.body.appendChild(document.createElement("button"));
  other.focus();
  await flush();
  assert.ok(document.activeElement === other, "another control keeps focus");

  await open();
  other.focus(); // Native Escape+Tab can move focus before the close event arrives.
  await act(() => close());
  await flush();
  assert.ok(document.activeElement === other, "control focused before onClose keeps focus");

  await open();
  editable.focus();
  document.getSelection().removeAllRanges();
  document.getSelection().addRange(range);
  await act(() => close());
  await flush();
  assert.ok(document.activeElement === editable, "editor focused before onClose keeps focus");
  assert.equal(document.getSelection().toString(), "fox");

  other.focus();
  await act(() => close());
  await flush();
  assert.ok(document.activeElement === other, "absent panel cannot claim outside focus");

  await open();
  trigger.focus();
  await act(() => close());
  await click(trigger); // Reopen before the old frame.
  const reopened = document.querySelector("#fixture-close");
  reopened.focus();
  await flush();
  assert.ok(document.activeElement === reopened, "reopened dialog keeps focus");
  await act(() => close());
  history.pushState(null, "", "/");
  await act(() => window.dispatchEvent(new window.PopStateEvent("popstate")));
  assert.equal(trigger.isConnected, false);
  other.focus();
  await flush();
  assert.ok(document.activeElement === other, "detached trigger is harmless");
  editable.remove();
  other.remove();
});
const pageAction = (label) =>
  [...document.querySelectorAll(".fake-page-actions button")].find(
    (button) => button.textContent === label,
  );
const openRow = async (title) => {
  await click(
    [...document.querySelectorAll(".index-row-link")].find((link) => link.textContent === title),
  );
  await settle();
};
/** Open `pageId`'s address and leave the library behind; the open never ends. */
const leaveForPage = async (pageId) => {
  globalThis.__openPage = () => new Promise(() => {});
  history.pushState(null, "", `/p/${pageId}`);
  await act(() => window.dispatchEvent(new window.PopStateEvent("popstate")));
  await settle();
  assert.equal(markup(".library-view"), null, "the library left the screen");
};
const closed = () => {
  const gate = {};
  gate.promise = new Promise((resolve) => (gate.release = resolve));
  return gate;
};
const sessionRequests = (app) => app.requests.filter((path) => path === "/api/auth/session").length;
/** The library's own button named `name` (the picker has a New Page too). */
const button = (name) =>
  [...document.querySelectorAll(".library-view button")].find(
    (element) => element.textContent.trim() === name,
  );
const toolCalls = (app, name) => app.requests.filter((entry) => entry === name).length;
/** Wait at most `ms` for `found()` to return something, then return it, so a
 * missing element fails its assertion rather than hanging the file. */
async function until(found, ms = 2000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    const value = found();
    if (value) return value;
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  return found();
}
const cleanUp = (t) =>
  t.after(() => {
    delete globalThis.__openPage;
    delete globalThis.__editor;
    history.replaceState(null, "", "/");
  });

test("Project and legacy links open the existing document editor and tree", async (t) => {
  cleanUp(t);
  const opened = [];
  globalThis.__editor = editorSurface;
  const copied = [];
  const previousClipboard = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value) => copied.push(value) },
  });
  t.after(() =>
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: previousClipboard }),
  );
  globalThis.__openPage = async (id) => {
    opened.push(id);
    return fakeSession(id, "one", "Existing project content");
  };
  for (const prefix of ["project", "s", "p"]) {
    history.replaceState(null, "", `/${prefix}/${prefix === "p" ? ROADMAP : PROJECT}`);
    const app = await boot(signedIn, {
      ...catalog,
      get_project: { project_id: PROJECT, document_id: ROADMAP, title: "Launch", role: "owner" },
      read_page: { project_id: PROJECT, kind: "project", breadcrumbs: [] },
      list_pages: {
        pages: [{ page_id: PLAN, project_id: PROJECT, parent_id: null, title: "Plan" }],
        next_cursor: null,
      },
    });
    await until(() => document.querySelector(".project-pages a"));
    assert.equal(opened.at(-1), ROADMAP);
    assert.equal(location.pathname, `/project/${PROJECT}`);
    assert.equal(
      document.querySelector(".document-print-title")?.textContent,
      "Existing project content",
    );
    assert.match(document.querySelector(".project-pages")?.textContent, /Plan/);
    assert.equal(document.querySelector(".project-view"), null);
    assert.equal(document.querySelectorAll(".project-pages a").length, 1);
    assert.equal(toolCalls(app, "get_project"), 1, "resolved Project details are reused");
    const count = opened.length;
    await click(document.querySelector(".project-chip"));
    assert.equal(opened.length, count, "Project chip retains the open document");
    history.pushState(null, "", `/p/${ROADMAP}`);
    await act(() => window.dispatchEvent(new window.PopStateEvent("popstate")));
    assert.equal(
      location.pathname,
      `/project/${PROJECT}`,
      "same-document navigation canonicalizes too",
    );
    assert.equal(opened.length, count, "canonicalization never reopens the content document");
    await click(pageAction("Copy link"));
    assert.equal(copied.at(-1), `http://localhost/project/${PROJECT}`);
    assert.equal(!!pageAction("Move to Trash"), false);
  }
});

test("the document menu's Copy link carries the title's slug, else the address's", async (t) => {
  cleanUp(t);
  globalThis.__editor = editorSurface;
  const copied = [];
  const previousClipboard = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value) => copied.push(value) },
  });
  t.after(() =>
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: previousClipboard }),
  );
  // The copy never waits for the address to catch up with the title. Each
  // case opens its own Page: an earlier boot's App stays mounted and keeps
  // its own Page's address on that Page's title.
  for (const [n, path, title, expected] of [
    [1, "", "Plan content", "/Plan-content"],
    [2, "/Some-Title", "Plan content", "/Plan-content"],
    // A title with no slug keeps the one the address shows, or none.
    [3, "/Some-Title/", "日本語", "/Some-Title"],
    [4, "", "", ""],
  ]) {
    const id = `3c160b47-6df1-4983-81eb-00000000000${n}`;
    const address = `/p/${id}${path}`;
    globalThis.__openPage = async (opened) => fakeSession(opened, "one", title);
    history.replaceState(null, "", address);
    await boot(signedIn, {
      ...catalog,
      read_page: ({ page_id }) => ({ page_id, kind: "page", breadcrumbs: [] }),
    });
    // This boot's Page, not the one before it, is on screen.
    await until(
      () => document.querySelector('input[aria-label="Page title"]')?.value === title || null,
    );
    const before = copied.length;
    await click(await until(() => pageAction("Copy link")));
    await until(() => copied.length > before);
    assert.equal(copied.length, before + 1, address);
    assert.equal(
      copied.at(-1),
      `http://localhost/p/${id}${expected}`,
      `${address} titled ${JSON.stringify(title)}`,
    );
    assert.equal(shownPagePath(), `/p/${id}`, address);
  }
});

test("signed-out Project links name the Project and failed opens offer a way back", async (t) => {
  cleanUp(t);
  history.replaceState(null, "", `/project/${PROJECT}`);
  await boot(() => Response.json({ error: "Sign in required" }, { status: 401 }));
  assert.equal(document.querySelector("h1").textContent, "Sign in to open this Project.");
  await boot(signedIn, {
    ...catalog,
    get_project: () => Response.json({ error: "Unavailable" }, { status: 404 }),
  });
  await until(() =>
    [...document.querySelectorAll("a")].find((link) => link.textContent === "Back to Projects"),
  );
  const back = [...document.querySelectorAll("a")].find(
    (link) => link.textContent === "Back to Projects",
  );
  assert.equal(back?.getAttribute("href"), "/projects");
});

test("leaving a resolving Project cannot install its late document", async (t) => {
  cleanUp(t);
  const gate = closed();
  const opened = [];
  globalThis.__openPage = async (id) => {
    opened.push(id);
    return fakeSession(id, "one", "Direct Page");
  };
  history.replaceState(null, "", `/project/${PROJECT}`);
  await boot(signedIn, { ...catalog, get_project: () => gate.promise, read_page: {} });
  history.pushState(null, "", `/p/${PLAN}`);
  await act(() => window.dispatchEvent(new window.PopStateEvent("popstate")));
  await settle();
  gate.release({ document_id: ROADMAP });
  await settle();
  assert.deepEqual(opened, [PLAN]);
  assert.equal(shownPagePath(), `/p/${PLAN}`);
});

test("Project navigation detaches the previous Page while its checkpoint drains, then retries a failed lookup", async (t) => {
  cleanUp(t);
  globalThis.__editor = editorSurface;
  const previous = fakeSession(PLAN, "one", "Previous local content", { draft: true });
  const draining = closed();
  let leaves = 0;
  previous.leave = () => {
    leaves++;
    return draining.promise;
  };
  previous.closeSettled = () => draining.promise;
  t.after(() => draining.release());
  globalThis.__openPage = async (id) =>
    id === PLAN ? previous : fakeSession(id, "one", "Destination content");
  const lookup = deferredAnswer();
  let fail = true;
  history.replaceState(null, "", `/p/${PLAN}`);
  await boot(signedIn, {
    ...catalog,
    read_page: ({ page_id }) => ({
      page_id,
      kind: page_id === ROADMAP ? "project" : "page",
      ...(page_id === ROADMAP && { project_id: PROJECT }),
      breadcrumbs: [],
    }),
    get_project: () =>
      fail ? lookup.promise : { project_id: PROJECT, document_id: ROADMAP, role: "owner" },
  });
  assert.ok(await until(() => pageAction("Copy link")));
  history.pushState(null, "", `/project/${PROJECT}`);
  await act(() => window.dispatchEvent(new window.PopStateEvent("popstate")));
  await settle();
  assert.equal(leaves, 1, "the host drains the previous Page without awaiting it");
  assert.equal(document.querySelector(".document-print-title"), null);
  assert.equal(pageAction("Copy link"), undefined);
  assert.equal(document.querySelector('[role="status"]')?.textContent, "Opening…");
  await act(() => lookup.resolve(Response.json({ error: "Lookup failed" }, { status: 503 })));
  await settle();
  assert.equal(document.querySelector(".document-print-title"), null);
  const retry = [...document.querySelectorAll("button")].find(
    (node) => node.textContent === "Retry opening Project",
  );
  assert.ok(retry);
  fail = false;
  await click(retry);
  assert.equal(
    (await until(() => document.querySelector(".document-print-title")))?.textContent,
    "Destination content",
  );
  assert.equal(leaves, 1, "retrying never closes the draining Page twice");
  assert.equal(pageAction("Move to Trash"), undefined);
});

test("a content document's failed Project lookup offers retry and ignores its late answer after navigation", async (t) => {
  cleanUp(t);
  globalThis.__editor = editorSurface;
  globalThis.__openPage = async (id) =>
    fakeSession(id, "one", id === ROADMAP ? "Project content" : "Other");
  const answer = deferredAnswer();
  let attempts = 0;
  history.replaceState(null, "", `/p/${ROADMAP}`);
  const app = await boot(signedIn, {
    ...catalog,
    read_page: ({ page_id }) => ({
      page_id,
      kind: page_id === ROADMAP ? "project" : "page",
      ...(page_id === ROADMAP && { project_id: PROJECT }),
      breadcrumbs: [],
    }),
    get_project: () =>
      ++attempts === 1
        ? Response.json({ error: "Lookup failed" }, { status: 503 })
        : answer.promise,
  });
  assert.ok(await until(() => pageAction("Retry Project access")));
  assert.equal(document.querySelector(".document-print-title")?.textContent, "Project content");
  assert.equal(
    location.pathname,
    `/project/${PROJECT}`,
    "disclosed content canonicalizes its legacy link",
  );
  assert.ok(app.banners().length);
  await click(pageAction("Retry Project access"));
  await settle();
  assert.equal(attempts, 2);
  assert.equal(pageAction("Retry Project access"), undefined, "no duplicate retry while loading");
  history.pushState(null, "", `/p/${PLAN}`);
  await act(() => window.dispatchEvent(new window.PopStateEvent("popstate")));
  await settle();
  await act(() => answer.resolve({ project_id: PROJECT, role: "owner", document_id: ROADMAP }));
  await settle();
  assert.equal(document.querySelector(".document-print-title")?.textContent, "Other");
  assert.equal(pageAction("Retry Project access"), undefined);
});

test("retrying Project access updates only the installed content document's sharing context", async (t) => {
  cleanUp(t);
  let sharing;
  globalThis.__editor = {
    ...editorSurface,
    PageControls: (props) => {
      sharing = props.project;
      return editorSurface.PageControls(props);
    },
  };
  globalThis.__openPage = async (id) => fakeSession(id, "one", "Project content");
  history.replaceState(null, "", `/p/${ROADMAP}`);
  let fail = true;
  await boot(signedIn, {
    ...catalog,
    read_page: { page_id: ROADMAP, kind: "project", project_id: PROJECT, breadcrumbs: [] },
    get_project: () =>
      fail
        ? Response.json({ error: "Lookup failed" }, { status: 503 })
        : { project_id: PROJECT, document_id: ROADMAP, role: "owner" },
  });
  assert.ok(await until(() => pageAction("Retry Project access")));
  assert.deepEqual(sharing, { project_id: PROJECT, role: "unavailable" });
  fail = false;
  await click(pageAction("Retry Project access"));
  await until(() => sharing.role === "owner");
  assert.equal(sharing.project_id, PROJECT);
  assert.equal(sharing.role, "owner");
  assert.equal(pageAction("Retry Project access"), undefined);
  assert.equal(document.querySelector(".document-print-title")?.textContent, "Project content");
});

test("a directly granted content document opens without exposing Project access", async (t) => {
  cleanUp(t);
  let sharing;
  globalThis.__editor = {
    ...editorSurface,
    PageControls: (props) => {
      sharing = props.project;
      return editorSurface.PageControls(props);
    },
  };
  globalThis.__openPage = async (id) => ({
    ...fakeSession(id, "one", "Shared document"),
    canDelete: false,
  });
  history.replaceState(null, "", `/p/${ROADMAP}`);
  const app = await boot(signedIn, { ...catalog, read_page: { kind: "page", breadcrumbs: [] } });
  await until(() => document.querySelector(".document-print-title"));
  assert.equal(toolCalls(app, "get_project"), 0);
  assert.equal(shownPagePath(), `/p/${ROADMAP}`);
  assert.equal(document.querySelector(".project-pages"), null);
  assert.equal(document.querySelector(".project-chip"), null);
  assert.equal(sharing, null, "direct access never opens Project membership controls");
  assert.equal(document.querySelector(".document-print-title")?.textContent, "Shared document");
});

test("a late document location cannot disclose a Project after an account change", async (t) => {
  cleanUp(t);
  globalThis.__editor = editorSurface;
  const who = { current: "alice" };
  globalThis.__openPage = async (id) => fakeSession(id, "alice", "Content");
  const placed = deferredAnswer();
  history.replaceState(null, "", `/p/${ROADMAP}`);
  const projectListings = [];
  const app = await boot(accountSession(who), {
    ...catalog,
    read_page: () => placed.promise,
    list_pages: (args) => {
      if (args.project_id) projectListings.push(args);
      return catalog.list_pages;
    },
  });
  assert.ok(await until(() => pageAction("Copy link")));
  who.current = "bob";
  await sessionCheck();
  await act(() =>
    placed.resolve({
      kind: "project",
      project_id: PROJECT,
      breadcrumbs: [{ kind: "project", project_id: PROJECT, title: "Private Project" }],
    }),
  );
  await settle();
  assert.equal(shownPagePath(), `/p/${ROADMAP}`, "late metadata cannot rewrite the URL");
  assert.equal(toolCalls(app, "get_project"), 0);
  assert.equal(projectListings.length, 0, "the stale Project tree is never requested");
  assert.equal(document.querySelector(".project-chip"), null);
  assert.doesNotMatch(document.body.textContent, /Private Project/);
});

test("late Project tree rows never paint over the next document", async (t) => {
  cleanUp(t);
  globalThis.__editor = editorSurface;
  globalThis.__openPage = async (id) => fakeSession(id, "one", "Content");
  const listed = deferredAnswer();
  history.replaceState(null, "", `/project/${PROJECT}`);
  await boot(signedIn, {
    ...catalog,
    get_project: { project_id: PROJECT, document_id: ROADMAP, role: "owner" },
    read_page: ({ page_id }) => ({
      kind: page_id === ROADMAP ? "project" : "page",
      ...(page_id === ROADMAP && { project_id: PROJECT }),
      breadcrumbs: [],
    }),
    list_pages: () => listed.promise,
  });
  assert.ok(await until(() => document.querySelector(".project-pages")));
  history.pushState(null, "", `/p/${PLAN}`);
  await act(() => window.dispatchEvent(new window.PopStateEvent("popstate")));
  await settle();
  await act(() =>
    listed.resolve({
      pages: [{ page_id: ROADMAP, project_id: PROJECT, title: "Stale child", parent_id: null }],
    }),
  );
  await settle();
  assert.equal(shownPagePath(), `/p/${PLAN}`);
  assert.equal(document.querySelector(".project-pages"), null);
  assert.doesNotMatch(document.body.textContent, /Stale child/);
});

test("a Project member sees shared tree rows but no structure controls", async (t) => {
  cleanUp(t);
  globalThis.__openPage = async (id) => ({
    ...fakeSession(id, "one", "Shared Project"),
    canDelete: false,
  });
  history.replaceState(null, "", `/project/${PROJECT}`);
  await boot(signedIn, {
    ...catalog,
    get_project: { project_id: PROJECT, role: "viewer", document_id: ROADMAP },
    read_page: { project_id: PROJECT, kind: "project", breadcrumbs: [] },
    list_pages: {
      pages: [{ page_id: PLAN, project_id: PROJECT, shared: true, title: "Member child" }],
      next_cursor: null,
    },
  });
  await until(() => document.querySelector(".project-pages a"));
  assert.match(document.querySelector(".project-pages").textContent, /Member child/);
  assert.equal(document.querySelector(".project-new-page"), null);
});

test("an account change forgets the rows remembered for the last one", async (t) => {
  cleanUp(t);
  const who = { current: "alice" };
  history.replaceState(null, "", "/pages");
  const gate = {};
  await boot(accountSession(who), gatedCatalog(gate, { who }));
  await settle();
  assert.deepEqual(rows(), ["Roadmap"]);
  // Bob signs in from another window, then Alice again.
  who.current = "bob";
  await sessionCheck();
  who.current = "alice";
  Object.assign(gate, closed());
  await sessionCheck();
  assert.deepEqual(rows(), [], "nothing Alice saw before Bob paints");
  assert.match(document.querySelector(".index-status[role=status]")?.textContent ?? "", /Loading/);
  gate.release();
  await settle();
  assert.deepEqual(rows(), ["Roadmap"]);
});

test("sign-out forgets the rows remembered for the account", async (t) => {
  cleanUp(t);
  history.replaceState(null, "", "/pages");
  const gate = {};
  await boot(signedIn, gatedCatalog(gate), {
    paths: { "/api/auth/logout": () => Response.json({ ok: true }) },
  });
  await settle();
  assert.deepEqual(rows(), ["Roadmap"]);
  await click(
    [...document.querySelectorAll(".account-actions button")].find((button) =>
      button.textContent.includes("Sign out"),
    ),
  );
  await settle();
  // jsdom can't leave for /, so this tab stays; what it shows next must not
  // come from memory.
  await leaveForPage(PLAN);
  Object.assign(gate, closed());
  history.back();
  await settle();
  assert.deepEqual(rows(), [], "nothing paints from before the sign-out");
  gate.release();
  await settle();
});

const withAccountControls = () =>
  Response.json({
    identity: { principal: "one", displayName: "Kyle" },
    canWrite: true,
    accountControls: true,
  });
const accountMenuItems = () =>
  [
    ...document.querySelectorAll(
      ".account-actions .menu-popover > button, .account-actions .menu-popover > a",
    ),
  ].map((node) => node.textContent.trim());

test("a host that doesn't advertise account controls offers no Connected agents", async (t) => {
  cleanUp(t);
  history.replaceState(null, "", "/pages");
  const app = await boot(signedIn, catalog);
  await settle();
  assert.equal(
    accountMenuItems().some((text) => text.includes("Connected agents")),
    false,
  );
  assert.ok(accountMenuItems().some((text) => text.includes("Sign out")));
  assert.equal(app.requests.includes("/api/auth/grants"), false);
});

test("a 404 from the account routes hides Connected agents without an error", async (t) => {
  cleanUp(t);
  history.replaceState(null, "", "/pages");
  // What an ingress without the account routes answers: a proxy's HTML 404.
  const app = await boot(withAccountControls, catalog, {
    paths: {
      "/api/auth/grants": () =>
        new Response("<h1>Not Found</h1>", {
          status: 404,
          headers: { "content-type": "text/html" },
        }),
    },
  });
  await settle();
  const entry = () =>
    [...document.querySelectorAll(".account-actions button")].find((button) =>
      button.textContent.includes("Connected agents"),
    );
  await click(entry());
  await settle();
  const dialog = document.querySelector(".connected-agents-dialog");
  assert.match(dialog.textContent, /aren't available on this server yet/);
  assert.equal(dialog.querySelector("[role=alert]"), null);
  assert.equal(
    [...dialog.querySelectorAll("button")].some((b) =>
      b.textContent.includes("Sign out everywhere"),
    ),
    false,
  );
  assert.deepEqual(app.banners(), []);
  await click(dialog.querySelector('[aria-label="Close Connected agents"]'));
  await settle();
  assert.equal(document.querySelector(".connected-agents-dialog"), null);
  assert.equal(entry(), undefined, "the menu stops offering it");
  assert.equal(app.requests.includes("/api/auth/logout-all"), false);
});

test("the account menu lists connected agents, disconnects one and signs out everywhere", async (t) => {
  cleanUp(t);
  history.replaceState(null, "", "/pages");
  const handle = (n) => String(n).repeat(43);
  const agents = [
    {
      id: handle(1),
      name: "Kilo",
      scope: "pages:read pages:write",
      created_at: "2026-11-01T12:00:00.000Z",
      expires_at: "2026-12-01T12:00:00.000Z",
    },
    {
      id: handle(2),
      name: "ChatGPT",
      scope: "pages:read",
      created_at: null,
      expires_at: "2026-12-01T12:00:00.000Z",
    },
  ];
  const gate = {};
  const app = await boot(withAccountControls, gatedCatalog(gate), {
    paths: {
      "/api/auth/grants": () => Response.json({ agents }),
      [`/api/auth/grants/${handle(1)}/revoke`]: () => Response.json({ revoked: true }),
      "/api/auth/logout-all": () => Response.json({ ok: true, sessions: 2, agents: 1 }),
    },
  });
  await settle();
  assert.deepEqual(rows(), ["Roadmap"]);
  const menuButton = (text) =>
    [...document.querySelectorAll(".account-actions button")].find((button) =>
      button.textContent.includes(text),
    );
  const dialogButton = (text) =>
    [...document.querySelectorAll(".connected-agents-dialog button")].find((button) =>
      button.textContent.includes(text),
    );
  const listed = () =>
    [...document.querySelectorAll(".connected-agents li strong")].map((node) => node.textContent);
  await click(menuButton("Connected agents"));
  await settle();
  assert.deepEqual(listed(), ["Kilo", "ChatGPT"]);
  // API-key agents aren't listed or signed out; the copy says so.
  const copy = document.querySelector(".connected-agents-dialog").textContent;
  assert.match(copy, /connected through Pages sign-in/);
  assert.match(copy, /Anaconda API key aren't listed here/);
  assert.match(copy, /API keys keep working until you revoke them in Anaconda/);
  assert.doesNotMatch(copy, /disconnect every agent\./);
  assert.match(
    document.querySelector(".connected-agents").textContent,
    /Read and edit.*Connected earlier · Read only/,
  );
  await click(document.querySelector(`[aria-label="Disconnect Kilo"]`));
  await settle();
  assert.deepEqual(listed(), ["ChatGPT"]);
  assert.ok(app.requests.includes(`/api/auth/grants/${handle(1)}/revoke`));

  // Sign out everywhere asks first, and Cancel goes back.
  await click(dialogButton("Sign out everywhere"));
  assert.ok(dialogButton("Cancel"));
  assert.equal(app.requests.includes("/api/auth/logout-all"), false);
  await click(dialogButton("Cancel"));
  assert.equal(dialogButton("Cancel"), undefined);
  await click(dialogButton("Sign out everywhere"));
  await click(dialogButton("Sign out everywhere"));
  await settle();
  assert.equal(app.requests.filter((path) => path === "/api/auth/logout-all").length, 1);
  // Like Sign out, nothing remembered for the account paints afterwards.
  await leaveForPage(PLAN);
  Object.assign(gate, closed());
  history.back();
  await settle();
  assert.deepEqual(rows(), [], "nothing paints from before the sign-out");
  gate.release();
  await settle();
});

test("a tool call refused as signed out forgets the rows, checks the session and asks for the Projects again", async (t) => {
  cleanUp(t);
  history.replaceState(null, "", "/pages");
  const gate = {};
  const app = await boot(signedIn, gatedCatalog(gate));
  await settle();
  await leaveForPage(PLAN);
  const checks = sessionRequests(app);
  const projects = toolCalls(app, "list_projects");
  gate.refuse = true;
  history.back();
  await settle();
  assert.equal(sessionRequests(app), checks + 1, "the session is asked again");
  // Back asks for the Projects once; the same account answering the session
  // check asks again, since the 401 forgot them.
  assert.equal(toolCalls(app, "list_projects"), projects + 2);
  assert.ok(document.querySelector(".library-view"));
  gate.refuse = false;
  await leaveForPage(PLAN);
  Object.assign(gate, closed());
  history.back();
  await settle();
  assert.deepEqual(rows(), [], "nothing paints from before the 401");
  gate.release();
  await settle();
  assert.deepEqual(rows(), ["Roadmap"]);
});

test("Project content documents offer neither Move nor Trash", async (t) => {
  cleanUp(t);
  globalThis.__editor = editorSurface;
  globalThis.confirm = () => true;
  t.after(() => delete globalThis.confirm);
  history.replaceState(null, "", "/pages");
  const gate = {};
  const placed = deferredAnswer();
  const tools = {
    ...gatedCatalog(gate, { pages: ROADMAP_AND_PLAN }),
    read_page: () => placed.promise,
    delete_page: () => ({ page_id: PLAN }),
  };
  await boot(signedIn, tools);
  await settle();
  assert.deepEqual(rows(), ["Roadmap", "Plan"]);
  globalThis.__openPage = (id) => Promise.resolve(fakeSession(id, "one", "Plan"));
  await openRow("Plan");
  assert.equal(shownPagePath(), `/p/${PLAN}`);
  assert.ok(await until(() => pageAction("Copy link")), "the Page is open");
  assert.equal(!!pageAction("Move to Trash"), false, "unknown placement cannot be trashed");
  assert.ok(pageAction("Move to…"), "offered before read_page answers; it asks when chosen");
  placed.resolve({ page_id: PLAN, project_id: PROJECT, kind: "project", breadcrumbs: [] });
  await settle();
  assert.equal(!!pageAction("Move to…"), false, "Project content stays put");
  assert.equal(!!pageAction("Move to Trash"), false);
});

test("an ordinary remote Page offers Trash only once its placement is known", async (t) => {
  cleanUp(t);
  globalThis.__editor = editorSurface;
  globalThis.__openPage = async (id) => fakeSession(id, "one", "Ordinary Page");
  history.replaceState(null, "", `/p/${PLAN}`);
  const placed = deferredAnswer();
  await boot(signedIn, { ...catalog, read_page: () => placed.promise });
  assert.ok(await until(() => pageAction("Copy link")));
  assert.equal(!!pageAction("Move to Trash"), false);
  await act(() => placed.resolve({ page_id: PLAN, kind: "page", breadcrumbs: [] }));
  assert.ok(await until(() => pageAction("Move to Trash")));
});

test("clicking Trash on a local draft preserves it when the host refuses deletion", async (t) => {
  cleanUp(t);
  t.after(() => delete globalThis.__createPage);
  const previousConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  t.after(() => (globalThis.confirm = previousConfirm));
  globalThis.__editor = editorSurface;
  const draft = fakeSession(PLAN, "one", "Local content", { draft: true });
  let leaves = 0;
  draft.leave = async () => leaves++;
  globalThis.__createPage = async () => draft;
  history.replaceState(null, "", "/pages");
  const app = await boot(signedIn, {
    ...catalog,
    read_page: () => Response.json({ code: "page_not_found" }, { status: 404 }),
    delete_page: () =>
      Response.json({ error: "Forbidden", code: "permission_denied" }, { status: 403 }),
  });
  await settle();
  await click(button("New Page"));
  assert.ok(await until(() => pageAction("Move to Trash")));
  await click(pageAction("Move to Trash"));
  await settle();
  assert.equal(toolCalls(app, "delete_page"), 1);
  assert.equal(leaves, 0);
  assert.equal(shownPagePath(), `/p/${PLAN}`);
  assert.equal(document.querySelector(".document-print-title")?.textContent, "Local content");
  assert.ok(app.banners().length);
});

for (const registration of ["pending", "rejected"]) {
  test(`an owned ${registration} local draft offers Trash without remote placement`, async (t) => {
    cleanUp(t);
    t.after(() => delete globalThis.__createPage);
    globalThis.__editor = editorSurface;
    history.replaceState(null, "", "/pages");
    const draft = fakeSession(PLAN, "one", "Untitled", { draft: true });
    globalThis.__createPage = async () => draft;
    const placed = deferredAnswer();
    const app = await boot(signedIn, {
      ...catalog,
      read_page: () => placed.promise,
    });
    await settle();
    await click(button("New Page"));
    assert.ok(await until(() => pageAction("Copy link")));
    if (registration === "rejected") {
      // Rejected registration leaves no host Page for read_page to locate.
      await act(() =>
        placed.resolve(
          Response.json({ error: "Page not found", code: "page_not_found" }, { status: 404 }),
        ),
      );
      await settle();
    }
    assert.equal(toolCalls(app, "read_page"), 1);
    assert.ok(pageAction("Move to Trash"));
    assert.equal(toolCalls(app, "delete_page"), 0, "showing Trash does not delete the draft");
    await act(() => {
      draft.canDelete = false;
      draft.rename("Untitled");
    });
    await settle();
    assert.equal(!!pageAction("Move to Trash"), false, "the draft still needs owner capability");
    await act(() => {
      draft.canDelete = true;
      draft.authRequired = true;
      draft.rename("Untitled");
    });
    await settle();
    assert.equal(!!pageAction("Move to Trash"), false, "a signed-out draft cannot be discarded");
    await act(() => {
      draft.authRequired = false;
      draft.identity = { principal: "another-account" };
      draft.rename("Untitled");
    });
    await settle();
    assert.equal(!!pageAction("Move to Trash"), false, "another account cannot discard the draft");
  });
}

test("a rename shows when Back returns to the library", async (t) => {
  cleanUp(t);
  globalThis.__editor = editorSurface;
  history.replaceState(null, "", "/pages");
  const gate = {};
  await boot(signedIn, gatedCatalog(gate, { pages: ROADMAP_AND_PLAN }));
  await settle();
  const session = fakeSession(ROADMAP, "one", "Roadmap");
  globalThis.__openPage = () => Promise.resolve(session);
  await openRow("Roadmap");
  assert.equal(document.querySelector("input.document-title")?.value, "Roadmap");
  session.rename("Roadmap v2");
  await settle();
  Object.assign(gate, closed());
  history.back();
  await settle();
  assert.equal(location.pathname, "/pages");
  assert.deepEqual(rows(), ["Roadmap v2", "Plan"], "the new title paints from memory");
  gate.release();
  await settle();
});

test("Back and Forward between library addresses close the Browse picker", async (t) => {
  cleanUp(t);
  history.replaceState(null, "", "/");
  await boot(signedIn, gatedCatalog({}));
  await settle();
  await click(
    [...document.querySelectorAll('[role="group"][aria-label="Show"] button')].find(
      (element) => element.textContent === "Shared with you",
    ),
  );
  await settle();
  assert.equal(location.search, "?show=shared");
  const browse = document.querySelector('button[aria-label="Browse, switch page"]');
  await click(browse);
  await settle();
  assert.equal(browse.getAttribute("aria-expanded"), "true");
  assert.ok(document.querySelector("dialog.page-picker[open]"));
  history.back();
  await settle();
  assert.equal(location.pathname + location.search, "/");
  assert.equal(browse.getAttribute("aria-expanded"), "false");
  assert.equal(markup("dialog.page-picker[open]"), null);
});

test("a Page created in this tab finds its place once it registers", async (t) => {
  cleanUp(t);
  globalThis.__editor = editorSurface;
  t.after(() => delete globalThis.__createPage);
  history.replaceState(null, "", "/pages");
  const draft = fakeSession(PLAN, "one", "Untitled", { draft: true });
  globalThis.__createPage = () => Promise.resolve(draft);
  const app = await boot(signedIn, {
    ...gatedCatalog({}),
    // read_page can't find a draft the host hasn't registered.
    read_page: () =>
      draft.localPage.registered
        ? {
            page_id: PLAN,
            project_id: PROJECT,
            parent_id: null,
            kind: "page",
            breadcrumbs: [{ kind: "project", project_id: PROJECT, title: "Launch" }],
          }
        : Response.json({ error: "Page not found", code: "page_not_found" }, { status: 404 }),
  });
  await settle();
  await click(button("New Page"));
  await settle();
  assert.equal(shownPagePath(), `/p/${PLAN}`);
  assert.ok(await until(() => pageAction("Move to…")), "Move to… is offered");
  assert.equal(toolCalls(app, "read_page"), 1, "asked once, and refused");
  assert.equal(markup(".breadcrumbs"), null);
  await click(pageAction("Move to…"));
  await settle();
  assert.match(document.body.textContent, /Wait for this Page to sync before moving it\./);
  assert.equal(toolCalls(app, "read_page"), 1, "Move to… doesn't ask for an unregistered draft");
  draft.rename("Untitled");
  await settle();
  assert.equal(toolCalls(app, "read_page"), 1, "nothing changed, so nothing is asked again");
  draft.register();
  await settle();
  assert.equal(toolCalls(app, "read_page"), 2, "asked again once it registered");
  assert.equal(
    (await until(() => document.querySelector(".breadcrumbs a")))?.textContent,
    "Launch",
    "the Page shows where it is",
  );
  assert.ok(pageAction("Move to…"));
});

test("a Page created in this tab is in the library when Back returns there", async (t) => {
  cleanUp(t);
  globalThis.__editor = editorSurface;
  t.after(() => delete globalThis.__createPage);
  history.replaceState(null, "", "/pages");
  const gate = {};
  await boot(signedIn, gatedCatalog(gate));
  await settle();
  assert.deepEqual(rows(), ["Roadmap"]);
  globalThis.__createPage = () => Promise.resolve(fakeSession(PLAN, "one", "Untitled"));
  await click(button("New Page"));
  await settle();
  assert.equal(shownPagePath(), `/p/${PLAN}`);
  Object.assign(gate, closed());
  history.back();
  await settle();
  assert.equal(location.pathname, "/pages");
  assert.deepEqual(rows(), [], "the remembered rows lack the new Page, so none paint");
  gate.release();
  await settle();
  assert.deepEqual(rows(), ["Roadmap"]);
});

test("a library answer for another account sets no quota and checks the session", async (t) => {
  cleanUp(t);
  const full = { limit: 10, count: 10, trash_count: 0 };
  const notice = () => document.querySelector(".quota-notice")?.textContent ?? null;
  for (const answeredBy of ["one", "bob"]) {
    history.replaceState(null, "", "/pages");
    const app = await boot(signedIn, {
      ...catalog,
      list_pages: {
        pages: [{ page_id: ROADMAP, title: "Roadmap" }],
        next_cursor: null,
        quota: full,
        principal: answeredBy,
      },
    });
    await settle();
    if (answeredBy === "one") {
      assert.match(notice() ?? "", /10 Pages of 10 Pages/, "this account's quota shows");
      assert.equal(sessionRequests(app), 1);
    } else {
      assert.equal(notice(), null, "Bob's quota is not this account's");
      assert.equal(sessionRequests(app), 2, "and the session is asked again");
    }
  }
});

test("closing the Browse picker aborts its walk, whose late 401 starts no recovery", async (t) => {
  cleanUp(t);
  history.replaceState(null, "", "/");
  const gate = {};
  const app = await boot(signedIn, {
    ...catalog,
    list_pages: async (args) => {
      // The library's first page answers; the picker's walk waits, then is
      // refused as signed out.
      if (args.limit !== 100)
        return {
          pages: [{ page_id: ROADMAP, title: "Roadmap" }],
          next_cursor: null,
          principal: "one",
        };
      await gate.promise;
      return Response.json({ error: "Sign in required", code: "unauthenticated" }, { status: 401 });
    },
  });
  await settle();
  const sessions = sessionRequests(app);
  const projects = toolCalls(app, "list_projects");
  Object.assign(gate, closed());
  await click(document.querySelector('button[aria-label="Browse, switch page"]'));
  await settle();
  assert.ok(document.querySelector("dialog.page-picker[open]"), "the walk is in flight");
  await click(document.querySelector('button[aria-label="Close Pages"]'));
  await settle();
  gate.release();
  await settle();
  assert.equal(sessionRequests(app), sessions, "the cancelled walk's 401 checks no session");
  assert.equal(toolCalls(app, "list_projects"), projects, "and asks for no Projects");
  assert.deepEqual(rows(), ["Roadmap"], "nothing was forgotten");
});

test("a list_projects answer for another account checks the session, and stops at the cap", async (t) => {
  cleanUp(t);
  history.replaceState(null, "", "/pages");
  // The session check keeps saying this account, while every list_projects
  // answers for Bob: each answer starts or rearms one bounded recovery.
  const app = await boot(signedIn, {
    ...catalog,
    list_projects: {
      projects: [{ project_id: PROJECT, title: "His", document_id: ROADMAP }],
      next_cursor: null,
      principal: "bob",
    },
  });
  for (let i = 0; i < 4; i++) await settle();
  const sessions = sessionRequests(app);
  const projects = toolCalls(app, "list_projects");
  assert.equal(sessions, 2 + RECOVERY_RERUNS, "the first check, then one recovery and its reruns");
  assert.equal(projects, 2 + RECOVERY_RERUNS, "the library's ask, then one per check");
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(sessionRequests(app), sessions, "and then it stops");
  assert.equal(toolCalls(app, "list_projects"), projects);
  const menu = document.querySelector('button[aria-haspopup="menu"][aria-label^="Project: "]');
  if (menu) {
    await click(menu);
    await settle();
  }
  const choices = [...document.querySelectorAll('[role="menuitemradio"] .library-menu-label')].map(
    (label) => label.textContent,
  );
  assert.equal(choices.includes("His"), false, `Bob's Projects never show: ${choices.join(", ")}`);
});

test("the Browse picker never repaints a walk past the age limit or after a 401", async (t) => {
  cleanUp(t);
  history.replaceState(null, "", "/");
  const gate = {};
  const walk = [
    { page_id: ROADMAP, title: "Roadmap" },
    { page_id: PLAN, title: "Their plan", shared: true },
  ];
  await boot(signedIn, {
    ...gatedCatalog(gate),
    list_pages: async (args) => {
      if (gate.promise) await gate.promise;
      if (gate.refuse)
        return Response.json(
          { error: "Sign in required", code: "unauthenticated" },
          { status: 401 },
        );
      // The library's first page holds Roadmap; the picker's walk finds both.
      return {
        pages: args.limit === 100 ? walk : walk.slice(0, 1),
        next_cursor: null,
        principal: "one",
      };
    },
  });
  await settle();
  const browse = document.querySelector('button[aria-label="Browse, switch page"]');
  const picked = () =>
    [...document.querySelectorAll("dialog.page-picker .picker-page span")].map(
      (span) => span.textContent,
    );
  const pickerStatus = () =>
    document.querySelector('dialog.page-picker [role="status"]')?.textContent ?? null;
  const reopen = async () => {
    await click(document.querySelector('button[aria-label="Close Pages"]'));
    await settle();
    Object.assign(gate, closed());
    await click(browse);
    await settle();
  };
  await click(browse);
  await settle();
  assert.deepEqual(picked(), ["Roadmap", "Their plan"]);

  // Six minutes on: nothing remembered is young enough to paint.
  const realNow = performance.now.bind(performance);
  t.mock.method(performance, "now", () => realNow() + 6 * 60_000);
  await reopen();
  assert.deepEqual(picked(), [], "no rows from the last walk");
  assert.equal(pickerStatus(), "Loading…");
  gate.release();
  await settle();
  assert.deepEqual(picked(), ["Roadmap", "Their plan"]);
  t.mock.restoreAll();

  // A tool call refused as signed out, while the picker is closed.
  await click(document.querySelector('button[aria-label="Close Pages"]'));
  await settle();
  delete gate.promise;
  gate.refuse = true;
  await click(
    [...document.querySelectorAll('[role="group"][aria-label="Show"] button')].find(
      (element) => element.textContent === "Your items",
    ),
  );
  await settle();
  gate.refuse = false;
  Object.assign(gate, closed());
  await click(browse);
  await settle();
  assert.deepEqual(picked(), [], "no rows from before the 401");
  assert.equal(pickerStatus(), "Loading…");
  gate.release();
  await settle();
});

test("leaving a Page the host deleted or stopped sharing forgets it", async (t) => {
  cleanUp(t);
  globalThis.__editor = editorSurface;
  history.replaceState(null, "", "/pages");
  const gate = {};
  await boot(signedIn, gatedCatalog(gate, { pages: ROADMAP_AND_PLAN }));
  await settle();
  const session = fakeSession(PLAN, "one", "Plan");
  globalThis.__openPage = () => Promise.resolve(session);
  await openRow("Plan");
  assert.ok(await until(() => pageAction("Copy link")), "the Page is open");
  // Its owner revoked this account's access: the session hides the Page.
  session.hidden = true;
  session.rename("Plan");
  await settle();
  Object.assign(gate, closed());
  history.back();
  await settle();
  assert.equal(location.pathname, "/pages");
  assert.deepEqual(rows(), ["Roadmap"], "the hidden Page doesn't paint from memory");
  gate.release();
  await settle();
});

test("a 401 with the Browse picker open stops, says why while signed in, and closes once signed out", async (t) => {
  cleanUp(t);
  for (const signsOut of [false, true]) {
    history.replaceState(null, "", "/");
    const server = { refuse: false, signedIn: true, refusals: 0 };
    // After 20 refusals the server answers 500 instead, which breaks a loop
    // so the count below fails the test rather than hanging the file.
    const refused = () =>
      ++server.refusals > 20
        ? Response.json({ error: "Stop", code: "internal" }, { status: 500 })
        : Response.json({ error: "Sign in required", code: "unauthenticated" }, { status: 401 });
    const app = await boot(
      () =>
        server.signedIn
          ? signedIn()
          : Response.json({ error: "Sign in required", code: "unauthenticated" }, { status: 401 }),
      {
        list_pages: () =>
          server.refuse
            ? refused()
            : {
                pages: [{ page_id: ROADMAP, title: "Roadmap" }],
                next_cursor: null,
                principal: "one",
              },
        list_projects: () =>
          server.refuse ? refused() : { projects: [], next_cursor: null, principal: "one" },
      },
    );
    await settle();
    // From here every tool call is refused as signed out; the session check
    // still says signed in, or says signed out too.
    server.refuse = true;
    server.signedIn = !signsOut;
    const from = app.requests.length;
    const browse = document.querySelector('button[aria-label="Browse, switch page"]');
    await click(browse);
    // Two seconds of real time: a loop would make hundreds of requests.
    for (let i = 0; i < 20; i++) await settle();
    const made = listings(app.requests, from);
    const label = signsOut ? "signed out" : "signed in";
    // The walk's 401 starts one recovery. Each of its list_projects is
    // refused too, which reruns it up to the cap and then stops.
    assert.ok(made.list_pages <= 2, `${label}: ${made.list_pages} list_pages`);
    assert.ok(
      made.list_projects <= 1 + RECOVERY_RERUNS,
      `${label}: ${made.list_projects} list_projects`,
    );
    if (signsOut) {
      assert.equal(markup("dialog.page-picker[open]"), null, `${label}: closed`);
      assert.equal(document.querySelector("h1")?.textContent, "A place to write together.");
    } else {
      // Still signed in: the picker stays open, lists nothing and says why.
      assert.ok(document.querySelector("dialog.page-picker[open]"), `${label}: open`);
      assert.equal(
        document.querySelector("dialog.page-picker .picker-error")?.textContent,
        SIGNED_OUT_MESSAGE,
      );
      assert.equal(document.querySelectorAll("dialog.page-picker .picker-page").length, 0);
      await click(document.querySelector('button[aria-label="Close Pages"]'));
      await settle();
    }
  }
});

test("a Browse walk answered for another account says to retry once the session is the same", async (t) => {
  cleanUp(t);
  history.replaceState(null, "", "/");
  // The library's own first page answers for this account; every walk of the
  // picker answers for Bob, while the session check keeps saying this account.
  const app = await boot(signedIn, {
    ...catalog,
    list_pages: (args) => ({
      pages: [{ page_id: ROADMAP, title: args.limit === 100 ? "Bob's" : "Roadmap" }],
      next_cursor: null,
      principal: args.limit === 100 ? "bob" : "one",
    }),
  });
  await settle();
  const from = app.requests.length;
  const sessions = sessionRequests(app);
  await click(document.querySelector('button[aria-label="Browse, switch page"]'));
  for (let i = 0; i < 6; i++) await settle();
  const error = () => document.querySelector("dialog.page-picker .picker-error")?.textContent;
  assert.ok(markup("dialog.page-picker[open]"), "the picker stays open");
  assert.equal(error(), SAME_ACCOUNT_MESSAGE);
  assert.equal(document.querySelectorAll("dialog.page-picker .picker-page").length, 0);
  assert.equal(listings(app.requests, from).list_pages, 1, "one walk, and no other");
  assert.ok(sessionRequests(app) > sessions, "the session was checked");
  // Reopening is the retry: one more walk.
  await click(document.querySelector('button[aria-label="Close Pages"]'));
  await settle();
  await click(document.querySelector('button[aria-label="Browse, switch page"]'));
  for (let i = 0; i < 6; i++) await settle();
  assert.equal(listings(app.requests, from).list_pages, 2);
  assert.equal(error(), SAME_ACCOUNT_MESSAGE);
  await click(document.querySelector('button[aria-label="Close Pages"]'));
  await settle();
});

test("a Browse walk's session check that answers counts, even when the Projects request after it fails", async (t) => {
  cleanUp(t);
  history.replaceState(null, "", "/");
  // The session keeps saying this account. Once the picker opens, every
  // list_projects fails on the server.
  const server = { projectsFail: false };
  const app = await boot(signedIn, {
    ...catalog,
    list_pages: (args) => ({
      pages: [{ page_id: ROADMAP, title: args.limit === 100 ? "Bob's" : "Roadmap" }],
      next_cursor: null,
      principal: args.limit === 100 ? "bob" : "one",
    }),
    list_projects: () =>
      server.projectsFail
        ? Response.json({ error: "Service unavailable" }, { status: 500 })
        : { projects: [], next_cursor: null, principal: "one" },
  });
  await settle();
  server.projectsFail = true;
  const from = app.requests.length;
  await click(document.querySelector('button[aria-label="Browse, switch page"]'));
  for (let i = 0; i < 6; i++) await settle();
  assert.ok(listings(app.requests, from).list_projects >= 1, "the check asked for the Projects");
  assert.equal(
    document.querySelector("dialog.page-picker .picker-error")?.textContent,
    SAME_ACCOUNT_MESSAGE,
  );
  await click(document.querySelector('button[aria-label="Close Pages"]'));
  await settle();
});

test("a Browse walk answered for another account says so when the session check fails", async (t) => {
  cleanUp(t);
  history.replaceState(null, "", "/");
  // The first session check answers; every later one fails on the server.
  let sessions = 0;
  const session = () =>
    sessions++ === 0
      ? signedIn()
      : Response.json({ error: "Service unavailable" }, { status: 500 });
  const app = await boot(session, {
    ...catalog,
    list_pages: (args) => ({
      pages: [{ page_id: ROADMAP, title: args.limit === 100 ? "Bob's" : "Roadmap" }],
      next_cursor: null,
      principal: args.limit === 100 ? "bob" : "one",
    }),
  });
  await settle();
  const from = app.requests.length;
  await click(document.querySelector('button[aria-label="Browse, switch page"]'));
  for (let i = 0; i < 6; i++) await settle();
  const error = () => document.querySelector("dialog.page-picker .picker-error")?.textContent;
  assert.ok(markup("dialog.page-picker[open]"), "the picker stays open");
  assert.equal(error(), CHECK_FAILED_MESSAGE, "it never claims the account is the same");
  assert.equal(document.querySelectorAll("dialog.page-picker .picker-page").length, 0);
  assert.equal(listings(app.requests, from).list_pages, 1, "one walk, and no other");
  assert.ok(sessions > 1, "the session was checked");
  await click(document.querySelector('button[aria-label="Close Pages"]'));
  await settle();
});

test("a 401 during recovery still ends with the account's Projects shown", async (t) => {
  cleanUp(t);
  history.replaceState(null, "", "/pages");
  const server = { refusePages: false, projectRefusals: 0 };
  const refused = () =>
    Response.json({ error: "Sign in required", code: "unauthenticated" }, { status: 401 });
  const app = await boot(signedIn, {
    list_pages: () =>
      server.refusePages
        ? refused()
        : { pages: [{ page_id: ROADMAP, title: "Roadmap" }], next_cursor: null, principal: "one" },
    // Recovery's own list_projects is refused once, which resets the list
    // under it; the rearmed recovery asks again.
    list_projects: () =>
      server.projectRefusals-- > 0
        ? refused()
        : {
            projects: [{ project_id: PROJECT, title: "Launch", document_id: ROADMAP }],
            next_cursor: null,
            principal: "one",
          },
  });
  await settle();
  await leaveForPage(PLAN);
  server.refusePages = true;
  // Back's own list_projects and recovery's first one are refused.
  server.projectRefusals = 2;
  const projects = toolCalls(app, "list_projects");
  history.back();
  await settle();
  await settle();
  assert.equal(toolCalls(app, "list_projects"), projects + 3, "Back, recovery, and its rerun");
  const menu = await until(() =>
    document.querySelector('button[aria-haspopup="menu"][aria-label^="Project: "]'),
  );
  await click(menu);
  await settle();
  const choices = [...document.querySelectorAll('[role="menuitemradio"] .library-menu-label')].map(
    (label) => label.textContent,
  );
  assert.ok(choices.includes("Launch"), `the Projects show: ${choices.join(", ")}`);
});

test("Move to… opens nothing if the account changed while read_page was asked", async (t) => {
  cleanUp(t);
  globalThis.__editor = editorSurface;
  const who = { current: "one" };
  history.replaceState(null, "", "/pages");
  const placed = deferredAnswer();
  let asks = 0;
  await boot(accountSession(who), {
    ...gatedCatalog({}, { who, pages: ROADMAP_AND_PLAN }),
    // The open's own ask is refused, so only Move to…'s ask can place it.
    read_page: () =>
      ++asks === 1
        ? Response.json({ error: "Page not found", code: "page_not_found" }, { status: 404 })
        : placed.promise,
  });
  await settle();
  globalThis.__openPage = (id) => Promise.resolve(fakeSession(id, "one", "Plan"));
  await openRow("Plan");
  await click(await until(() => pageAction("Move to…")));
  assert.equal(asks, 2, "Move to… asked read_page");
  // Move to… waits on read_page; meanwhile another window signs in as Bob.
  who.current = "bob";
  await sessionCheck();
  // Plain timers, not act(): an opened dialog's loads must not be able to
  // hold this test past its assertion.
  placed.resolve({
    page_id: PLAN,
    project_id: PROJECT,
    kind: "page",
    breadcrumbs: [{ kind: "project", project_id: PROJECT, title: "Launch" }],
  });
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const dialog = markup(".move-dialog");
  // A dialog opened by mistake is closed first, so its loads can't keep the
  // file running past the failure.
  if (dialog) await click(document.querySelector(`.move-dialog button[aria-label^="Close"]`));
  assert.equal(dialog, null, "no dialog for Bob");
  assert.match(document.body.textContent, /Sign in with this Page's original account to move it\./);
  assert.equal(markup(".breadcrumbs"), null, "nor the answer's location");
});
