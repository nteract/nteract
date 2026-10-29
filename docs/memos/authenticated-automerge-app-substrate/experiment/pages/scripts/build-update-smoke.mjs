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

const content = (page) => page.locator("wg-content");
const saved = (page) => page.locator(".save-status--saved");
const banner = (page) => page.locator(".build-update");

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
  const created = await tool(owner, "create_page", {
    title: `Deploy fixture ${Date.now()}`,
    markdown: "Deploy garden.",
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(created.status, 200);
  pageId = report.pageId = created.body.page_id;
  await owner.goto(`${origin}/p/${pageId}`);
  await expect(content(owner)).toContainText("Deploy garden.");
  await content(owner).focus();
  await owner.keyboard.press("ControlOrMeta+End");
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
    "Pages was updated. Reload to get the latest version.",
    { timeout: 60000 },
  );
  await expect(banner(owner)).toHaveAttribute("role", "status");
  await owner.screenshot({ path: `${output}/update-banner.png` });
  // An optional update never pauses editing.
  await expect(content(owner)).toHaveAttribute("contenteditable", "true");
  await owner.keyboard.insertText(" After banner.");
  await reloadFromBanner(owner);
  await expect(content(owner)).toContainText("Before deploy. During deploy. After banner.", {
    timeout: 30000,
  });
  await expect(banner(owner)).toHaveCount(0);
  assert.equal((await api(owner, "/health")).body.build, buildB);
  const afterUpdate = await tool(owner, "read_page", { page_id: pageId });
  assert.match(JSON.stringify(afterUpdate.body), /Before deploy\. During deploy\. After banner\./);
  report.completed.push(
    `Deploy to ${buildB} under an open tab: banner on reconnect, Reload saved every edit first`,
  );

  // The Worker raises its protocol floor above this viewer: edits pause, what
  // the tab already accepted still saves, and Reload restores editing.
  await expect(content(owner)).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
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
  await content(owner).focus();
  await owner.keyboard.press("ControlOrMeta+End");
  await owner.keyboard.insertText(" Floor raised.");
  await expect(banner(owner)).toContainText("This tab can't edit until you reload.", {
    timeout: 30000,
  });
  await expect(banner(owner)).toHaveAttribute("role", "alert");
  await owner.screenshot({ path: `${output}/required-banner.png` });
  await expect(content(owner)).toHaveAttribute("contenteditable", "false");
  await expect(owner.getByRole("textbox", { name: "Page title" })).toHaveAttribute("readonly", "");
  await expect(saved(owner)).toBeVisible({ timeout: 30000 });
  await content(owner).click();
  await owner.keyboard.insertText(" Ignored.");
  await expect(content(owner)).not.toContainText("Ignored.");
  await owner.unrouteAll({ behavior: "wait" });
  await reloadFromBanner(owner);
  await expect(content(owner)).toContainText("After banner. Floor raised.", { timeout: 30000 });
  await expect(content(owner)).not.toContainText("Ignored.");
  await expect(banner(owner)).toHaveCount(0);
  await expect(content(owner)).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  const afterFloor = await tool(owner, "read_page", { page_id: pageId });
  assert.match(JSON.stringify(afterFloor.body), /After banner\. Floor raised\./);
  assert.doesNotMatch(JSON.stringify(afterFloor.body), /Ignored/);
  report.completed.push(
    "Protocol floor above the viewer: edits paused, accepted edit saved, Reload resumed editing",
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
