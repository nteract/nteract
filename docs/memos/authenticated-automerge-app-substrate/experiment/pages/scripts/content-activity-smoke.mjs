// Content activity on a real local host. One Page is edited over MCP and
// another by typing in a browser tab, each a few seconds after creation, once
// the request that opened its document has responded: celld drops work
// started in that request's context, and the repository's change events run
// there. list_pages must then report when each Page's content changed.
//
// Each Page is then edited a second time inside its one-minute window, so its
// trailing flush runs at the window's end: after a second MCP edit for the
// agent Page, and for the tab, after its socket closed mid-window. Both Pages
// run at once, so the window costs the suite one minute.
//
// This covers those paths end to end; it doesn't pin how the window's timer
// stays alive. On a local celld the trailing flush still lands with
// ContentActivity's hold on the arming request removed, so the unit test "a
// change observed outside a live request waits for one to run its effects"
// (worker/content-activity.test.mjs) is what pins that hold.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
assert.equal(new URL(origin).protocol, "http:");
const keyFile = process.env.PAGES_E2E_KEY_FILE;
assert.ok(keyFile, "Run through local-sharing-e2e.mjs --content-activity for fixture API keys");
const keys = JSON.parse(await readFile(keyFile, "utf8"));
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-content-activity";
await mkdir(output, { recursive: true });
const report = { completed: [], errors: [] };
const complete = (name) => {
  report.completed.push(name);
  console.log(`[Content activity E2E] ${name}`);
};
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// Longer than the creation request's own held work (its title projection and
// the record store's 1 s persistence timer).
const SETTLE_MS = 3000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mcp(operation, args = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${keys.owner}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Pages-Driver": "Content activity E2E agent",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name: operation, arguments: args },
    }),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200);
  const result = (await response.json()).result;
  const body = JSON.parse(result.content[0].text);
  assert.notEqual(result.isError, true, `${operation}: ${JSON.stringify(body)}`);
  return body;
}

async function listed(pageId) {
  for (let cursor; ; ) {
    const page = await mcp("list_pages", { limit: 100, ...(cursor && { cursor }) });
    const item = page.pages.find((entry) => entry.page_id === pageId);
    if (item || !page.next_cursor) return item;
    cursor = page.next_cursor;
  }
}

/** The Page's listed content time once it is at least `after`. */
async function contentTime(label, pageId, after, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (let item; ; ) {
    item = await listed(pageId);
    if (item?.content_updated_at) {
      assert.match(item.content_updated_at, isoTime);
      if (item.content_updated_at >= after) return item.content_updated_at;
    }
    if (Date.now() >= deadline)
      throw Error(
        `${label}: list_pages never reported a content time from ${after}: ${JSON.stringify(item)}`,
      );
    await sleep(250);
  }
}

// Past the one-minute window, plus the flush and listing latency.
const TRAILING_MS = 100_000;

async function create(title) {
  const created = await mcp("create_page", {
    title,
    markdown: "We ship on Friday.",
    idempotency_key: crypto.randomUUID(),
  });
  const item = await listed(created.page_id);
  assert.ok(item, "the new Page is listed");
  assert.equal(item.content_updated_at, null, "creation is not a content change");
  return created.page_id;
}

async function patch(pageId, from, to) {
  const read = await mcp("read_page", { page_id: pageId, comments: "none" });
  await mcp("patch_page", {
    page_id: pageId,
    base_heads: read.heads,
    retry_token: read.retry_token,
    idempotency_key: `${read.retry_key_prefix}${crypto.randomUUID()}`,
    operations: [
      { op: "replace_match", block_id: read.blocks[0].id, match_text: from, replacement: to },
    ],
  });
}

/** Two MCP edits in one window: the first flushes at once, the second waits
 * for the window's end, held on its own request. */
async function agentEdits(pageId) {
  const before = new Date().toISOString();
  await patch(pageId, "Friday", "Monday");
  const first = await contentTime("patch_page", pageId, before);
  complete("patch_page records a content time list_pages returns");
  const again = new Date().toISOString();
  await patch(pageId, "Monday", "Tuesday");
  assert.equal((await listed(pageId)).content_updated_at, first, "the second edit waits");
  const trailing = await contentTime("a second patch_page", pageId, again, TRAILING_MS);
  complete("a second patch_page in the window flushes at the window's end");
  return trailing;
}

/** Two typed edits in one window, then the tab closes: the trailing flush
 * runs after its socket is gone. */
async function tabEdits(pageId) {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  tab = await context.newPage();
  tab.on("pageerror", (error) => report.errors.push(error.message));
  const begin = await context.request.get(`${origin}/api/auth/login`, { maxRedirects: 0 });
  assert.equal(begin.status(), 302);
  const authorize = new URL(begin.headers().location);
  authorize.searchParams.set("login_hint", "dev@localhost");
  await tab.goto(authorize.href, { waitUntil: "domcontentloaded", timeout: 60000 });
  await expect(tab.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 60000,
  });
  await sleep(SETTLE_MS);
  await tab.goto(`${origin}/p/${pageId}`);
  const content = tab.locator("wg-content");
  await expect(content).toContainText("We ship on Friday.");
  await expect(content).toHaveAttribute("contenteditable", "true");
  // Let the socket's own setup finish, so the edit arrives on a resident one.
  await sleep(SETTLE_MS);
  await content.getByText("We ship on Friday.").click();
  await tab.keyboard.press("End");
  const typed = new Date().toISOString();
  await tab.keyboard.type(" Typed in a tab.");
  await expect(content).toContainText("Typed in a tab.");
  const first = await contentTime("a native edit", pageId, typed);
  complete("typing in a tab records a content time list_pages returns");
  const again = new Date().toISOString();
  await tab.keyboard.type(" Twice.");
  await expect(content).toContainText("Twice.");
  // Long enough for the edit to reach the host over the socket.
  await sleep(SETTLE_MS);
  await context.close();
  tab = undefined;
  assert.equal((await listed(pageId)).content_updated_at, first, "the second edit waits");
  const trailing = await contentTime("typing again, then closing", pageId, again, TRAILING_MS);
  complete("typing again, then closing the tab, flushes at the window's end");
  return trailing;
}

let browser, tab;
try {
  const agentPage = await create(`Agent edits ${Date.now()}`);
  const tabPage = await create(`Tab edits ${Date.now()}`);
  complete("new Pages list no content time");

  await sleep(SETTLE_MS);
  const [agentTime, tabTime] = await Promise.all([agentEdits(agentPage), tabEdits(tabPage)]);
  assert.notEqual(agentTime, tabTime);

  const top = await mcp("list_pages", { sort: "activity", limit: 2 });
  assert.deepEqual(
    top.pages.map((entry) => entry.page_id),
    tabTime > agentTime ? [tabPage, agentPage] : [agentPage, tabPage],
    "the edited Pages lead sort: activity, newest first",
  );
  complete("the edited Pages lead sort: activity");
} catch (error) {
  report.failure = error.stack ?? String(error);
  report.errors.push(error.message);
  if (tab) await tab.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  report.cleaned = true;
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
}
