// Deploy-while-open qualification against an isolated local celld.
// Run through `node scripts/local-sharing-e2e.mjs --build-update`. The harness
// owns celld and, on request over IPC, restarts it with the Worker and viewer
// assets moved to another build id: a deploy under an open tab.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
assert.equal(new URL(origin).protocol, "http:");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-build-update-browser";
await mkdir(output, { recursive: true });
assert.equal(typeof process.send, "function", "run through local-sharing-e2e.mjs --build-update");

const report = { completed: [], errors: [] };
const browser = await chromium.launch({ headless: true });
let owner, pageId;

function deploy(build) {
  return new Promise((resolve, reject) => {
    const listener = (message) => {
      if (message?.type === "celld-restarted") resolve();
      else if (message?.type === "celld-restart-failed") reject(new Error(message.message));
      else return;
      process.off("message", listener);
    };
    process.on("message", listener);
    process.send({ type: "restart-celld", build });
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
      return {
        status: response.status,
        build: response.headers.get("X-Pages-Build"),
        minViewerProtocol: response.headers.get("X-Pages-Min-Viewer-Protocol"),
        body: await response.json(),
      };
    },
    { path, body },
  );
}
const tool = (page, operation, args = {}) =>
  api(page, "/api/tools", { operation, arguments: args });
