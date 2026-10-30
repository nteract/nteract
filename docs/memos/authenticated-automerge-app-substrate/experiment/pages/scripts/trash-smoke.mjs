// Trash, restore, and permanent deletion across two local OIDC accounts.
// The owner uses the browser Trash UI; the collaborator observes access changes.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
assert.equal(new URL(origin).protocol, "http:");
const keys = process.env.PAGES_E2E_KEY_FILE
  ? JSON.parse(await readFile(process.env.PAGES_E2E_KEY_FILE, "utf8"))
  : null;
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-trash-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = { completed: [], errors: [] };
const complete = (name) => {
  report.completed.push(name);
  console.log(`[Trash E2E] ${name}`);
};
let pageId, owner, editor, fresh;
async function api(page, path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    },
    { path, body },
  );
}
const tool = (page, operation, args = {}) =>
  api(page, "/api/tools", { operation, arguments: args });
async function mcp(name, operation, args) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${keys[name]}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Pages-Driver": "Trash E2E agent",
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
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
}
const content = (page) => page.locator("wg-content");
async function signIn(email) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
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
async function openTrash(page) {
  await page.getByRole("button", { name: /, switch page$/ }).click();
  await page.getByRole("dialog", { name: "Pages" }).getByRole("button", { name: "Trash" }).click();
  await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
}
const listed = async (page, args = {}) =>
  (await tool(page, "list_pages", args)).body.pages.some((entry) => entry.page_id === pageId);
