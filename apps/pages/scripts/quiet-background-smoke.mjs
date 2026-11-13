// Background checks that time out, against the running local fixture.
//
// The browser's clock is Playwright's fake clock, so the session renewal
// (RENEW_MS) and the request deadline (REQUEST_TIMEOUT_MS) pass in a few
// steps without shortening either. A route holds /api/auth/session past its
// deadline:
// - on an open Page, the renewal times out with no banner, the Page still
//   saves an edit, and once released the next renewal is answered;
// - on a first load, nothing else is on screen, so the timed-out session
//   check still says so.
// It also records which code asked for each /api/auth/session request on a
// reload of an open Page (report.reloadSessionRequests).
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-quiet-background";
await mkdir(output, { recursive: true });

// viewer/session-refresh-machine.mjs RENEW_MS and viewer/request.mjs
// REQUEST_TIMEOUT_MS, which the fake clock steps through.
const RENEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const TIMED_OUT = "The request timed out. Please try again.";
const SESSION = "**/api/auth/session";

const browser = await chromium.launch({ headless: true });
const report = { origin, completed: [], errors: [] };
const contexts = [];
let pageId;
let admin;

const complete = (name) => {
  report.completed.push(name);
  console.log("PASS " + name);
};
const alerts = (page) => page.getByRole("alert");
const saved = (page) =>
  expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({
    timeout: 30000,
  });
const content = (page) => page.locator(".page-block wg-content").first();

async function signedIn(label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  contexts.push(context);
  context.setDefaultTimeout(15000);
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
          "X-Pages-Driver": "Quiet background QA",
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
/** A write with retry authority: the catalog's for catalog writes, the Page's
 * otherwise. Each call is a new request with its own key. */
async function mutate(page, operation, args = {}) {
  const catalog = ["create_page", "delete_page"].includes(operation);
  const authority = await call(
    page,
    catalog ? "list_pages" : "read_page",
    catalog ? {} : { page_id: args.page_id },
  );
  return call(page, operation, {
    ...args,
    retry_token: authority.retry_token,
    idempotency_key: authority.retry_key_prefix + crypto.randomUUID(),
  });
}

/** Hold every matching request until `release()`; `held()` counts them. */
async function hold(context, pattern) {
  const routes = [];
  const handler = (route) => routes.push(route);
  await context.route(pattern, handler);
  return {
    held: () => routes.length,
    async release() {
      await context.unroute(pattern, handler);
      // A held request the page already gave up on can't be continued.
      for (const route of routes) await route.abort().catch(() => {});
    },
  };
}

try {
  ({ page: admin } = await signedIn("admin"));
  const created = await mutate(admin, "create_page", {
    title: "Quiet background QA",
    markdown: "A Page that stays open while its session renews.",
  });
  pageId = created.page_id;

  // Which caller asks for /api/auth/session on a reload of a Page this tab
  // already holds a copy of.
  {
    const { context, page } = await signedIn("reload");
    await page.goto(`${origin}/p/${pageId}`);
    await expect(content(page)).toContainText("stays open");
    await saved(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    const requests = [];
    cdp.on("Network.requestWillBeSent", ({ request, initiator, timestamp }) => {
      if (!new URL(request.url).pathname.startsWith("/api/auth/session")) return;
      const frames = [];
      for (let stack = initiator.stack; stack; stack = stack.parent)
        for (const frame of stack.callFrames)
          frames.push(
            `${frame.functionName || "(anonymous)"} ${new URL(frame.url, origin).pathname}:${frame.lineNumber + 1}`,
          );
      requests.push({ timestamp, type: initiator.type, frames: frames.slice(0, 12) });
    });
    await page.reload();
    await expect(content(page)).toContainText("stays open");
    await saved(page);
    report.reloadSessionRequests = requests;
    console.log(`reload: ${requests.length} /api/auth/session request(s)`);
    await context.close();
  }

  // A renewal held past its deadline on an open Page.
  {
    const { context, page } = await signedIn("renewal");
    await context.clock.install();
    await page.goto(`${origin}/p/${pageId}`);
    await expect(content(page)).toContainText("stays open");
    await saved(page);
    const session = await hold(context, SESSION);
    await context.clock.fastForward(RENEW_MS);
    await expect.poll(session.held, { timeout: 10000 }).toBeGreaterThan(0);
    await context.clock.fastForward(REQUEST_TIMEOUT_MS);
    // The viewer handles the deadline in a microtask after the timer; give
    // a banner time to render before checking it isn't there.
    await page.waitForTimeout(1500);
    report.renewalAlerts = await alerts(page).allTextContents();
    await page.screenshot({ path: `${output}/renewal-timed-out.png` });
    assert.equal(
      report.renewalAlerts.filter((text) => text.includes(TIMED_OUT)).length,
      0,
      `a renewal that timed out shows no banner (alerts: ${JSON.stringify(report.renewalAlerts)})`,
    );
    complete("a session renewal that times out shows nothing");

    await content(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Edited while the renewal was held.");
    await expect(content(page)).toContainText("Edited while the renewal was held.");
    await saved(page);
    assert.equal((await alerts(page).allTextContents()).length, 0, "no banner after the edit");
    complete("the Page keeps saving an edit while its renewal is held");

    await session.release();
    const answered = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/auth/session" && response.status() === 200,
      { timeout: 15000 },
    );
    await context.clock.fastForward(RENEW_MS);
    await answered;
    await page.waitForTimeout(500);
    assert.equal((await alerts(page).allTextContents()).length, 0, "no banner after renewal");
    complete("released, the next renewal is answered");
    await context.close();
  }

  // The first session check on a load has nothing else on screen: it still
  // reports its timeout.
  {
    const { context, page } = await signedIn("first-check");
    await context.clock.install();
    const session = await hold(context, SESSION);
    await page.goto(origin + "/");
    await expect.poll(session.held, { timeout: 10000 }).toBeGreaterThan(0);
    await context.clock.fastForward(REQUEST_TIMEOUT_MS);
    await expect(alerts(page).filter({ hasText: TIMED_OUT })).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: `${output}/first-check-timed-out.png` });
    complete("a first session check that times out still says so");
    await session.release();
    await context.close();
  }
  assert.deepEqual(report.errors, []);
} finally {
  if (pageId && admin) {
    try {
      await mutate(admin, "delete_page", { page_id: pageId });
      report.fixtureDeleted = true;
    } catch (error) {
      report.cleanupError = error.message;
    }
  }
  await writeFile(`${output}/quiet-background-report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(`PASS quiet background. Artifacts: ${output}`);
