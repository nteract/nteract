// Content activity on a real local host. One Page is edited over MCP and
// another by typing in a browser tab, each a few seconds after creation, once
// the request that opened its document has responded: celld drops work
// started in that request's context, and the repository's change events run
// there. list_pages must then report when each Page's content changed.
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

async function contentTime(label, pageId, after) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const item = await listed(pageId);
    if (item?.content_updated_at) {
      assert.match(item.content_updated_at, isoTime);
      assert.ok(item.content_updated_at >= after, `${label}: ${JSON.stringify(item)}`);
      return item.content_updated_at;
    }
    if (Date.now() >= deadline) throw Error(`${label}: list_pages never reported a content time`);
    await sleep(250);
  }
}

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

let browser, tab;
try {
  const agentPage = await create(`Agent edits ${Date.now()}`);
  const tabPage = await create(`Tab edits ${Date.now()}`);
  complete("new Pages list no content time");

  await sleep(SETTLE_MS);
  const read = await mcp("read_page", { page_id: agentPage, comments: "none" });
  const before = new Date().toISOString();
  await mcp("patch_page", {
    page_id: agentPage,
    base_heads: read.heads,
    retry_token: read.retry_token,
    idempotency_key: `${read.retry_key_prefix}${crypto.randomUUID()}`,
    operations: [
      {
        op: "replace_match",
        block_id: read.blocks[0].id,
        match_text: "Friday",
        replacement: "Monday",
      },
    ],
  });
  const agentTime = await contentTime("patch_page", agentPage, before);
  complete("patch_page records a content time list_pages returns");

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
  await tab.goto(`${origin}/p/${tabPage}`);
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
  const tabTime = await contentTime("a native edit", tabPage, typed);
  assert.ok(tabTime > agentTime);
  complete("typing in a tab records a content time list_pages returns");

  const top = await mcp("list_pages", { sort: "activity", limit: 2 });
  assert.deepEqual(
    top.pages.map((entry) => entry.page_id),
    [tabPage, agentPage],
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
