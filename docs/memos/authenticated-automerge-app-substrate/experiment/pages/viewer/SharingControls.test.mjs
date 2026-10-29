import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

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
  location: dom.window.location,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  dom.window.close();
  for (const [key, descriptor] of saved)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
});
const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./SharingControls.jsx", import.meta.url))],
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
        build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "empty" }));
      },
    },
  ],
});
const { SharingControls } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);
const { createElement, act, StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");
const session = (pageId = "page-a", principal = "account-a") => ({
  pageId,
  identity: { principal },
  canManageAccess: true,
  access: { canRead: true, role: "owner", revision: 1 },
});
const ledger = (revision = 1, principal = "account-a") => ({
  owner: { principal, displayName: `${principal} owner` },
  access: { canManageAccess: true, revision },
  members: [],
  invites: [],
});
const json = (body, status = 200) => Response.json(body, { status });
function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function fixture(t, fetch, { current = session(), strict = false } = {}) {
  globalThis.fetch = fetch;
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let props = { session: current };
  const render = () =>
    root.render(
      strict
        ? createElement(StrictMode, null, createElement(SharingControls, props))
        : createElement(SharingControls, props),
    );
  await act(render);
  t.after(async () => {
    await act(() => root.unmount());
    container.remove();
  });
  return {
    container,
    current,
    async render(next = current) {
      props = { session: next };
      await act(render);
    },
    async toggle() {
      await act(() => container.querySelector('button[aria-haspopup="dialog"]').click());
    },
    async submit() {
      await act(() =>
        container
          .querySelector("form")
          .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })),
      );
    },
    async typeEmail(value) {
      await act(() => {
        const input = container.querySelector('input[type="email"]');
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(
          input,
          value,
        );
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    },
    async settle(response, value) {
      await act(async () => {
        response.resolve(value);
        await response.promise;
      });
    },
  };
}

test("preloads on mount and opens repeatedly without blanking or fetching again", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return json(ledger());
  });
  assert.equal(calls, 1);
  assert.equal(f.container.querySelector('[role="dialog"]'), null);
  for (let i = 0; i < 3; i++) {
    await f.toggle();
    assert.match(f.container.textContent, /account-a owner/);
    assert.doesNotMatch(f.container.textContent, /Loading/);
    await f.toggle();
  }
  assert.equal(calls, 1);
});

test("known owner can compose while preloading, but cannot submit without the server revision", async (t) => {
  const response = deferred();
  let calls = 0;
  const f = await fixture(t, () => {
    calls++;
    return response.promise;
  });
  await f.toggle();
  assert.ok(f.container.querySelector('input[type="email"]'));
  assert.equal(f.container.querySelector('button[type="submit"]').disabled, true);
  assert.doesNotMatch(f.container.textContent, /Only the owner/);
  await f.submit();
  assert.equal(calls, 1);
  await f.settle(response, json(ledger()));
  assert.match(f.container.textContent, /account-a owner/);
});

test("temporary preload failure preserves the owner's visible invite draft through retry", async (t) => {
  const preload = deferred(),
    retry = deferred();
  let calls = 0;
  const f = await fixture(t, () => (++calls === 1 ? preload.promise : retry.promise));
  await f.toggle();
  await f.typeEmail("colleague@example.com");
  await f.settle(preload, json({ error: "Sharing is temporarily unavailable" }, 503));
  assert.equal(f.container.querySelector('input[type="email"]').value, "colleague@example.com");
  assert.match(f.container.textContent, /Invite by email, then share the link/);
  assert.doesNotMatch(f.container.textContent, /Only the owner/);
  assert.match(f.container.querySelector('[role="alert"]').textContent, /temporarily unavailable/);
  assert.equal(f.container.querySelector('button[type="submit"]').disabled, true);
  await f.submit();
  assert.equal(calls, 1);
  const button = [...f.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry sharing settings",
  );
  await act(() => button.click());
  assert.equal(f.container.querySelector('input[type="email"]').value, "colleague@example.com");
  assert.equal(f.container.querySelector('button[type="submit"]').disabled, true);
  await f.settle(retry, json(ledger()));
  assert.equal(f.container.querySelector('input[type="email"]').value, "colleague@example.com");
  assert.equal(f.container.querySelector('button[type="submit"]').disabled, false);
  assert.equal(f.container.querySelector('[role="alert"]'), null);
  assert.equal(calls, 2);
});

test("a write completing while closed updates the cache and keeps busy on reopen", async (t) => {
  const response = deferred();
  let gets = 0,
    posts = 0;
  const f = await fixture(t, (_url, options) => {
    if (options.method === "POST") {
      posts++;
      return response.promise;
    }
    gets++;
    return Promise.resolve(json(ledger()));
  });
  await f.toggle();
  await f.submit();
  await f.toggle();
  await f.toggle();
  assert.equal(f.container.querySelector('button[type="submit"]').disabled, true);
  await f.submit();
  assert.equal(posts, 1);
  const updated = ledger(2);
  updated.invites = [{ id: "invite", email: "colleague@example.com", role: "viewer" }];
  await f.toggle();
  await f.settle(response, json(updated));
  await f.toggle();
  assert.match(f.container.textContent, /colleague@example.com/);
  assert.equal(gets, 1);
});

test("account/Page switch never renders the previous private ledger or its delayed response", async (t) => {
  const delayed = deferred();
  const f = await fixture(t, (url) =>
    url.endsWith("page-a") ? delayed.promise : Promise.resolve(json(ledger(2, "account-b"))),
  );
  await f.toggle();
  await f.render(session("page-b", "account-b"));
  assert.equal(f.container.querySelector('[role="dialog"]'), null);
  await f.toggle();
  await f.settle(delayed, json(ledger()));
  assert.match(f.container.textContent, /account-b owner/);
  assert.doesNotMatch(f.container.textContent, /account-a owner/);
});

test("session access loss clears cached rows and restoration preloads again", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return json(ledger());
  });
  await f.toggle();
  f.current.authRequired = true;
  await f.render();
  assert.doesNotMatch(f.container.textContent, /account-a owner/);
  assert.equal(f.container.querySelector("form"), null);
  f.current.authRequired = false;
  await f.render();
  assert.match(f.container.textContent, /account-a owner/);
  assert.equal(calls, 2);
});

test("an access error exposes retry without cached owner controls", async (t) => {
  let failure = true;
  const f = await fixture(t, async () =>
    failure ? json({ error: "Sharing access was removed" }, 403) : json(ledger()),
  );
  await f.toggle();
  assert.match(f.container.textContent, /Sharing access was removed/);
  assert.equal(f.container.querySelector("form"), null);
  failure = false;
  const retry = [...f.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry sharing settings",
  );
  await act(() => retry.click());
  assert.match(f.container.textContent, /account-a owner/);
});

test("StrictMode effect restart can still preload sharing", async (t) => {
  const f = await fixture(t, async () => json(ledger()), { strict: true });
  await f.toggle();
  assert.match(f.container.textContent, /account-a owner/);
  assert.doesNotMatch(f.container.textContent, /Loading/);
});
