// A hidden Page tab parks its sync socket, against the running local fixture.
//
// Two browsers on one Page. The second one's tab is hidden through an init
// script that owns document.visibilityState, and its clock is Playwright's
// fake clock, so the five-minute countdown (PARK_AFTER_MS) passes in one
// step without shortening it:
// - hidden with every edit acknowledged, its socket closes and the host stops
//   listing it as a participant;
// - an edit from the first browser while it's parked shows once it's
//   visible again, over a new socket, with no banner and no
//   Offline/Reconnecting status;
// - hidden with an edit the host hasn't acknowledged (its receipts held), the
//   socket stays open until the receipt goes through, then closes.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-hidden-tab";
await mkdir(output, { recursive: true });

// viewer/reconnect-machine.mjs PARK_AFTER_MS, which the fake clock steps over.
const PARK_AFTER_MS = 5 * 60_000;
const SAVED = "**/api/saved?**";

const browser = await chromium.launch({ headless: true });
const report = { origin, completed: [], errors: [] };
let pageId;
let a;

const complete = (name) => {
  report.completed.push(name);
  console.log("PASS " + name);
};
const content = (page) => page.locator(".page-block wg-content").first();
const saved = (page) =>
  expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({
    timeout: 30000,
  });

// Owns visibility, and records each sync socket and every banner and status
// text the tab shows, however briefly.
const instrument = () => {
  let visibility = "visible";
  Object.defineProperty(Document.prototype, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  Object.defineProperty(Document.prototype, "hidden", {
    configurable: true,
    get: () => visibility === "hidden",
  });
  window.__pagesSetVisibility = (next) => {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  const Native = window.WebSocket;
  window.__pagesSockets = [];
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      if (!String(args[0]).includes("/api/sync?")) return;
      const record = { open: true };
      window.__pagesSockets.push(record);
      this.addEventListener("close", ({ code }) => {
        record.open = false;
        record.code = code;
      });
    }
  };
  window.__pagesSeen = { alerts: [], statuses: [] };
  const seen = new WeakMap();
  const scan = () => {
    for (const [selector, list] of [
      [".error[role=alert]", window.__pagesSeen.alerts],
      ["[role=status]", window.__pagesSeen.statuses],
    ])
      for (const element of document.querySelectorAll(selector)) {
        const text = element.textContent;
        if (seen.get(element) === text) continue;
        seen.set(element, text);
        list.push(text);
      }
  };
  new MutationObserver(scan).observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
  });
};
const sockets = (page) => page.evaluate(() => window.__pagesSockets);
const openSockets = async (page) => (await sockets(page)).filter((socket) => socket.open).length;
const seen = (page) => page.evaluate(() => window.__pagesSeen);
const clearSeen = (page) =>
  page.evaluate(() => {
    window.__pagesSeen.alerts.length = 0;
    window.__pagesSeen.statuses.length = 0;
  });
const setVisibility = (page, state) =>
  page.evaluate((state) => window.__pagesSetVisibility(state), state);

