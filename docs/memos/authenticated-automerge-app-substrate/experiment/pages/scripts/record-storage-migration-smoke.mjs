// Record storage migration against an isolated local celld. Run through
// `node scripts/local-sharing-e2e.mjs --migration`. The harness starts celld
// with new Pages on Subduction; on request it restarts celld with plain
// Automerge sync and PAGES_MIGRATE_RECORD_STORAGE on. A Page converts once
// its last tab leaves (record-storage-migration.mjs). A second Page converts
// on the operator's request with a tab open (record-storage-operator.mjs).
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-migration-browser";
await mkdir(output, { recursive: true });
assert.equal(typeof process.send, "function", "run through local-sharing-e2e.mjs --migration");

const report = { completed: [], errors: [] };
const browser = await chromium.launch({ headless: true });
// The lab installer's operator secret, for the operator conversion.
const operatorSecret = crypto.randomUUID() + crypto.randomUUID();
let api, pageId, operatorPageId;

function restart(vars) {
  return new Promise((resolve, reject) => {
    const listener = (message) => {
      if (message?.type === "celld-restarted") resolve();
      else if (message?.type === "celld-restart-failed") reject(new Error(message.message));
      else return;
      process.off("message", listener);
    };
    process.on("message", listener);
    process.send({ type: "restart-celld", vars });
  });
}
/** A signed-in browser context and a tab in it. */
async function signIn() {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  const begin = await context.request.get(`${origin}/api/auth/login`, {
    maxRedirects: 0,
  });
  const authorize = new URL(begin.headers().location);
  authorize.searchParams.set("login_hint", "dev@localhost");
  await page.goto(authorize.href, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 60000,
  });
  return { context, page };
}
/** JSON over the context's cookie, with no tab: it holds no socket. */
async function call(path, body) {
  const response = await api.fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", origin },
    ...(body && { data: JSON.stringify(body) }),
  });
  return { status: response.status(), body: await response.json() };
}
const tool = (operation, args = {}) => call("/api/tools", { operation, arguments: args });
const content = (page) => page.locator(".page-block wg-content");
const saved = (page) => page.locator(".save-status--saved");
async function hostText() {
  const read = await tool("read_page", { page_id: pageId });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  return read.body.blocks.map((block) => block.markdown).join("\n");
}
async function typeAtEnd(page, text) {
  await content(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(text);
}

let a, b;
try {
  a = await signIn();
  b = await signIn();
  api = a.context.request;
  const created = await tool("create_page", {
    title: `Migration fixture ${Date.now()}`,
    markdown: "Native garden.",
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  pageId = report.pageId = created.body.page_id;
  const read = (await tool("read_page", { page_id: pageId })).body;
  const comment = await tool("manage_page_comment", {
    page_id: pageId,
    action: "add",
    block_id: read.blocks[0].id,
    body: "A native thread",
    body_format: "plain",
    base_heads: read.heads,
    retry_token: read.retry_token,
    idempotency_key: read.retry_key_prefix + crypto.randomUUID(),
  });
  assert.equal(comment.status, 200, JSON.stringify(comment.body));
  assert.equal((await call(`/api/connect?page=${pageId}`)).body.recordStorage, undefined);
  const second = await tool("create_page", {
    title: `Operator fixture ${Date.now()}`,
    markdown: "Operator garden.",
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  operatorPageId = report.operatorPageId = second.body.page_id;

  // Tab B opens the Page, then loses its network and types.
  await b.page.goto(`${origin}/p/${pageId}`);
  await expect(content(b.page)).toContainText("Native garden.");
  await expect(saved(b.page)).toBeVisible({ timeout: 30000 });
  await b.context.setOffline(true);
  await typeAtEnd(b.page, " Typed offline.");
  await expect(content(b.page)).toContainText("Typed offline.");
  report.completed.push("Subduction Page with a comment; tab B typed an edit offline");

  // The host restarts with plain sync and migration on. Nothing converts at
  // boot: tab A opens the Page natively and edits it.
  await restart({
    PAGES_RECORD_STORAGE: "automerge",
    PAGES_MIGRATE_RECORD_STORAGE: "true",
    PAGES_MIGRATE_PAGE_IDS: JSON.stringify([pageId]),
    PAGES_MIGRATE_QUIET_MS: "500",
    PAGES_OPERATOR_SECRET: operatorSecret,
  });
  await a.page.goto(`${origin}/p/${pageId}`);
  await expect(content(a.page)).toContainText("Native garden.", {
    timeout: 60000,
  });
  await typeAtEnd(a.page, " From tab A.");
  await expect(saved(a.page)).toBeVisible({ timeout: 30000 });
  await a.page.waitForTimeout(1500);
  assert.equal(
    (await call(`/api/connect?page=${pageId}`)).body.recordStorage,
    undefined,
    "no conversion while a tab is open",
  );
  report.completed.push("After the restart, a Page with a tab open stays on Subduction");

  // Tab A leaves. The host converts once nobody is connected.
  await a.page.goto(`${origin}/`);
  await expect
    .poll(async () => (await call(`/api/connect?page=${pageId}`)).body.recordStorage, {
      timeout: 30000,
      intervals: [1500],
    })
    .toBe("automerge");
  assert.match(await hostText(), /Native garden\. From tab A\./);
  report.completed.push("Tab A left; the host converted the Page to plain sync");

  // A fresh tab opens it plain, with its content and comment.
  const c = await signIn();
  await c.page.goto(`${origin}/p/${pageId}`);
  await expect(content(c.page)).toContainText("From tab A.", {
    timeout: 60000,
  });
  await expect(saved(c.page)).toBeVisible({ timeout: 30000 });
  const dbs = await c.page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  assert.ok(
    dbs.some((name) => name.startsWith("pages-plain-")),
    "a plain replica",
  );
  const comments = (await tool("list_page_comments", { page_id: pageId })).body.comments;
  assert.ok(comments.some((thread) => JSON.stringify(thread).includes("A native thread")));
  report.completed.push("A fresh tab opened the Page plain, with its content and comment");
  await c.context.close();

  // Tab B comes back online. Discovery names plain storage, so its native
  // replica checkpoints its edit under plain storage and asks for a reload.
  await b.context.setOffline(false);
  await expect(b.page.getByText("This Page's storage changed")).toBeVisible({
    timeout: 60000,
  });
  await b.page.screenshot({ path: `${output}/storage-changed.png` });
  await b.page.reload({ waitUntil: "domcontentloaded" });
  await expect(content(b.page)).toContainText("Typed offline.", {
    timeout: 60000,
  });
  await expect(saved(b.page)).toBeVisible({ timeout: 60000 });
  await expect.poll(hostText, { timeout: 30000 }).toContain("Typed offline.");
  assert.match(await hostText(), /From tab A\./);
  report.completed.push("Tab B reconnected, reloaded on plain sync, and its offline edit arrived");

  // The operator converts the second Page while tab D has it open. Its
  // socket closes, its next discovery names plain storage, and it reloads.
  const d = await signIn();
  await d.page.goto(`${origin}/p/${operatorPageId}`);
  await expect(content(d.page)).toContainText("Operator garden.", { timeout: 60000 });
  await typeAtEnd(d.page, " Before the operator.");
  await expect(saved(d.page)).toBeVisible({ timeout: 30000 });
  const operate = async (body) => {
    const response = await fetch(`${origin}/api/operator/record-storage`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pages-operator-secret": operatorSecret },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const converted = await operate({ action: "convert", page_id: operatorPageId });
  assert.equal(converted.status, 200, JSON.stringify(converted.body));
  report.operator = converted.body;
  assert.equal(converted.body.status.record_storage, "automerge", JSON.stringify(converted.body));
  assert.equal(converted.body.status.migrated_from, "buffered");
  await expect(d.page.getByText("This Page's storage changed")).toBeVisible({ timeout: 60000 });
  await d.page.screenshot({ path: `${output}/operator-storage-changed.png` });
  await d.page.reload({ waitUntil: "domcontentloaded" });
  await expect(content(d.page)).toContainText("Before the operator.", { timeout: 60000 });
  await typeAtEnd(d.page, " After the operator.");
  await expect(saved(d.page)).toBeVisible({ timeout: 60000 });
  const operatorText = async () =>
    (await tool("read_page", { page_id: operatorPageId })).body.blocks
      .map((block) => block.markdown)
      .join("\n");
  await expect.poll(operatorText, { timeout: 30000 }).toContain("After the operator.");
  assert.match(await operatorText(), /Before the operator\./);
  const plainDbs = await d.page.evaluate(async () =>
    (await indexedDB.databases()).map((x) => x.name),
  );
  assert.ok(
    plainDbs.some((name) => name.startsWith("pages-plain-")),
    "a plain replica after reload",
  );
  report.completed.push(
    "The operator converted a Page with a tab open; the tab reloaded plain and kept editing",
  );
  await d.context.close();
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.message;
  for (const [name, tab] of [
    ["a", a],
    ["b", b],
  ])
    if (tab) {
      report[name] = await tab.page
        .locator("body")
        .innerText()
        .catch(() => null);
      await tab.page.screenshot({ path: `${output}/failure-${name}.png` }).catch(() => {});
    }
  throw error;
} finally {
  for (const id of [operatorPageId].filter(Boolean))
    if (api)
      try {
        const r = await tool("read_page", { page_id: id });
        await tool("delete_page", {
          page_id: id,
          base_heads: r.body.heads,
          idempotency_key: crypto.randomUUID(),
        });
      } catch {}
  if (pageId && api) {
    try {
      await b?.context.setOffline(false).catch(() => {});
      const r = await tool("read_page", { page_id: pageId });
      const d = await tool("delete_page", {
        page_id: pageId,
        base_heads: r.body.heads,
        idempotency_key: crypto.randomUUID(),
      });
      report.cleaned = d.status === 200;
    } catch (error) {
      report.cleanupError = error.message;
    }
  }
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
  process.disconnect?.();
}
console.log(JSON.stringify(report, null, 2));
