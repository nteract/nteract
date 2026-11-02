// main.jsx's real session startup, mounted in jsdom: the shell, browser
// session maintenance and the banner region, with only the network and the
// editor chunk replaced.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { SERVER_UNREACHABLE_ACTION } from "./alerts.mjs";
import { PRODUCT_NAME } from "../shared/product.mjs";

const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
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
            "export const PageSession = { open: (id) => globalThis.__openPage ? globalThis.__openPage(id) : Promise.reject(new Error('No Page in this fixture')) };",
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
const { act } = await import("react");

/** Mount main.jsx once, with `session` answering /api/auth/session and
 * `tools` answering /api/tools operations. `connect` answers /api/connect,
 * and `head` runs where theme.js would, before the app script. */
async function boot(session, tools = {}, { connect, head } = {}) {
  document.body.innerHTML = '<div id="root"></div>';
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(url, "http://localhost/").pathname;
    requests.push(path);
    if (path === "/api/auth/session") return session();
    if (path === "/api/connect" && connect) return connect();
    if (path === "/api/tools") {
      const { operation } = JSON.parse(init.body);
      requests.push(operation);
      if (tools[operation]) return Response.json(tools[operation]);
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
  list_pages: { pages: [], next_cursor: null },
  list_projects: { projects: [], next_cursor: null },
};
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
};

test("/pages and /projects render from the shell without importing the editor", async () => {
  for (const [path, heading] of [
    ["/pages", "All Pages"],
    ["/projects/", "Projects"],
  ]) {
    history.replaceState(null, "", path);
    const before = globalThis.__editorImports ?? 0;
    const app = await boot(signedIn, catalog);
    await settle();
    assert.equal(document.querySelector("main h1")?.textContent, heading, path);
    assert.ok(app.requests.includes("list_pages"), path);
    assert.equal(globalThis.__editorImports ?? 0, before, `${path} imported the editor`);
    assert.deepEqual(app.banners(), []);
  }
  assert.equal(location.pathname, "/projects", "the trailing slash is dropped");
});

test("Home starts the editor import at boot", async () => {
  history.replaceState(null, "", "/");
  const before = globalThis.__editorImports ?? 0;
  await boot(signedIn, catalog);
  await settle();
  assert.equal(document.querySelector("main h1")?.textContent, "Your pages");
  assert.equal(globalThis.__editorImports, before + 1);
  const nav = [...document.querySelectorAll(".index-nav a")].map((link) => link.textContent);
  assert.deepEqual(nav, ["Home", "All Pages", "Projects"]);
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
    assert.equal(location.pathname + location.search, `/p/${pageId}`);
    assert.ok(document.querySelector(".build-update[role=alert]"), "the reload banner shows");
    // The listing behind the banner kept the search that was typed.
    assert.equal(document.querySelector("main h1")?.textContent, "All Pages");
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
  assert.equal(location.pathname, `/p/${PREVIEW_PAGE}`);
  assert.equal(document.querySelector('[role="status"]')?.textContent, "Opening…");
  assert.equal(showing(), false);
});