async function signedIn(label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(15000);
  await context.addInitScript(instrument);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${label}: ${error.message.slice(0, 500)}`));
  await page.goto(origin + "/api/auth/login", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 20000,
  });
  return { context, page };
}

async function call(page, operation, args = {}) {
  return page.evaluate(
    async ({ operation, args }) => {
      const response = await fetch("/mcp", {
        credentials: "same-origin",
        signal: AbortSignal.timeout(10000),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Pages-Driver": "Hidden tab QA",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: { name: operation, arguments: args },
        }),
      });
      if (!response.ok) throw Error(`${operation}: HTTP ${response.status}`);
      const envelope = await response.json();
      if (envelope.error) throw Error(`${operation}: JSON-RPC error ${envelope.error.code}`);
      const result = envelope.result;
      const text = result?.content?.find((entry) => entry.type === "text")?.text;
      if (typeof text !== "string") throw Error(`${operation}: missing MCP text result`);
      const data = JSON.parse(text);
      if (result.isError) throw Error(`${operation}: tool error ${data.code ?? "unspecified"}`);
      return data;
    },
    { operation, args },
  );
}
async function mutate(page, operation, args = {}) {
  const catalog = ["create_page", "delete_page"].includes(operation);
  const authority = await call(
    page,
    catalog ? "list_pages" : "read_page",
    catalog ? {} : { page_id: args.page_id },
  );
  return call(page, operation, {
    ...args,
    revision:
      operation === "delete_page"
        ? (await call(page, "read_page", { page_id: args.page_id })).revision
        : authority.revision,
    nonce: crypto.randomUUID(),
  });
}
// The browsers the Page's host holds a socket from.
const participants = async () =>
  (await call(a, "read_page_presence", { page_id: pageId })).participants.length;

/** Hold every matching request until `release()`, which lets them through. */
async function hold(context, pattern) {
  const routes = [];
  const handler = (route) => routes.push(route);
  await context.route(pattern, handler);
  return {
    held: () => routes.length,
    async release() {
      await context.unroute(pattern, handler);
      for (const route of routes) await route.continue().catch(() => {});
    },
  };
}

async function type(page, text) {
  await content(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
  await expect(content(page)).toContainText(text.trim());
}

try {
  ({ page: a } = await signedIn("visible"));
  const created = await mutate(a, "create_page", {
    title: "Hidden tab QA",
    markdown: "A Page one tab watches while another hides.",
  });
  pageId = created.page_id;
  await a.goto(`${origin}/p/${pageId}`);
  await expect(content(a)).toContainText("another hides");
  await saved(a);

  // Hidden with every edit acknowledged: the socket parks.
  {
    const { context, page: b } = await signedIn("hidden");
    await context.clock.install();
    await b.goto(`${origin}/p/${pageId}`);
    await expect(content(b)).toContainText("another hides");
    await saved(b);
    await expect.poll(() => openSockets(b)).toBe(1);
    await expect.poll(participants, { timeout: 15000 }).toBe(2);
    // A caret at the start of the body, away from where the edit lands.
    await content(b).click();
    await b.keyboard.press("Home");
    const caret = () =>
      b.evaluate(() => {
        const body = document.querySelector(".page-block wg-content");
        const selection = window.getSelection();
        if (!body || !selection?.anchorNode || !body.contains(selection.anchorNode))
          return { inBody: false };
        // The caret as a character position in the body's text, which a
        // re-rendered text node doesn't change.
        const range = document.createRange();
        range.setStart(body, 0);
        range.setEnd(selection.anchorNode, selection.anchorOffset);
        return {
          inBody: true,
          position: range.toString().replace(/​/g, "").length,
          collapsed: selection.isCollapsed,
        };
      });
    const before = await caret();
    assert.equal(before.inBody, true, "the caret starts in the body");
    const scroll = await b.evaluate(() => window.scrollY);

    await setVisibility(b, "hidden");
    await context.clock.fastForward(PARK_AFTER_MS - 10_000);
    await b.waitForTimeout(500);
    assert.equal(await openSockets(b), 1, "under five minutes the socket stays open");
    await context.clock.fastForward(10_000);
    await expect.poll(() => openSockets(b), { timeout: 10000 }).toBe(0);
    await expect.poll(participants, { timeout: 15000 }).toBe(1);
    complete("a tab hidden five minutes with everything saved closes its socket");

    // More hidden time opens nothing.
    await context.clock.fastForward(PARK_AFTER_MS);
    await b.waitForTimeout(1000);
    assert.equal((await sockets(b)).length, 1, "a parked tab doesn't reconnect while hidden");
    complete("a parked tab stays closed while hidden");

    await type(a, " Written while the other tab was hidden.");
    await saved(a);
    await clearSeen(b);
    await setVisibility(b, "visible");
    await expect(content(b)).toContainText("Written while the other tab was hidden.", {
      timeout: 15000,
    });
    await expect.poll(() => openSockets(b)).toBe(1);
    await expect.poll(participants, { timeout: 15000 }).toBe(2);
    await saved(b);
    const after = await seen(b);
    await b.screenshot({ path: `${output}/shown-again.png` });
    assert.deepEqual(after.alerts, [], "no banner on return");
    assert.equal(
      after.statuses.filter((text) => /Offline|Reconnecting|Not saved|Saved locally/.test(text))
        .length,
      0,
      `no fault status on return (statuses: ${JSON.stringify(after.statuses)})`,
    );
    assert.equal(await b.evaluate(() => window.scrollY), scroll, "scroll position kept");
    assert.deepEqual(await caret(), before, "selection kept");
    complete("shown again, it reconnects and shows the other tab's edit with no error");
    await context.close();
  }

  // Hidden with an edit the host hasn't acknowledged: the socket stays.
  {
    const { context, page: b } = await signedIn("unsaved");
    await context.clock.install();
    await b.goto(`${origin}/p/${pageId}`);
    await expect(content(b)).toContainText("another hides");
    await saved(b);
    const receipts = await hold(context, SAVED);
    await type(b, " Typed just before hiding.");
    await expect.poll(receipts.held, { timeout: 10000 }).toBeGreaterThan(0);
    await setVisibility(b, "hidden");
    await context.clock.fastForward(PARK_AFTER_MS + 10_000);
    await b.waitForTimeout(1000);
    assert.equal(await openSockets(b), 1, "an unacknowledged edit keeps the socket open");
    complete("a hidden tab with an unacknowledged edit stays connected");

    await receipts.release();
    // A receipt that timed out under the held route retries on the backoff.
    for (let i = 0; i < 10 && (await openSockets(b)) > 0; i++) {
      await context.clock.fastForward(2_000);
      await b.waitForTimeout(300);
    }
    await expect.poll(() => openSockets(b), { timeout: 10000 }).toBe(0);
    const text = (await call(a, "read_page", { page_id: pageId })).blocks
      .map((block) => block.markdown)
      .join("\n");
    assert.ok(text.includes("Typed just before hiding."), "the host has the edit");
    complete("once the host acknowledges the edit, the hidden tab parks");
    await context.close();
  }
  assert.deepEqual(report.errors, []);
} finally {
  if (pageId && a) {
    try {
      await mutate(a, "delete_page", { page_id: pageId });
      report.fixtureDeleted = true;
    } catch (error) {
      report.cleanupError = error.message;
    }
  }
  await writeFile(`${output}/hidden-tab-report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(`PASS hidden tab. Artifacts: ${output}`);