async function signIn(email) {
  const context = await browser.newContext();
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
/** Click Reload and wait for the document itself to be replaced. */
async function reloadFromBanner(page) {
  await page.evaluate(() => {
    window.__pagesBeforeReload = true;
  });
  await page.locator(".build-update").getByRole("button", { name: "Reload" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__pagesBeforeReload ?? false).catch(() => true), {
      timeout: 30000,
    })
    .toBe(false);
  await page.waitForLoadState("domcontentloaded");
}

const content = (page) => page.locator(".page-block wg-content");
const saved = (page) => page.locator(".save-status--saved");
const banner = (page) => page.locator(".build-update");
/** Focus the Page text with the caret after its last character.
 *
 * focus() puts the DOM caret at the start, and Wordgard reads that caret on its
 * next animation frame. A key pressed before then acts on Wordgard's own
 * selection, which sits at the end when the text arrived after the editor
 * mounted, so Mod-End does nothing and typed text lands at the DOM caret. Wait
 * a frame before the key, then wait for the DOM caret to reach the end. */
async function caretToEnd(page) {
  await content(page).focus();
  await expect(async () => {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.keyboard.press("ControlOrMeta+End");
    await expect
      .poll(
        () =>
          content(page).evaluate((root) => {
            const selection = getSelection();
            if (!selection?.isCollapsed || !root.contains(selection.focusNode)) return false;
            const after = document.createRange();
            after.selectNodeContents(root);
            after.setStart(selection.focusNode, selection.focusOffset);
            return after.toString() === "";
          }),
        { timeout: 2000 },
      )
      .toBe(true);
  }).toPass({ timeout: 15000 });
}

try {
  owner = await signIn("dev@localhost");

  // Build A: the Worker and the viewer agree, so the tab stays quiet.
  const health = await api(owner, "/health");
  const buildA = health.body.build;
  assert.match(buildA, /^[0-9a-f]{12}$/);
  assert.equal(health.build, buildA);
  assert.equal(health.body.minViewerProtocol, 1);
  const session = await api(owner, "/api/auth/session");
  assert.equal(session.build, buildA);
  assert.equal(session.minViewerProtocol, "1");
  const viewerSource = await (await fetch(`${origin}/app.js`)).text();
  assert.ok(viewerSource.includes(JSON.stringify(buildA)), "viewer embeds the Worker's build");
  const title = `Deploy fixture ${Date.now()}`;
  const created = await tool(owner, "create_page", {
    title,
    markdown: "Deploy garden.",
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(created.status, 200);
  pageId = report.pageId = created.body.page_id;
  await owner.goto(`${origin}/p/${pageId}`);
  await expect(content(owner)).toContainText("Deploy garden.");
  await caretToEnd(owner);
  await owner.keyboard.insertText(" Before deploy.");
  await expect(saved(owner)).toBeVisible({ timeout: 30000 });
  await expect(banner(owner)).toHaveCount(0);
  report.completed.push(`Same build ${buildA}: /health, headers and viewer agree; no banner`);

  // Build B lands while the tab is open and an edit is in flight. The
  // reconnect's /api/connect response carries the new build.
  const buildB = buildA === "b".repeat(12) ? "c".repeat(12) : "b".repeat(12);
  const deployed = deploy(buildB);
  await expect(saved(owner)).toHaveCount(0, { timeout: 30000 });
  await owner.keyboard.insertText(" During deploy.");
  await deployed;
  await expect(banner(owner)).toContainText(
    "Pages changed on the server. Reload to use the current version.",
    { timeout: 60000 },
  );
  await expect(banner(owner)).toHaveAttribute("role", "status");
  await owner.screenshot({ path: `${output}/update-banner.png` });
  // An optional update never pauses editing.
  await expect(content(owner)).toHaveAttribute("contenteditable", "true");

  // Leave the Page while receipts fail. After the drain it closes with its
  // IndexedDB checkpoint and the tab keeps only its title. Reload names it and
  // asks first; Open brings the checkpoint back and it syncs.
  await owner.route("**/api/saved?*", (route) => route.abort());
  await owner.keyboard.insertText(" Checkpointed.");
  await owner.getByRole("link", { name: "Pages", exact: true }).click();
  await expect(owner.getByRole("heading", { name: "Your pages" })).toBeVisible();
  await owner.evaluate(() => {
    window.__pagesBeforeReload = true;
  });
  await banner(owner).getByRole("button", { name: "Reload" }).click();
  await expect(banner(owner)).toContainText(
    `Edits on ${title} haven't reached the server yet. They're saved in this browser and sync when you open that Page again.`,
    { timeout: 30000 },
  );
  await expect(banner(owner).getByRole("button", { name: "Reload anyway" })).toBeVisible();
  assert.equal(await owner.evaluate(() => window.__pagesBeforeReload), true, "no reload");
  await owner.screenshot({ path: `${output}/checkpointed-confirm.png` });
  await owner.unrouteAll({ behavior: "wait" });
  await banner(owner)
    .getByRole("button", { name: `Open ${title}` })
    .click();
  await expect(content(owner)).toContainText("During deploy. Checkpointed.", { timeout: 30000 });
  await expect(saved(owner)).toBeVisible({ timeout: 30000 });
  await expect(banner(owner).getByRole("button", { name: "Reload", exact: true })).toBeVisible();
  report.completed.push(
    "Left a Page without its receipt: Reload named it and asked first; Open restored the checkpoint and saved it",
  );
  await caretToEnd(owner);

  // Leave the Page while its receipt is in flight, then Reload from the
  // library. The left Page keeps syncing, and Reload waits for its receipt.
  const receipts = { inFlight: 0, fulfilledAt: 0 };
  await owner.route("**/api/saved?*", async (route) => {
    receipts.inFlight++;
    try {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 4000));
      await route.fulfill({ response });
      receipts.fulfilledAt = Date.now();
    } finally {
      receipts.inFlight--;
    }
  });
  await owner.keyboard.insertText(" After banner.");
  await owner.getByRole("link", { name: "Pages", exact: true }).click();
  await expect(owner.getByRole("heading", { name: "Your pages" })).toBeVisible();
  await expect.poll(() => receipts.inFlight, { timeout: 15000 }).toBeGreaterThan(0);
  let loadedAt = 0;
  owner.once("load", () => {
    loadedAt = Date.now();
  });
  const leftReload = reloadFromBanner(owner);
  await expect(banner(owner).getByRole("button", { name: "Saving edits…" })).toBeVisible();
  await leftReload;
  assert.ok(
    receipts.fulfilledAt > 0 && loadedAt >= receipts.fulfilledAt,
    JSON.stringify({ ...receipts, loadedAt }),
  );
  await owner.unrouteAll({ behavior: "wait" });
  await expect(banner(owner)).toHaveCount(0);
  await owner.goto(`${origin}/p/${pageId}`);
  await expect(content(owner)).toContainText(
    "Before deploy. During deploy. Checkpointed. After banner.",
    {
      timeout: 30000,
    },
  );
  assert.equal((await api(owner, "/health")).body.build, buildB);
  const afterUpdate = await tool(owner, "read_page", { page_id: pageId });
  assert.match(
    JSON.stringify(afterUpdate.body),
    /Before deploy\. During deploy\. Checkpointed\. After banner\./,
  );
  report.completed.push(
    `Deploy to ${buildB} under an open tab: banner on reconnect; Reload after leaving the Page waited for its receipt`,
  );

  // An unsent reply, then the Worker raises its protocol floor above this
  // viewer: edits pause, the draft stays reachable, Reload refuses until the
  // draft is discarded, and what the tab already accepted still saves.
  const authority = (await tool(owner, "read_page", { page_id: pageId })).body;
  const comment = await tool(owner, "manage_page_comment", {
    page_id: pageId,
    action: "add",
    block_id: authority.blocks[0].id,
    body: "Deploy thread",
    body_format: "plain",
    base_heads: authority.heads,
    retry_token: authority.retry_token,
    idempotency_key: authority.retry_key_prefix + crypto.randomUUID(),
  });
  assert.equal(comment.status, 200, JSON.stringify(comment.body));
  await owner.getByRole("button", { name: /^Comments/ }).click();
  const thread = owner.locator(".thread", { hasText: "Deploy thread" });
  await thread.getByRole("button", { name: "Reply", exact: true }).click();
  const reply = thread.getByRole("textbox", { name: "Reply", exact: true });
  await expect(reply).toBeFocused();
  await reply.pressSequentially("Unsent reply");
  await expect(content(owner)).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  await caretToEnd(owner);
  await owner.route(
    (url) => url.pathname.startsWith("/api/") || url.pathname === "/health",
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), "x-pages-min-viewer-protocol": "999" },
      });
    },
  );
  await owner.keyboard.insertText(" Floor raised.");
  await expect(banner(owner)).toContainText(
    "Pages changed on the server. This tab can't edit until you reload.",
    { timeout: 30000 },
  );
  await expect(banner(owner)).toHaveAttribute("role", "alert");
  await expect(content(owner)).toHaveAttribute("contenteditable", "false");
  await expect(owner.getByRole("textbox", { name: "Page title" })).toHaveAttribute("readonly", "");
  await expect(saved(owner)).toBeVisible({ timeout: 30000 });
  await content(owner).click();
  await owner.keyboard.insertText(" Ignored.");
  await expect(content(owner)).not.toContainText("Ignored.");
  // The draft stays visible and read-only; it can't be sent from this tab.
  await expect(reply).toContainText("Unsent reply");
  await expect(reply).toHaveAttribute("contenteditable", "false");
  await expect(thread.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await owner.screenshot({ path: `${output}/required-banner.png` });
  await owner.evaluate(() => {
    window.__pagesBeforeReload = true;
  });
  await banner(owner).getByRole("button", { name: "Reload" }).click();
  await expect(banner(owner)).toContainText(
    "You have an unsent comment. Send or discard it before reloading.",
  );
  assert.equal(await owner.evaluate(() => window.__pagesBeforeReload), true, "no reload");
  await thread.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(thread.getByRole("button", { name: /^(Continue reply|Reply)$/ })).toHaveCount(0);
  await owner.unrouteAll({ behavior: "wait" });
  await reloadFromBanner(owner);
  await expect(content(owner)).toContainText("After banner. Floor raised.", { timeout: 30000 });
  await expect(content(owner)).not.toContainText("Ignored.");
  await expect(banner(owner)).toHaveCount(0);
  await expect(content(owner)).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  const afterFloor = await tool(owner, "read_page", { page_id: pageId });
  assert.match(JSON.stringify(afterFloor.body), /After banner\. Floor raised\./);
  assert.doesNotMatch(JSON.stringify(afterFloor.body), /Ignored|Unsent reply/);
  report.completed.push(
    "Protocol floor above the viewer: edits paused, unsent reply kept read-only and blocked Reload until discarded, accepted edit saved",
  );
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.message;
  if (owner) {
    report.owner = await owner
      .locator("body")
      .innerText()
      .catch(() => null);
    await owner.screenshot({ path: `${output}/failure-owner.png` }).catch(() => {});
  }
  throw error;
} finally {
  if (pageId && owner) {
    try {
      await owner.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
      const r = await tool(owner, "read_page", { page_id: pageId });
      const d = await tool(owner, "delete_page", {
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
