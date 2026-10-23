// Three distinct local OIDC accounts exercise the real Worker and native sockets.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
const origin = process.env.PAGES_ORIGIN || "http://localhost:9895";
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-sharing-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = { completed: [], errors: [] };
let pageId, owner, editor, viewer;
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
async function tool(page, operation, args = {}) {
  return api(page, "/api/tools", { operation, arguments: args });
}
async function access(action) {
  const current = await api(owner, `/api/access?page=${pageId}`);
  assert.equal(current.status, 200);
  return api(owner, `/api/access?page=${pageId}`, {
    ...action,
    expected_revision: current.body.access.revision,
    idempotency_key: crypto.randomUUID(),
  });
}
const content = (page) => page.locator("wg-content");
try {
  const people = [];
  for (const email of ["dev@localhost", "alice@localhost", "bob@localhost"]) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("pageerror", (error) => report.errors.push(error.message));
    // Pick a fixture at the local issuer without bypassing PKCE/state/session checks.
    const begin = await ctx.request.get(`${origin}/api/auth/login`, { maxRedirects: 0 });
    assert.equal(begin.status(), 302);
    const authorize = new URL(begin.headers().location);
    authorize.searchParams.set("login_hint", email);
    await page.goto(authorize.href, { waitUntil: "domcontentloaded", timeout: 60000 });
    await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
      timeout: 60000,
    });
    people.push(page);
  }
  [owner, editor, viewer] = people;
  const identities = await Promise.all(
    [owner, editor, viewer].map((page) => api(page, "/api/auth/session")),
  );
  assert.equal(new Set(identities.map((r) => r.body.identity.principal)).size, 3);
  const created = await tool(owner, "create_page", {
    title: "Sharing fixture " + Date.now(),
    markdown: "A shared garden.",
    idempotency_key: crypto.randomUUID(),
  });
  pageId = created.body.page_id;
  report.pageId = pageId;
  assert.equal(created.status, 200);
  assert.equal((await api(editor, `/api/connect?page=${pageId}`)).status, 403);
  assert.equal((await api(viewer, `/api/connect?page=${pageId}`)).status, 403);
  await owner.goto(`${origin}/p/${pageId}`);
  await expect(content(owner)).toContainText("shared garden");
  await owner.getByRole("button", { name: "Share", exact: true }).click();
  await expect(
    owner.getByRole("dialog", { name: "Share Page" }).getByLabel("Invite by email"),
  ).toBeVisible();
  await owner.getByLabel("Invite by email").fill("alice@localhost");
  await owner.getByLabel("Access", { exact: true }).selectOption("editor");
  await owner.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(owner.getByText("alice@localhost", { exact: true })).toBeVisible();
  await owner.screenshot({ path: `${output}/sharing-wide.png` });
  assert.equal(
    (await access({ action: "invite", email: "bob@localhost", role: "viewer" })).status,
    200,
  );
  await editor.goto(`${origin}/p/${pageId}`);
  await viewer.goto(`${origin}/p/${pageId}`);
  await expect(content(editor)).toContainText("shared garden");
  await expect(content(viewer)).toContainText("shared garden");
  const editorAccess = await api(editor, `/api/connect?page=${pageId}`),
    viewerAccess = await api(viewer, `/api/connect?page=${pageId}`);
  assert.equal(editorAccess.body.access.role, "editor");
  assert.equal(viewerAccess.body.access.role, "viewer");
  await expect(content(editor)).toHaveAttribute("contenteditable", "true");
  await expect(content(viewer)).not.toHaveAttribute("contenteditable", "true");
  report.completed.push(
    "Distinct OIDC accounts; private defaults; owner invite UI; viewer/editor admission",
  );
  const denied = {
    action: "set_role",
    principal: identities[2].body.identity.principal,
    role: "editor",
    expected_revision: viewerAccess.body.access.revision,
    idempotency_key: crypto.randomUUID(),
  };
  assert.equal((await api(editor, `/api/access?page=${pageId}`, denied)).status, 403);
  assert.equal((await api(viewer, `/api/access?page=${pageId}`, denied)).status, 403);
  const read = (await tool(owner, "read_page", { page_id: pageId })).body;
  assert.equal(
    (
      await tool(viewer, "edit_page", {
        page_id: pageId,
        base_heads: read.heads,
        idempotency_key: crypto.randomUUID(),
        operations: [],
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await tool(editor, "delete_page", {
        page_id: pageId,
        base_heads: read.heads,
        idempotency_key: crypto.randomUUID(),
      })
    ).status,
    403,
  );
  report.completed.push(
    "Viewer writes, collaborator ACL changes, and editor deletion rejected server-side",
  );
  await content(editor).focus();
  await editor.keyboard.press("ControlOrMeta+End");
  await editor.keyboard.insertText(" Alice writes.");
  await expect(content(owner)).toContainText("Alice writes.");
  await expect(content(viewer)).toContainText("Alice writes.");
  await expect
    .poll(async () => JSON.stringify((await tool(owner, "read_page", { page_id: pageId })).body))
    .toContain("Alice writes.");
  const listed = await tool(editor, "list_pages");
  assert.ok(listed.body.pages.some((p) => p.page_id === pageId));
  report.completed.push("Editor native deltas fan out to owner/viewer and shared catalog");
  await viewer.reload();
  await expect(content(viewer)).toContainText("Alice writes.");
  await content(editor).focus();
  await editor.keyboard.press("ControlOrMeta+End");
  await editor.keyboard.insertText(" After viewer reload.");
  await expect(content(viewer)).toContainText("After viewer reload.");
  await expect(content(owner)).toContainText("After viewer reload.");
  report.completed.push("Cached viewer reopen receives subsequent native deltas");
  await expect(editor.getByRole("status").filter({ hasText: /Saved/ }).first()).toBeVisible();
  assert.equal(
    (
      await access({
        action: "set_role",
        principal: identities[1].body.identity.principal,
        role: "viewer",
      })
    ).status,
    200,
  );
  await expect(content(editor)).not.toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  report.completed.push("Open native writer downgraded without re-login");
  assert.equal(
    (
      await access({
        action: "set_role",
        principal: identities[1].body.identity.principal,
        role: "editor",
      })
    ).status,
    200,
  );
  await expect(content(editor)).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  await content(editor).focus();
  await editor.keyboard.press("ControlOrMeta+End");
  await editor.keyboard.insertText(" New grant writes.");
  await expect(content(owner)).toContainText("New grant writes.");
  await expect(content(viewer)).toContainText("New grant writes.");
  report.completed.push("Regrant uses a fresh native signer and delivers edits");
  assert.equal(
    (
      await access({
        action: "set_role",
        principal: identities[2].body.identity.principal,
        role: null,
      })
    ).status,
    200,
  );
  await expect(viewer.getByText(/no longer have access/i).first()).toBeVisible({ timeout: 15000 });
  assert.equal((await tool(viewer, "read_page", { page_id: pageId })).status, 403);
  assert.ok(!(await tool(viewer, "list_pages")).body.pages.some((p) => p.page_id === pageId));
  report.completed.push("Revocation closes live access; read and catalog no longer expose Page");
  await owner.setViewportSize({ width: 390, height: 844 });
  if (!(await owner.getByRole("dialog", { name: "Share Page" }).isVisible()))
    await owner.getByRole("button", { name: "Share", exact: true }).click();
  await owner.screenshot({ path: `${output}/sharing-mobile.png` });
  assert.equal(
    await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  report.completed.push("Narrow sharing panel has no document overflow");
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.message;
  for (const [name, page] of [
    ["owner", owner],
    ["editor", editor],
    ["viewer", viewer],
  ])
    if (page) {
      report[name] = await page
        .locator("body")
        .innerText()
        .catch(() => null);
      await page.screenshot({ path: `${output}/failure-${name}.png` }).catch(() => {});
    }
  throw error;
} finally {
  if (pageId && owner) {
    try {
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
}
console.log(JSON.stringify(report, null, 2));
