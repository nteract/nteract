// Run against the loopback OIDC fixture only. Intentionally hold registration
// to prove that editing and navigation do not wait for the host to create a Page.
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const browser = await chromium.launch({ headless: true });
const errors = [];
const api = async (page, operation, args = {}) => {
  const response = await page.request.post(origin + "/api/tools", {
    data: { operation, arguments: args },
    headers: { Origin: origin },
  });
  assert.ok(response.ok(), await response.text());
  return response.json();
};
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/api/auth/login");
  await expect(page.getByRole("button", { name: "New Page", exact: true })).toBeVisible();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let registrations = 0;
  await context.route("**/api/pages/register", async (route) => {
    registrations++;
    await gate;
    await route.continue().catch(() => {});
  });
  const started = performance.now();
  await page.getByRole("button", { name: "New Page", exact: true }).click();
  await expect(page.locator(".ProseMirror")).toBeFocused({ timeout: 3000 });
  const editableMs = Math.round(performance.now() - started);
  await expect(page).toHaveURL(/\/p\/[0-9a-f-]{36}$/);
  const url = page.url(),
    id = new URL(url).pathname.split("/")[2];
  const title = "Local creation " + Date.now();
  await page.getByRole("textbox", { name: "Page title", exact: true }).fill(title);
  await page.locator(".ProseMirror").fill("Written while registration is held.");
  await expect.poll(() => registrations).toBeGreaterThan(0);
  await expect(page.getByRole("status")).not.toHaveText("Saved");
  await page.getByRole("link", { name: "Pages", exact: true }).click();
  await expect(page).toHaveURL(origin + "/");
  await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(url);
  await expect(page.locator(".ProseMirror")).toHaveText("Written while registration is held.");
  await page.goForward();
  await expect(page).toHaveURL(origin + "/");
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await expect(page).toHaveURL(url);
  await page.reload();
  await expect(page.locator(".ProseMirror")).toHaveText("Written while registration is held.");
  release();
  await expect(page.getByRole("status")).toHaveText("Saved", { timeout: 20000 });
  const remote = await api(page, "read_page", { page_id: id });
  assert.match(remote.blocks[0].markdown, /Written while registration is held/);
  const listing = await api(page, "list_pages");
  assert.equal(
    listing.pages.filter((p) => p.page_id === id).length,
    1,
    "registration retries create one page",
  );
  // A direct link must not depend on the catalog returning first.
  const peerContext = await browser.newContext();
  const peer = await peerContext.newPage();
  peer.on("pageerror", (e) => errors.push(e.message));
  await peer.goto(
    origin + "/api/auth/login?return_to=" + encodeURIComponent(new URL(url).pathname),
  );
  await expect(peer).toHaveURL(url);
  await expect(peer.locator(".ProseMirror")).toHaveText("Written while registration is held.", {
    timeout: 20000,
  });
  let releaseCatalog;
  const catalogGate = new Promise((resolve) => {
    releaseCatalog = resolve;
  });
  await peer.route("**/api/tools", async (route) => {
    if (route.request().postDataJSON()?.operation === "list_pages") await catalogGate;
    await route.continue().catch(() => {});
  });
  await peer.goto(origin + "/?page=" + id);
  await expect(peer).toHaveURL(url);
  await expect(peer.locator(".ProseMirror")).toHaveText("Written while registration is held.");
  releaseCatalog();
  await peer.unroute("**/api/tools");
  // Stable native history still supports simultaneous edits after registration.
  await peer.locator(".ProseMirror").press("ControlOrMeta+End");
  await peer.locator(".ProseMirror").pressSequentially(" A second peer joined.");
  await expect(page.locator(".ProseMirror")).toContainText("A second peer joined.");
  // A new draft must publish edits from its first live session, without a reload.
  await page.getByRole("link", { name: "Pages", exact: true }).click();
  await page.getByRole("button", { name: "New Page", exact: true }).click();
  await expect(page.locator(".ProseMirror")).toBeFocused();
  const plainUrl = page.url();
  await page.getByRole("textbox", { name: "Page title", exact: true }).fill("First session saves");
  // One failed receipt must recover while leaving the healthy socket alone.
  let receiptCalls = 0;
  await page.route("**/api/saved?*", async (route) => {
    if (++receiptCalls === 1)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary receipt failure" }),
      });
    await route.continue();
  });
  await page.locator(".ProseMirror").fill("Written and saved without reopening.");
  await expect(page.getByRole("status")).toHaveText("Saved", { timeout: 20000 });
  assert.ok(receiptCalls >= 2, "temporary receipt error retries");
  await page.unroute("**/api/saved?*");
  const plainId = new URL(plainUrl).pathname.split("/")[2];
  assert.match(
    (await api(page, "read_page", { page_id: plainId })).blocks[0].markdown,
    /Written and saved without reopening/,
  );
  // A rejected local draft remains discardable; delayed registration cannot resurrect it.
  await page.getByRole("link", { name: "Pages", exact: true }).click();
  await page.route("**/api/pages/register", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "This prototype permits 100 pages per account" }),
    }),
  );
  await page.getByRole("button", { name: "New Page", exact: true }).click();
  await expect(page.locator(".ProseMirror")).toBeFocused();
  const rejectedId = new URL(page.url()).pathname.split("/")[2];
  await page.getByLabel("Document actions", { exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(origin + "/");
  await expect(page.locator('a.page-card[href="/p/' + rejectedId + '"]')).toHaveCount(0);
  await page.unroute("**/api/pages/register");
  // Losing and renewing the same account refreshes the current home route.
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ identity: null, canWrite: false }),
    }),
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("link", { name: "Sign In", exact: true })).toBeVisible();
  await page.unroute("**/api/auth/session");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator('a.page-card[href="/p/' + plainId + '"]')).toBeVisible();
  // Deletion in one tab must survive the other tab's final local checkpoint.
  await page.locator('a.page-card[href="/p/' + plainId + '"]').click();
  await peer.goto(plainUrl);
  await expect(peer.locator(".ProseMirror")).toHaveText("Written and saved without reopening.");
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.getByLabel("Document actions", { exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(origin + "/");
  await expect(peer.getByRole("status")).toHaveText("Deleted", { timeout: 20000 });
  await peer.getByRole("link", { name: "Pages", exact: true }).click();
  await expect(peer.locator('a.page-card[href="/p/' + plainId + '"]')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('a.page-card[href="/p/' + plainId + '"]')).toHaveCount(0);
  // Missing routes remain visible instead of silently displaying an unrelated document.
  await peer.goto(origin + "/p/not-a-page");
  await expect(peer.getByRole("alert")).toContainText("not valid");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      page_id: id,
      url,
      editable_ms_with_registration_held: editableMs,
      checks: [
        "editing before registration",
        "pending local recovery after navigation/reload",
        "Back and Forward",
        "one registration across retries",
        "direct-link OIDC return",
        "legacy route and delayed catalog",
        "two-peer sync",
        "first-session save and transient receipt retry",
        "discard rejected local draft",
        "account renewal refreshes route",
        "cross-tab deletion stays deleted",
        "invalid link feedback",
      ],
    }),
  );
} catch (error) {
  for (const context of browser.contexts())
    for (const page of context.pages())
      console.error("Page:", await page.locator("body").innerText());
  console.error("Browser errors:", errors);
  throw error;
} finally {
  await browser.close();
}
