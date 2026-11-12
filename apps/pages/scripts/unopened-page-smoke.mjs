// A Page stored in a format this build doesn't open, in the browser. The
// fixture Worker (fixtures/local-unopened-worker.mjs) stamps two Pages' host
// records with an unwritten format and the harness restarts celld, so their
// hosts start cold over those records. Then:
// - a collaborator opening one sees the refusal and no action;
// - its owner moves it to Trash from the stopped screen, opens it from Trash
//   (which offers Trash again), restores it and deletes it permanently;
// - the owner's tab that had the other Page open when the host restarted
//   moves it to Trash from the Page menu.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
assert.equal(new URL(origin).protocol, "http:");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-unopened-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = { completed: [], errors: [] };
const complete = (name) => {
  report.completed.push(name);
  console.log(`[Unopened Page E2E] ${name}`);
};
const pages = {};

function restartCelld() {
  return new Promise((resolve, reject) => {
    const listener = (message) => {
      if (message?.type === "celld-restarted") resolve();
      else if (message?.type === "celld-restart-failed") reject(new Error(message.message));
      else return;
      process.off("message", listener);
    };
    process.on("message", listener);
    process.send({ type: "restart-celld" });
  });
}
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
async function signIn(name, email) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${name}: ${error.message}`));
  page.on("dialog", (dialog) => dialog.accept());
  const begin = await context.request.get(`${origin}/api/auth/login`, { maxRedirects: 0 });
  assert.equal(begin.status(), 302);
  const authorize = new URL(begin.headers().location);
  authorize.searchParams.set("login_hint", email);
  await page.goto(authorize.href, { waitUntil: "domcontentloaded", timeout: 60000 });
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 60000,
  });
  pages[name] = page;
  return page;
}
async function create(page, title, markdown) {
  const created = await tool(page, "create_page", {
    title,
    markdown,
    nonce: crypto.randomUUID(),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return created.body.page_id;
}
async function unopen(pageId) {
  const response = await fetch(`${origin}/__e2e/unopen?page=${pageId}`, { method: "POST" });
  assert.equal(response.status, 200, await response.text());
}
const listed = async (page, pageId, args = {}) =>
  (await tool(page, "list_pages", args)).body.pages.some((entry) => entry.page_id === pageId);
async function openTrash(page) {
  await page.getByRole("button", { name: /, switch page$/ }).click();
  await page.getByRole("dialog", { name: "Pages" }).getByRole("button", { name: "Trash" }).click();
  await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
}
const MESSAGE = "This Page is stored in a format this version of Pages doesn't open.";
const stopped = (page) => page.locator("main.unopened-page");

try {
  const owner = await signIn("owner", "dev@localhost");
  const editor = await signIn("editor", "alice@localhost");
  const openTab = await signIn("openTab", "dev@localhost");
  const stamp = Date.now();
  const title = `Unopened fixture ${stamp}`;
  const pageId = await create(owner, title, "Stored in a format from elsewhere.");
  const openTitle = `Open when stopped ${stamp}`;
  const openId = await create(owner, openTitle, "Open in a tab when its host stops it.");
  report.pageIds = [pageId, openId];
  const current = await api(owner, `/api/access?page=${pageId}`);
  const invite = await api(owner, `/api/access?page=${pageId}`, {
    action: "invite",
    email: "alice@localhost",
    role: "editor",
    expected_revision: current.body.access.revision,
    nonce: crypto.randomUUID(),
  });
  assert.equal(invite.status, 200, JSON.stringify(invite.body));
  await editor.goto(`${origin}/p/${pageId}`);
  await expect(editor.locator("wg-content")).toContainText("Stored in a format from elsewhere.");
  await openTab.goto(`${origin}/p/${openId}`);
  await expect(openTab.locator("wg-content")).toContainText("Open in a tab");
  await editor.goto(`${origin}/`);
  complete("Owner created two Pages and shared one with an editor");

  await unopen(pageId);
  await unopen(openId);
  await restartCelld();
  const connect = await api(owner, `/api/connect?page=${pageId}`);
  assert.equal(connect.status, 409);
  assert.equal(connect.body.code, "document_format_unsupported");
  complete("Both Pages' hosts restarted over records in a format this build doesn't write");

  // The editor's browser holds a copy, so it opens read-only from that copy;
  // a browser that never opened the Page gets the stopped screen.
  await editor.goto(`${origin}/p/${pageId}`);
  await expect(editor.getByText(MESSAGE).first()).toBeVisible({ timeout: 30000 });
  await editor.getByLabel("Document actions", { exact: true }).click();
  await expect(editor.getByRole("button", { name: "Copy link" })).toBeVisible();
  await expect(editor.getByRole("button", { name: "Move to Trash" })).toHaveCount(0);
  const reader = await signIn("reader", "alice@localhost");
  await reader.goto(`${origin}/p/${pageId}`);
  await expect(stopped(reader)).toHaveAttribute("data-state", "reader", { timeout: 30000 });
  await expect(stopped(reader)).toContainText(MESSAGE);
  await expect(reader.getByRole("button", { name: "Move to Trash" })).toHaveCount(0);
  await expect(reader.locator(".app-error")).toHaveCount(0);
  await reader.screenshot({ path: `${output}/unopened-collaborator.png` });
  complete("A collaborator sees the refusal and no action, with or without a local copy");

  // From the library to the Page and Back: the stopped screen leaves with
  // its address, and Forward shows it again.
  await owner.goto(`${origin}/`);
  await owner
    .getByRole("link", { name: new RegExp(title) })
    .first()
    .click();
  await expect(stopped(owner)).toHaveAttribute("data-state", "owner", { timeout: 30000 });
  await owner.goBack();
  await expect(stopped(owner)).toHaveCount(0);
  assert.equal(new URL(owner.url()).pathname, "/");
  await expect(owner.getByRole("link", { name: new RegExp(title) }).first()).toBeVisible();
  await owner.goForward();
  assert.equal(new URL(owner.url()).pathname, `/p/${pageId}`);
  await expect(stopped(owner)).toHaveAttribute("data-state", "owner", { timeout: 30000 });
  complete("Back from the stopped screen shows the library; Forward shows it again");
  await expect(stopped(owner)).toContainText(MESSAGE);
  await owner.screenshot({ path: `${output}/unopened-owner.png` });
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(stopped(owner).getByRole("button", { name: "Move to Trash" })).toBeInViewport();
  await owner.screenshot({ path: `${output}/unopened-owner-narrow.png` });
  await owner.setViewportSize({ width: 1280, height: 900 });
  await stopped(owner).getByRole("button", { name: "Move to Trash" }).click();
  await expect(owner.getByText("Moved to Trash")).toBeVisible({ timeout: 30000 });
  assert.equal(new URL(owner.url()).pathname, "/");
  assert.equal(await listed(owner, pageId), false);
  assert.equal(await listed(owner, pageId, { in_trash: true }), true);
  complete("The owner moved it to Trash from the stopped screen and landed on the library");

  await openTrash(owner);
  const row = owner.locator(".trash-row").filter({ hasText: title });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: new RegExp(title) }).click();
  await expect(stopped(owner)).toHaveAttribute("data-state", "inTrash", { timeout: 30000 });
  await expect(stopped(owner).getByRole("button", { name: "Move to Trash" })).toHaveCount(0);
  await owner.screenshot({ path: `${output}/unopened-from-trash.png` });
  await stopped(owner).getByRole("button", { name: "Open Trash" }).click();
  await expect(owner.getByRole("heading", { name: "Trash" })).toBeVisible();
  complete("Opening it from Trash shows the refusal with a way back to Trash");

  await row.getByRole("button", { name: "Restore" }).click();
  await expect(owner.getByText("Page restored")).toBeVisible({ timeout: 30000 });
  assert.equal(await listed(owner, pageId), true);
  const trashedAgain = await tool(owner, "delete_page", {
    page_id: pageId,
    nonce: crypto.randomUUID(),
  });
  assert.equal(trashedAgain.status, 200, JSON.stringify(trashedAgain.body));
  await owner.goto(`${origin}/`);
  await openTrash(owner);
  await row.getByRole("button", { name: "Delete permanently" }).click();
  const review = owner.locator(".purge-confirmation");
  await expect(review).toContainText("Its comments will be deleted.");
  await expect(review).toContainText("1 collaborator will lose access");
  await review.getByRole("button", { name: "Delete permanently" }).click();
  await expect(owner.getByText("Page deleted permanently")).toBeVisible({ timeout: 30000 });
  assert.equal(await listed(owner, pageId, { in_trash: true }), false);
  complete("Restore and Delete permanently work for it from Trash");

  // This tab had the Page open when its host restarted: the session stays,
  // stopped, and its menu's Move to Trash names no heads.
  await expect(openTab.getByText(MESSAGE).first()).toBeVisible({ timeout: 60000 });
  await openTab.getByLabel("Document actions", { exact: true }).click();
  await openTab.getByRole("button", { name: "Move to Trash" }).click();
  await expect(openTab.getByText("Moved to Trash")).toBeVisible({ timeout: 30000 });
  assert.equal(await listed(owner, openId, { in_trash: true }), true);
  await openTab.screenshot({ path: `${output}/unopened-open-tab.png` });
  complete("A tab that had the Page open when its host stopped it moves it to Trash");

  report.cleaned = true;
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.stack || error.message;
  for (const [name, page] of Object.entries(pages))
    await page
      .screenshot({ path: `${output}/failure-${name}.png`, fullPage: true })
      .catch(() => {});
  throw error;
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + "\n");
  await browser.close();
}
