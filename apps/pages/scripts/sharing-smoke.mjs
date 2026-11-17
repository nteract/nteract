// Three distinct local OIDC accounts exercise the real Worker and native sockets.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { expectPendingInvite } from "./sharing-rows.mjs";
const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
assert.equal(new URL(origin).protocol, "http:");
assert.equal(new URL(origin).origin, origin);
const keys = process.env.PAGES_E2E_KEY_FILE
  ? JSON.parse(await readFile(process.env.PAGES_E2E_KEY_FILE, "utf8"))
  : null;
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
    nonce: crypto.randomUUID(),
  });
}
async function keyRequest(key, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Pages-Driver": "E2E agent",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  return { status: response.status, body: await response.json() };
}
async function mcp(name, operation, args, allowed = true) {
  const response = await keyRequest(keys[name], "/mcp", {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: { name: operation, arguments: args },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.result?.isError === true, !allowed, JSON.stringify(response.body));
  return JSON.parse(response.body.result.content[0].text);
}
async function agentEdit(name, before, after, allowed = true) {
  const read = (await tool(owner, "read_page", { page_id: pageId })).body;
  return mcp(
    name,
    "edit_page",
    {
      page_id: pageId,
      revision: read.revision,
      nonce: crypto.randomUUID(),
      operations: [
        {
          op: "replace_match",
          node_id: read.blocks[0].node_id,
          match_text: before,
          replacement: after,
        },
      ],
    },
    allowed,
  );
}
const content = (page) => page.locator("wg-content");
/** Every `pending` flag this browser's local catalog (viewer/local-catalog.mjs)
 * stores for the Page, read in `page`. */
const storedPending = (page) =>
  page.evaluate(async (pageId) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("pages-local-catalog-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!db.objectStoreNames.contains("bytes")) return [];
      const all = (method) =>
        new Promise((resolve, reject) => {
          const request = db.transaction("bytes").objectStore("bytes")[method]();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const [keys, values] = await Promise.all([all("getAllKeys"), all("getAll")]);
      return keys
        .map((key, i) => [key, JSON.parse(new TextDecoder().decode(values[i]))])
        .filter(([key, record]) => key.startsWith("account/") && record.page_id === pageId)
        .map(([, record]) => !!record.pending);
    } finally {
      db.close();
    }
  }, pageId);
/** The library's rows (list or grid) that open the Page. */
const libraryRows = (page) =>
  page.locator(`.library-view :is(a.index-row-link, a.index-card-link)[href*="${pageId}"]`);
/** A new tab in `person`'s browser whose durability receipts never answer.
 * `receipts()` counts the ones it sent. */
async function heldTab(person) {
  const tab = await person.context().newPage();
  tab.on("pageerror", (error) => report.errors.push(error.message));
  let sent = 0;
  await tab.route("**/api/saved?*", (route) => {
    if (!route.request().url().includes("probe=frontier")) sent++;
  });
  return { tab, receipts: () => sent };
}
/** Open the Page in a tab with its receipts held, then leave it for the
 * library while a receipt is outstanding. Nothing was edited, so the copy
 * is never pending and the library shows the Page once, as the server's row. */
async function leaveUnedited(person) {
  const { tab, receipts } = await heldTab(person);
  await tab.goto(`${origin}/p/${pageId}`);
  await expect(content(tab)).toContainText("shared garden");
  await expect.poll(receipts).toBeGreaterThan(0);
  assert.deepEqual(await storedPending(tab), [false]);
  await tab.goto(`${origin}/`);
  await expect(tab.locator(".library-view")).toBeVisible({ timeout: 30000 });
  await expect(libraryRows(tab)).toHaveCount(1, { timeout: 30000 });
  await expect(tab.getByText("On this device")).toHaveCount(0);
  assert.deepEqual(await storedPending(tab), [false]);
  await tab.close();
}
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
    nonce: crypto.randomUUID(),
  });
  pageId = created.body.page_id;
  report.pageId = pageId;
  assert.equal(created.status, 200);
  assert.equal((await api(editor, `/api/connect?page=${pageId}`)).status, 403);
  assert.equal((await api(viewer, `/api/connect?page=${pageId}`)).status, 403);
  if (keys) {
    for (const [name, index] of [
      ["owner", 0],
      ["editor", 1],
      ["reader", 1],
      ["viewer", 2],
    ]) {
      const session = await keyRequest(keys[name], "/api/auth/session");
      assert.equal(session.status, 200);
      assert.equal(session.body.identity.principal, identities[index].body.identity.principal);
      assert.equal(session.body.canWrite, name !== "reader");
    }
    assert.equal(
      (
        await keyRequest(keys.unscoped, "/mcp", {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await keyRequest(keys.owner + "invalid", "/mcp", {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        })
      ).status,
      401,
    );
    await mcp("editor", "read_page", { page_id: pageId }, false);
    await mcp("viewer", "read_page", { page_id: pageId }, false);
    report.completed.push(
      "Synthetic API keys use verified provider identities; invalid/unscoped keys and private reads denied",
    );
  }
  await owner.goto(`${origin}/p/${pageId}`);
  await expect(content(owner)).toContainText("shared garden");
  await owner.getByRole("button", { name: "Share", exact: true }).click();
  await expect(
    owner.getByRole("dialog", { name: "Share Page" }).getByLabel("Invite by email"),
  ).toBeVisible();
  await owner.getByLabel("Invite by email").fill("alice@localhost");
  await owner.getByLabel("Access", { exact: true }).selectOption("editor");
  await owner.getByRole("button", { name: "Invite", exact: true }).click();
  await expectPendingInvite(
    owner.getByRole("dialog", { name: "Share Page" }),
    "alice@localhost",
    "editor",
  );
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
  // The owner's and the viewer's open tabs stay open beside these.
  await leaveUnedited(viewer);
  await leaveUnedited(owner);
  {
    // An owner edit in a tab that ends before its receipt lands. Only that
    // tab holds the Page, so no other session acknowledges the edit first.
    await owner.goto(`${origin}/`);
    const { tab, receipts } = await heldTab(owner);
    await tab.goto(`${origin}/p/${pageId}`);
    await expect(content(tab)).toContainText("shared garden");
    await expect.poll(receipts).toBeGreaterThan(0);
    const before = receipts();
    await content(tab).focus();
    await tab.keyboard.press("ControlOrMeta+End");
    await tab.keyboard.insertText(" Typed before the tab ended.");
    await expect.poll(receipts).toBeGreaterThan(before);
    // The mark is stored at edit time, before the receipt goes out.
    await expect.poll(() => storedPending(tab)).toEqual([true]);
    // End the tab with its receipt still out: crash the renderer, as
    // Playwright's own Chromium tests do. Where no crash event arrives,
    // close the tab without its unload handlers.
    const crashed = tab
      .waitForEvent("crash", { timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    void tab.goto("chrome://crash").catch(() => {});
    report.tabEnded = (await crashed) ? "crashed" : "closed";
    if (report.tabEnded === "closed") await tab.close({ runBeforeUnload: false });
    // The held route belongs to that tab alone; drop it so nothing it held
    // outlives the tab.
    await tab.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    const next = await owner.context().newPage();
    next.on("pageerror", (error) => report.errors.push(error.message));
    await next.goto(`${origin}/`);
    await expect(next.locator(".library-view")).toBeVisible({ timeout: 30000 });
    assert.deepEqual(await storedPending(next), [true]);
    await expect(libraryRows(next)).toHaveCount(1, { timeout: 30000 });
    // Reopened, the edit reaches the host and the copy is clean again.
    await next.goto(`${origin}/p/${pageId}`);
    await expect(content(next)).toContainText("Typed before the tab ended.");
    await expect(next.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({
      timeout: 30000,
    });
    await expect.poll(() => storedPending(next)).toEqual([false]);
    await next.close();
    await tab.close().catch(() => {});
    await owner.goto(`${origin}/p/${pageId}`);
    await expect(content(owner)).toContainText("Typed before the tab ended.");
    await expect(content(viewer)).toContainText("Typed before the tab ended.");
  }
  report.completed.push(
    "Unedited copies never pending; an edit stays marked pending past a tab that ends before its receipt, until reopened",
  );
  const denied = {
    action: "set_role",
    principal: identities[2].body.identity.principal,
    role: "editor",
    expected_revision: viewerAccess.body.access.revision,
    nonce: crypto.randomUUID(),
  };
  assert.equal((await api(editor, `/api/access?page=${pageId}`, denied)).status, 403);
  assert.equal((await api(viewer, `/api/access?page=${pageId}`, denied)).status, 403);
  const read = (await tool(owner, "read_page", { page_id: pageId })).body;
  assert.equal(
    (
      await tool(viewer, "edit_page", {
        page_id: pageId,
        revision: read.revision,
        nonce: crypto.randomUUID(),
        operations: [],
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await tool(editor, "delete_page", {
        page_id: pageId,
        revision: read.revision,
        nonce: crypto.randomUUID(),
      })
    ).status,
    403,
  );
  report.completed.push(
    "Viewer writes, collaborator ACL changes, and editor deletion rejected server-side",
  );
  if (keys) {
    assert.equal((await mcp("reader", "read_page", { page_id: pageId })).page_id, pageId);
    await agentEdit("reader", "shared garden", "should not write", false);
    await agentEdit("viewer", "shared garden", "should not write", false);
    await agentEdit("editor", "shared garden", "shared garden for people and agents");
    await expect(content(owner)).toContainText("people and agents");
    await expect(content(editor)).toContainText("people and agents");
    await expect(content(viewer)).toContainText("people and agents");
    report.completed.push(
      "MCP edits reach all live browsers; credential scopes and Page role both limit writes",
    );
  }
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
  if (keys) await agentEdit("editor", "shared garden", "should not write", false);
  report.completed.push("Open native writer downgraded without re-login; MCP write denied too");
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
        role: "editor",
      })
    ).status,
    200,
  );
  await expect(content(viewer)).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  if (keys) {
    await agentEdit("viewer", "shared garden", "collaborative garden");
    await expect(content(owner)).toContainText("collaborative garden");
    await expect(content(editor)).toContainText("collaborative garden");
    await expect(content(viewer)).toContainText("collaborative garden");
  }
  report.completed.push(
    "Initially read-only person promoted to editor; existing API key gains Page write access",
  );
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
  if (keys) {
    await mcp("viewer", "read_page", { page_id: pageId }, false);
    assert.equal((await keyRequest(keys.viewer, `/api/connect?page=${pageId}`)).status, 403);
    assert.ok(!(await mcp("viewer", "list_pages", {})).pages.some((p) => p.page_id === pageId));
  }
  await viewer.reload();
  await expect(content(viewer)).toHaveCount(0);
  assert.equal((await api(viewer, `/api/connect?page=${pageId}`)).status, 403);
  report.completed.push(
    "Revocation closes browser/MCP access; reload and fresh connection remain denied",
  );
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
        revision: r.body.revision,
        nonce: crypto.randomUUID(),
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