try {
  owner = await signIn("dev@localhost");
  editor = await signIn("alice@localhost");
  const title = "Trash fixture " + Date.now();
  const created = await tool(owner, "create_page", {
    title,
    markdown: "Trash keeps this sentence.",
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
    body: "Keep this comment",
  });
  assert.equal(commented.status, 200);
  const current = await api(owner, `/api/access?page=${pageId}`);
  const invite = await api(owner, `/api/access?page=${pageId}`, {
    action: "invite",
    email: "alice@localhost",
    role: "editor",
    expected_revision: current.body.access.revision,
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(invite.status, 200);
  await editor.goto(`${origin}/p/${pageId}`);
  await expect(content(editor)).toContainText("Trash keeps this sentence.");
  await expect(content(editor)).toHaveAttribute("contenteditable", "true");
  assert.equal(await listed(editor), true);
  complete("Owner created, commented, and shared a Page with an editor");

  await owner.goto(`${origin}/p/${pageId}`);
  await expect(content(owner)).toContainText("Trash keeps this sentence.");
  await owner.getByLabel("Document actions", { exact: true }).click();
  await owner.getByRole("button", { name: "Move to Trash" }).click();
  await expect(owner.getByText("Moved to Trash")).toBeVisible();
  assert.equal(await listed(owner), false);
  assert.equal(await listed(owner, { in_trash: true }), true);
  await expect(editor.getByText(/in its owner's Trash/).first()).toBeVisible({ timeout: 30000 });
  await expect(content(editor)).not.toHaveAttribute("contenteditable", "true");
  const editorConnect = await api(editor, `/api/connect?page=${pageId}`);
  assert.equal(editorConnect.status, 403);
  assert.equal(editorConnect.body.code, "page_trashed");
  assert.equal(await listed(editor), false);
  await editor.screenshot({ path: `${output}/trash-collaborator.png` });
  complete("Move to Trash hid the Page and closed the editor's access with page_trashed");

  if (keys) {
    const ownerRead = await mcp("owner", "read_page", { page_id: pageId, comments: "none" });
    assert.equal(ownerRead.isError, false);
    assert.equal(ownerRead.body.trash.state, "trashed");
    const edit = await mcp("owner", "patch_page", {
      page_id: pageId,
      base_heads: ownerRead.body.heads,
      idempotency_key: crypto.randomUUID(),
      operations: [
        {
          op: "replace_match",
          block_id: read.blocks[0].id,
          match_text: "keeps",
          replacement: "lost",
        },
      ],
    });
    assert.equal(edit.isError, true);
    assert.equal(edit.body.code, "page_trashed");
    assert.equal((await mcp("editor", "read_page", { page_id: pageId })).isError, true);
    const trash = await mcp("owner", "list_pages", { in_trash: true });
    assert.ok(trash.body.pages.some((entry) => entry.page_id === pageId));
    complete("MCP owner reads trashed Page read-only; editor read denied; in_trash lists it");
  }

  await openTrash(owner);
  const row = owner.locator(".trash-row").filter({ hasText: title });
  await expect(row).toBeVisible();
  await owner.screenshot({ path: `${output}/trash-view.png` });
  await row.getByRole("link", { name: new RegExp(title) }).click();
  // This tab still has the writer replica it used before trashing. The
  // preview reloads onto a reader replica; a possible draft asks first.
  const preview = owner.getByText("This Page is in Trash.");
  const reload = owner.getByRole("button", { name: "Reload current Page" });
  await expect(preview.or(reload)).toBeVisible({ timeout: 30000 });
  // The prompt disappears on its own once the preview takes over, so a click
  // can race its removal; the preview is what this step needs.
  if (await reload.isVisible())
    await reload.click({ timeout: 5000 }).catch(async (error) => {
      if (!(await preview.isVisible())) throw error;
    });
  await expect(preview).toBeVisible({ timeout: 30000 });
  await expect(content(owner)).toContainText("Trash keeps this sentence.");
  await expect(content(owner)).not.toHaveAttribute("contenteditable", "true");
  await expect(owner.getByLabel("Page title")).toHaveAttribute("readonly", "");
  await owner.screenshot({ path: `${output}/trash-owner-preview.png` });
  complete("Owner opened a read-only preview from Trash");

  // A browser that never opened the Page before previews on a fresh reader
  // key. Restore must move it to a writer replica whose edits sync.
  fresh = await signIn("dev@localhost");
  await openTrash(fresh);
  await fresh
    .locator(".trash-row")
    .filter({ hasText: title })
    .getByRole("link", { name: new RegExp(title) })
    .click();
  await expect(fresh.getByText("This Page is in Trash.")).toBeVisible({ timeout: 30000 });
  await expect(content(fresh)).not.toHaveAttribute("contenteditable", "true");
  await fresh.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(content(fresh)).toHaveAttribute("contenteditable", "true", { timeout: 30000 });
  await content(fresh).getByText("Trash keeps this sentence.").click();
  await fresh.keyboard.press("End");
  await fresh.keyboard.type(" Edited after restore.");
  await expect(fresh.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({
    timeout: 30000,
  });
  await expect
    .poll(async () => (await tool(owner, "read_page", { page_id: pageId })).body.blocks[0].markdown)
    .toContain("Edited after restore.");
  await fresh.screenshot({ path: `${output}/trash-restored-fresh.png` });
  complete("A fresh browser previewed from Trash, restored, edited, and reached Saved");

  await owner.goto(`${origin}/p/${pageId}`);
  await expect(content(owner)).toHaveAttribute("contenteditable", "true", { timeout: 30000 });
  assert.equal(await listed(owner), true);
  assert.equal(await listed(owner, { in_trash: true }), false);
  const restored = (await tool(owner, "read_page", { page_id: pageId, comments: "all" })).body;
  assert.equal(restored.title, title);
  assert.equal(restored.comments.length, 1);
  await editor.goto(`${origin}/p/${pageId}`);
  await expect(content(editor)).toContainText("Trash keeps this sentence.");
  await expect(content(editor)).toHaveAttribute("contenteditable", "true", { timeout: 30000 });
  assert.equal((await api(editor, `/api/connect?page=${pageId}`)).body.access.role, "editor");
  assert.equal(await listed(editor), true);
  complete("Restore returned content, comments, and the editor's role and listing");

  const again = (await tool(owner, "read_page", { page_id: pageId })).body;
  const authority = (await tool(owner, "list_pages")).body;
  const trashedAgain = await tool(owner, "delete_page", {
    page_id: pageId,
    base_heads: again.heads,
    retry_token: authority.retry_token,
    idempotency_key: authority.retry_key_prefix + crypto.randomUUID(),
  });
  assert.equal(trashedAgain.status, 200);
  await owner.goto(origin + "/");
  await openTrash(owner);
  await row.getByRole("button", { name: "Delete permanently" }).click();
  const review = owner.locator(".purge-confirmation");
  await expect(review).toContainText("1 comment will be deleted.");
  await expect(review).toContainText("1 collaborator will lose access");
  await owner.screenshot({ path: `${output}/trash-purge-review.png` });
  await review.getByRole("button", { name: "Delete permanently" }).click();
  await expect(owner.getByText("Page deleted permanently")).toBeVisible();
  await expect(owner.getByText("Trash is empty.")).toBeVisible();
  assert.equal((await tool(owner, "read_page", { page_id: pageId })).status, 404);
  assert.equal(await listed(owner, { in_trash: true }), false);
  report.cleaned = true;
  complete("Permanent deletion reviewed comments and collaborators, then removed the Page");
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.stack || error.message;
  for (const [name, page] of [
    ["owner", owner],
    ["editor", editor],
    ["fresh", fresh],
  ])
    if (page)
      await page
        .screenshot({ path: `${output}/failure-${name}.png`, fullPage: true })
        .catch(() => {});
  throw error;
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + "\n");
  await browser.close();
}
