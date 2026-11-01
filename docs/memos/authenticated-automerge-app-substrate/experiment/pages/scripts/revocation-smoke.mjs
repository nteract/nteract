// Removed access across two local OIDC accounts. The collaborator's open tab
// hides the Page when the owner removes them, a reload never renders the local
// copy, the notice downloads it, and a re-grant opens the Page again.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
assert.equal(new URL(origin).protocol, "http:");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-revocation-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = { completed: [], errors: [] };
const complete = (name) => {
  report.completed.push(name);
  console.log(`[Revocation E2E] ${name}`);
};
const BODY = "Only collaborators should read this sentence.";
const TYPED = " The collaborator typed this.";
const COMMENT = "A comment the archive keeps.";
let pageId, owner, collaborator;
async function api(page, path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json", "X-Pages-Admission": "1" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    },
    { path, body },
  );
}
const tool = (page, operation, args = {}) =>
  api(page, "/api/tools", { operation, arguments: args });
async function access(action) {
  const current = await api(owner, `/api/access?page=${pageId}`);
  assert.equal(current.status, 200);
  const result = await api(owner, `/api/access?page=${pageId}`, {
    ...action,
    expected_revision: current.body.access.revision,
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result;
}
const content = (page) => page.locator("wg-content");
const DRAFT = "A comment draft typed before the removal.";
async function select(page, text) {
  const editor = page.locator("article wg-content").first();
  await editor.focus();
  // Wait for Wordgard's next frame so its caret write can't replace the range.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  await editor.evaluate((element, text) => {
    const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const at = walk.currentNode.textContent.indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(walk.currentNode, at);
      range.setEnd(walk.currentNode, at + text.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return;
    }
    throw Error("Text not found");
  }, text);
  await page.waitForTimeout(60);
}
async function signIn(email) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  const begin = await context.request.get(`${origin}/api/auth/login`, { maxRedirects: 0 });
  assert.equal(begin.status(), 302);
  const authorize = new URL(begin.headers().location);
  authorize.searchParams.set("login_hint", email);
  await page.goto(authorize.href, { waitUntil: "domcontentloaded", timeout: 60000 });
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 60000,
  });
  return page;
}
try {
  owner = await signIn("dev@localhost");
  collaborator = await signIn("alice@localhost");
  const principal = (await api(collaborator, "/api/auth/session")).body.identity.principal;
  const title = "Revocation fixture " + Date.now();
  const created = await tool(owner, "create_page", {
    title,
    markdown: BODY,
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(created.status, 200);
  pageId = created.body.page_id;
  report.pageId = pageId;
  const read = (await tool(owner, "read_page", { page_id: pageId })).body;
  const commented = await tool(owner, "manage_page_comment", {
    page_id: pageId,
    base_heads: read.heads,
    idempotency_key: crypto.randomUUID(),
    action: "add",
    block_id: read.blocks[0].id,
    body: COMMENT,
  });
  assert.equal(commented.status, 200);
  await access({ action: "invite", email: "alice@localhost", role: "editor" });
  await collaborator.goto(`${origin}/p/${pageId}`);
  await expect(content(collaborator)).toContainText(BODY, { timeout: 30000 });
  await expect(content(collaborator)).toHaveAttribute("contenteditable", "true");
  await content(collaborator).getByText(BODY).click();
  await collaborator.keyboard.press("End");
  await collaborator.keyboard.type(TYPED);
  await expect(collaborator.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({
    timeout: 30000,
  });
  complete("The owner shared a commented Page and the collaborator edited it");

  await select(collaborator, "collaborators");
  await collaborator.getByRole("button", { name: "Comment on selection", exact: true }).click();
  const composer = collaborator
    .getByRole("dialog", { name: "Comment on selection", exact: true })
    .getByRole("textbox", { name: "Comment on selection", exact: true });
  await expect(composer).toBeFocused();
  await composer.pressSequentially(DRAFT);
  complete("The collaborator left an unsent comment draft open");

  await access({ action: "set_role", principal, role: null });
  const notice = collaborator.getByRole("heading", { name: "You no longer have access" });
  await expect(notice).toBeVisible({ timeout: 30000 });
  await expect(content(collaborator)).toHaveCount(0);
  await expect(collaborator.getByText(BODY)).toHaveCount(0);
  await collaborator.screenshot({ path: `${output}/revoked-live.png` });
  complete("The open tab hid the Page as soon as the owner removed the collaborator");

  // Record whether the Page ever renders while the reload opens it.
  await collaborator.addInitScript((needle) => {
    window.__pageRendered = false;
    new MutationObserver(() => {
      if (document.querySelector("wg-content") || document.body?.textContent.includes(needle))
        window.__pageRendered = true;
    }).observe(document, { childList: true, subtree: true, characterData: true });
  }, BODY);
  await collaborator.reload();
  await expect(notice).toBeVisible({ timeout: 30000 });
  await expect(content(collaborator)).toHaveCount(0);
  const shown = await collaborator.locator("body").innerText();
  assert.ok(!shown.includes(BODY), "the body never shows");
  assert.ok(!shown.includes(title), "the title never shows");
  assert.equal(await collaborator.evaluate(() => window.__pageRendered), false);
  const connect = await api(collaborator, `/api/connect?page=${pageId}`);
  assert.equal(connect.status, 403);
  assert.equal(connect.body.code, "page_access_denied");
  await collaborator.screenshot({ path: `${output}/revoked-reload.png` });
  complete("After a reload the notice stands in for the Page, which never rendered");

  const [download] = await Promise.all([
    collaborator.waitForEvent("download"),
    collaborator.getByRole("button", { name: /^Download (local copy|\d+ local copies)$/ }).click(),
  ]);
  const bundle = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(bundle.page_id, pageId);
  assert.ok(bundle.copies.length >= 1);
  const markdown = bundle.copies.map((copy) => copy.markdown).join("\n");
  assert.match(markdown, new RegExp(BODY));
  assert.match(markdown, new RegExp(TYPED.trim()));
  assert.match(markdown, new RegExp(COMMENT));
  assert.match(markdown, /## Unsent comment drafts/);
  assert.match(markdown, new RegExp(DRAFT));
  assert.match(markdown, /On “collaborators”/);
  for (const copy of bundle.copies)
    if (copy.snapshot !== undefined) assert.equal(typeof copy.snapshot, "string");
  complete("The notice downloaded every archived copy with the edit, the comment and the draft");

  await access({ action: "invite", email: "alice@localhost", role: "editor" });
  await collaborator.reload();
  await expect(content(collaborator)).toContainText(BODY, { timeout: 30000 });
  await expect(content(collaborator)).toContainText(TYPED.trim());
  await expect(content(collaborator)).toHaveAttribute("contenteditable", "true", {
    timeout: 30000,
  });
  await expect(notice).toHaveCount(0);
  await collaborator.screenshot({ path: `${output}/regranted.png` });
  complete("A re-grant opened the Page from the server");
  report.cleaned = true;
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.stack || error.message;
  for (const [name, page] of [
    ["owner", owner],
    ["collaborator", collaborator],
  ])
    if (page)
      await page
        .screenshot({ path: `${output}/failure-${name}.png`, fullPage: true })
        .catch(() => {});
  throw error;
} finally {
  if (pageId && owner && report.cleaned) {
    try {
      const read = await tool(owner, "read_page", { page_id: pageId });
      const deleted = await tool(owner, "delete_page", {
        page_id: pageId,
        base_heads: read.body.heads,
        idempotency_key: crypto.randomUUID(),
      });
      report.cleaned = deleted.status === 200;
    } catch (error) {
      report.cleaned = false;
      report.cleanupError = error.message;
    }
  }
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + "\n");
  await browser.close();
}
