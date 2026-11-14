// Run against the loopback OIDC fixture only. Intentionally hold registration
// to prove that editing and navigation do not wait for the host to create a Page.
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { PRODUCT_NAME } from "../shared/product.mjs";
const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const browser = await chromium.launch({ headless: true });
const errors = [];
const editor = (page) => page.locator("wg-content").first();
const titleInput = (page) => page.getByRole("textbox", { name: "Page title", exact: true });
const saveStatus = (page) => page.locator(".save-status");
const saved = (page) =>
  expect(page.getByRole("status", { name: "All changes saved", exact: true })).toBeVisible({
    timeout: 20000,
  });
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
  await expect(titleInput(page)).toBeFocused({ timeout: 3000 });
  const titleReadyMs = Math.round(performance.now() - started);
  // An untitled Page has no slug: its address is the bare link.
  await expect(page).toHaveURL(/\/p\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split("/")[2];
  const title = "Local creation " + Date.now();
  await titleInput(page).fill(title);
  // Keys typed straight after Enter belong to the new Page's first block,
  // even though that block doesn't exist until Enter creates it.
  await page.keyboard.press("Enter");
  await page.keyboard.type("Written while registration is held.");
  await expect(editor(page)).toBeFocused({ timeout: 3000 });
  const editableMs = Math.round(performance.now() - started);
  await expect(titleInput(page)).toHaveValue(title);
  await expect(editor(page)).toHaveText("Written while registration is held.");
  // The address takes the title's slug once typing in the title pauses.
  const url = `${origin}/p/${id}/${title.replaceAll(" ", "-")}`;
  await expect(page).toHaveURL(url);
  await expect.poll(() => registrations).toBeGreaterThan(0);
  await expect(saveStatus(page)).not.toHaveText("Saved");
  await page.getByRole("link", { name: PRODUCT_NAME, exact: true }).click();
  await expect(page).toHaveURL(origin + "/");
  await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(url);
  await expect(editor(page)).toHaveText("Written while registration is held.");
  await page.goForward();
  await expect(page).toHaveURL(origin + "/");
  await page.getByRole("link", { name: new RegExp(title) }).click();
  await expect(page).toHaveURL(url);
  await page.reload();
  await expect(editor(page)).toHaveText("Written while registration is held.");
  release();
  await saved(page);
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
  await expect(editor(peer)).toHaveText("Written while registration is held.", {
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
  await expect(editor(peer)).toHaveText("Written while registration is held.");
  releaseCatalog();
  await peer.unroute("**/api/tools");
  // Stable native history still supports simultaneous edits after registration.
  await editor(peer).press("ControlOrMeta+End");
  await editor(peer).pressSequentially(" A second peer joined.");
  await expect(editor(page)).toContainText("A second peer joined.");
  // A new draft must publish edits from its first live session, without a reload.
  await page.getByRole("link", { name: PRODUCT_NAME, exact: true }).click();
  await page.getByRole("button", { name: "New Page", exact: true }).click();
  await expect(titleInput(page)).toBeFocused();
  // An empty Page shows no prompt text: nothing to mistake for the caret's line.
  await expect(page.locator("wg-placeholder")).toHaveCount(0);
  await expect(page.getByText("Write something…")).toHaveCount(0);
  await expect(editor(page)).not.toHaveAttribute("aria-placeholder", /./);
  const plainUrl = page.url();
  await titleInput(page).fill("First session saves");
  await titleInput(page).press("Enter");
  await expect(editor(page)).toBeFocused();
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
  await editor(page).pressSequentially("Written and saved without reopening.");
  await saved(page);
  // Wordgard centers its caret on the caret position, so at the start of a
  // line half of it sits left of the text. The editor's sideways clip must
  // leave it whole.
  await editor(page).press("Home");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const caret = document.querySelector(".page-block wg-cursor.wg-cursor-v");
        const scroller = caret?.closest("wg-scroller");
        if (!caret || getComputedStyle(caret).display === "none") return "no caret";
        const c = caret.getBoundingClientRect(),
          s = scroller.getBoundingClientRect();
        return c.width > 0 && c.left >= s.left && c.right <= s.right ? "whole" : "clipped";
      }),
    )
    .toBe("whole");
  // The continuation target's label shows only under keyboard focus.
  const continuation = page.getByRole("button", { name: "Continue writing", exact: true });
  await expect(continuation.locator(".writing-continuation-label")).toHaveCSS("opacity", "0");
  assert.ok(receiptCalls >= 2, "temporary receipt error retries");
  await page.unroute("**/api/saved?*");
  const plainId = new URL(plainUrl).pathname.split("/")[2];
  assert.match(
    (await api(page, "read_page", { page_id: plainId })).blocks[0].markdown,
    /Written and saved without reopening/,
  );
  // A rejected local draft remains discardable; delayed registration cannot resurrect it.
  await page.getByRole("link", { name: PRODUCT_NAME, exact: true }).click();
  await page.route("**/api/pages/register", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: "This alpha release allows 250 Pages per account.",
        code: "page_quota_exceeded",
        limit: 250,
        count: 250,
      }),
    }),
  );
  await page.getByRole("button", { name: "New Page", exact: true }).click();
  await expect(titleInput(page)).toBeFocused();
  const rejectedId = new URL(page.url()).pathname.split("/")[2];
  await page.getByLabel("Document actions", { exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Move to Trash", exact: true }).click();
  await expect(page).toHaveURL(origin + "/");
  await expect(page.locator(`a.index-row-link[href^="/p/${rejectedId}"]`)).toHaveCount(0);
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
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  await page.unroute("**/api/auth/session");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator(`a.index-row-link[href^="/p/${plainId}"]`)).toBeVisible();
  // Trash in one tab must survive the other tab's final local checkpoint.
  await page.locator(`a.index-row-link[href^="/p/${plainId}"]`).click();
  await peer.goto(plainUrl);
  await expect(editor(peer)).toHaveText("Written and saved without reopening.");
  await saved(page);
  await page.getByLabel("Document actions", { exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Move to Trash", exact: true }).click();
  await expect(page).toHaveURL(origin + "/");
  // An open tab of the owner learns the Page moved to Trash.
  await expect(peer.getByText("This Page is in Trash.")).toBeVisible({ timeout: 20000 });
  await peer.getByRole("link", { name: PRODUCT_NAME, exact: true }).click();
  await expect(peer.locator(`a.index-row-link[href^="/p/${plainId}"]`)).toHaveCount(0);
  await page.reload();
  await expect(page.locator(`a.index-row-link[href^="/p/${plainId}"]`)).toHaveCount(0);
  // A link with any slug opens the same Page. The address takes the Page's
  // own title as its slug, the tab shows that title, and an in-page heading
  // link works.
  const filler = (label) =>
    Array.from({ length: 30 }, (_, i) => `${label} paragraph ${i + 1}.`).join("\n\n");
  const stamp = Date.now();
  const realTitle = "Real title " + stamp;
  const slugged = await api(page, "create_page", {
    title: realTitle,
    nonce: "navigation-" + crypto.randomUUID(),
    markdown: `[Skip to the plan](#the-plan)\n\n${filler("Before")}\n\n## The plan\n\n${filler("After")}`,
  });
  const sluggedUrl = `${origin}/p/${slugged.page_id}/Some-Title`;
  // A visitor with no session, as a link unfurler: the slug's words, never
  // the Page's title, and the same bytes as for a Page that doesn't exist.
  const unfurled = await (await fetch(sluggedUrl)).text();
  assert.match(unfurled, /<title>Some Title · [^<]+<\/title>/);
  assert.match(unfurled, /<meta property="og:title" content="Some Title" \/>/);
  assert.ok(!unfurled.includes(realTitle));
  const nobody = await (await fetch(`${origin}/p/${crypto.randomUUID()}/Some-Title`)).text();
  assert.equal(unfurled, nobody);
  await peer.goto(sluggedUrl);
  await expect(peer.locator("wg-content").first()).toContainText("Skip to the plan", {
    timeout: 20000,
  });
  const titledUrl = `${origin}/p/${slugged.page_id}/Real-title-${stamp}`;
  await expect(peer).toHaveURL(titledUrl);
  await expect(peer).toHaveTitle(new RegExp(`^${realTitle} `));
  await peer.locator("wg-content a", { hasText: "Skip to the plan" }).click();
  const go = peer.getByRole("link", { name: "Go to section" });
  await expect(go).toBeVisible();
  await go.click();
  await expect(peer).toHaveURL(`${titledUrl}#the-plan`);
  await expect(peer.getByRole("heading", { name: "The plan" })).toBeInViewport();
  // A reload at the titled address opens the same Page at the same heading.
  await peer.reload();
  await expect(peer).toHaveURL(`${titledUrl}#the-plan`);
  await expect(editor(peer)).toContainText("Skip to the plan", { timeout: 20000 });
  await expect(peer.getByRole("heading", { name: "The plan" })).toBeInViewport();
  // A rename moves the address in place, keeping the heading it names.
  const renamed = `Renamed: plan ${stamp}`;
  await titleInput(peer).fill(renamed);
  const renamedUrl = `${origin}/p/${slugged.page_id}/Renamed-plan-${stamp}`;
  await expect(peer).toHaveURL(`${renamedUrl}#the-plan`);
  // Copy link carries the title as it is now, without waiting for the address.
  await peerContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const third = `Third name ${stamp}`;
  await titleInput(peer).fill(third);
  await peer.getByLabel("Document actions", { exact: true }).click();
  await peer.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(peer.getByText("Link copied")).toBeVisible();
  const thirdUrl = `${origin}/p/${slugged.page_id}/Third-name-${stamp}`;
  assert.equal(await peer.evaluate(() => navigator.clipboard.readText()), thirdUrl);
  await expect(peer).toHaveURL(`${thirdUrl}#the-plan`);
  // Back and Forward between the library and the titled Page.
  await peer.getByRole("link", { name: PRODUCT_NAME, exact: true }).click();
  await expect(peer).toHaveURL(origin + "/");
  const row = peer.locator(`a.index-row-link[href^="/p/${slugged.page_id}"]`);
  await expect(row).toHaveAttribute("href", `/p/${slugged.page_id}/Third-name-${stamp}`);
  await peer.goBack();
  await expect(peer).toHaveURL(`${thirdUrl}#the-plan`);
  await expect(editor(peer)).toContainText("Skip to the plan");
  await peer.goForward();
  await expect(peer).toHaveURL(origin + "/");
  // A click from the library lands on the titled address at once, well
  // before the address would follow the title on its own.
  await row.click();
  await expect(peer).toHaveURL(thirdUrl, { timeout: 500 });
  await expect(editor(peer)).toContainText("Skip to the plan");
  await peer.goBack();
  await expect(peer).toHaveURL(origin + "/");
  // Out-of-grammar segments are not a Page route.
  await peer.goto(`${origin}/p/${slugged.page_id}/view`);
  await expect(peer.getByRole("alert")).toContainText("not valid");
  // Missing routes remain visible instead of silently displaying an unrelated document.
  await peer.goto(origin + "/p/not-a-page");
  await expect(peer.getByRole("alert")).toContainText("not valid");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      page_id: id,
      url,
      title_ready_ms_with_registration_held: titleReadyMs,
      editable_ms_with_registration_held: editableMs,
      checks: [
        "title-first creation and Enter to the body",
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
        "slugged link: unfurl title, address, tab title, heading link",
        "address follows the title: open, reload, rename, Copy link, Back and Forward, library click",
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
