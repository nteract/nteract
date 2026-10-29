// Local-only company link sharing: browser, native sync, API key and OAuth MCP.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const origin = process.env.PAGES_ORIGIN;
assert.equal(new URL(origin).origin, origin);
assert.equal(new URL(origin).hostname, "localhost");
assert.equal(new URL(origin).protocol, "http:");
const keys = JSON.parse(await readFile(process.env.PAGES_E2E_KEY_FILE, "utf8"));
const output = process.env.PAGES_SCREENSHOTS;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-proxy-server",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
  ],
});
const report = { completed: [], errors: [] };
const complete = (name) => {
  report.completed.push(name);
  console.log(`[Domain E2E] ${name}`);
};
const retry = (read) => {
  assert.equal(typeof read.retry_token, "string");
  assert.equal(typeof read.retry_key_prefix, "string");
  return {
    retry_token: read.retry_token,
    idempotency_key: read.retry_key_prefix + crypto.randomUUID(),
  };
};
const content = (page) => page.locator("wg-content");
const pages = new Map();
let owner, employee, invited, excluded, consumer, pageId, outsiderPageId;
async function api(page, path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(15000),
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
  return result;
}
async function mcp(token, name, args = {}, allowed = true) {
  const response = await fetch(origin + "/mcp", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Pages-Driver": "Domain E2E",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  assert.equal(response.status, 200);
  const result = (await response.json()).result;
  assert.equal(result?.isError === true, !allowed, `${name}: ${JSON.stringify(result)}`);
  return JSON.parse(result.content[0].text);
}
async function denyMcpWrite(token) {
  const read = await mcp(token, "read_page", { page_id: pageId });
  await mcp(
    token,
    "patch_page",
    {
      page_id: pageId,
      base_heads: read.heads,
      ...retry(read),
      operations: [
        {
          op: "replace_match",
          block_id: read.blocks[0].id,
          match_text: "garden",
          replacement: "forbidden",
        },
      ],
    },
    false,
  );
}
async function signIn(email) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  pages.set(email, page);
  page.on("pageerror", (error) => report.errors.push(error.message));
  const begin = await context.request.get(origin + "/api/auth/login", { maxRedirects: 0 });
  assert.equal(begin.status(), 302);
  const authorize = new URL(begin.headers().location);
  authorize.searchParams.set("login_hint", email);
  await page.goto(authorize.href, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 30000,
  });
  return page;
}
async function openSharing() {
  if (!(await owner.getByRole("dialog", { name: "Share Page" }).isVisible())) {
    // Access may already be prefetched; opening a cached panel need not fetch.
    await owner.getByRole("button", { name: "Share", exact: true }).click();
  }
  await expect(owner.getByRole("combobox", { name: "Link access", exact: true })).toBeVisible();
}
async function selectDomain(domain) {
  // Fixture API writes and invite acceptance change ACL revisions outside the
  // owner's UI. Refresh only that browser; viewer/editor sockets stay connected
  // so the live revocation assertions below still exercise existing access.
  await owner.reload();
  await expect(content(owner)).toContainText("shared garden");
  await openSharing();
  await owner.getByRole("combobox", { name: "Link access", exact: true }).selectOption(domain);
  await expect(owner.getByRole("combobox", { name: "Link access", exact: true })).toHaveValue(
    domain,
  );
  await expect(owner.getByRole("combobox", { name: "Link access", exact: true })).toBeEnabled();
  assert.equal(
    (await api(owner, `/api/access?page=${pageId}`)).body.domainView?.domain ?? "",
    domain,
  );
}
async function oauthGrant(page) {
  const verifier = randomBytes(32).toString("base64url");
  const state = crypto.randomUUID();
  const callback = origin + "/oauth/test/callback";
  const authorize = new URL(origin + "/oauth/authorize");
  authorize.search = new URLSearchParams({
    client_id: "pages-local-e2e",
    redirect_uri: callback,
    response_type: "code",
    resource: origin + "/mcp",
    scope: "pages:read pages:write offline_access",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  await page.goto(authorize.href, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Allow access", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Allow access", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/oauth/test/callback");
  const returned = new URL(page.url());
  assert.equal(returned.searchParams.get("state"), state);
  assert.equal(returned.searchParams.get("iss"), origin);
  const response = await fetch(origin + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(15000),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "pages-local-e2e",
      redirect_uri: callback,
      resource: origin + "/mcp",
      code: returned.searchParams.get("code"),
      code_verifier: verifier,
    }),
  });
  assert.equal(response.status, 200);
  const token = await response.json();
  assert.ok(token.scope.split(" ").includes("pages:write"));
  return token.access_token;
}
try {
  owner = await signIn("lead@anaconda.com");
  employee = await signIn("employee@anaconda.com");
  excluded = await signIn("blocked@anaconda.com");
  consumer = await signIn("outsider@gmail.com");
  invited = await signIn("alice@localhost");
  // Establish fixture identities serially; concurrent session-refresh timing is
  // a separate qualification from company-domain authorization.
  const identities = [];
  for (const page of [owner, employee, excluded, consumer, invited])
    identities.push(await api(page, "/api/auth/session"));
  assert.equal(new Set(identities.map((result) => result.body.identity.principal)).size, 5);
  const consumerCatalog = (await tool(consumer, "list_pages")).body;
  const outsider = await tool(consumer, "create_page", {
    title: "Outsider Page",
    markdown: "Not company content.",
    ...retry(consumerCatalog),
  });
  assert.equal(outsider.status, 200);
  outsiderPageId = outsider.body.page_id;
  const outsiderAccess = (await api(consumer, `/api/access?page=${outsiderPageId}`)).body;
  assert.deepEqual(outsiderAccess.domainOptions, []);
  assert.deepEqual(outsiderAccess.domainProof, { "anaconda.com": "missing" });
  assert.equal(outsiderAccess.domainView, null);
  const outsiderDenied = await api(consumer, `/api/access?page=${outsiderPageId}`, {
    action: "set_domain_view",
    domain: "anaconda.com",
    expected_revision: outsiderAccess.access.revision,
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(outsiderDenied.status, 403);
  assert.match(outsiderDenied.body.error, /verified anaconda\.com email/);
  assert.equal(outsiderDenied.body.code, "company_email_proof_required");
  await consumer.goto(`${origin}/p/${outsiderPageId}`);
  await expect(content(consumer)).toContainText("Not company content");
  await consumer.getByRole("button", { name: "Share", exact: true }).click();
  // The owner row appears only after the owner's access ledger has loaded.
  await expect(
    consumer
      .getByRole("dialog", { name: "Share Page" })
      .getByText("Owner", { exact: true })
      .first(),
  ).toBeVisible();
  assert.equal(
    await consumer.getByRole("combobox", { name: "Link access", exact: true }).count(),
    0,
  );
  assert.equal((await api(employee, `/api/connect?page=${outsiderPageId}`)).status, 403);
  complete("Consumer owner is offered no company audience and cannot set one");
  const catalog = (await tool(owner, "list_pages")).body;
  const created = await tool(owner, "create_page", {
    title: "Company link sharing",
    markdown: "A shared garden.",
    ...retry(catalog),
  });
  assert.equal(created.status, 200);
  pageId = created.body.page_id;
  for (const page of [employee, excluded, consumer, invited])
    assert.equal((await api(page, `/api/connect?page=${pageId}`)).status, 403);
  await owner.goto(`${origin}/p/${pageId}`);
  await expect(content(owner)).toContainText("shared garden");
  await openSharing();
  await expect(owner.getByRole("combobox", { name: "Link access", exact: true })).toHaveValue("");
  const options = await owner
    .getByRole("combobox", { name: "Link access", exact: true })
    .locator("option")
    .allTextContents();
  assert.deepEqual(options, ["Restricted", "Anyone at anaconda.com with the link"]);
  const initial = (await api(owner, `/api/access?page=${pageId}`)).body;
  assert.deepEqual(initial.domainOptions, ["anaconda.com"]);
  assert.deepEqual(initial.domainProof, { "anaconda.com": "verified" });
  assert.equal(initial.domainView, null);
  complete("Company owner sees only their verified company option; new Page stays Restricted");
  await owner.getByLabel("Invite by email").fill("alice@localhost");
  await owner.getByLabel("Access", { exact: true }).selectOption("editor");
  await owner.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(owner.getByText("alice@localhost", { exact: true })).toBeVisible();
  assert.equal(
    (await access({ action: "invite", email: "pending@example.org", role: "viewer" })).status,
    200,
  );
  const before = (await api(owner, `/api/access?page=${pageId}`)).body;
  assert.equal(before.invites.length, 2);
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
  await selectDomain("anaconda.com");
  const enabled = (await api(owner, `/api/access?page=${pageId}`)).body;
  assert.deepEqual(enabled.invites, before.invites);
  assert.equal((await access({ action: "set_domain_view", domain: "gmail.com" })).status, 400);
  assert.equal((await access({ action: "set_domain_view", domain: "example.org" })).status, 400);
  await owner.screenshot({ path: `${output}/domain-sharing-wide.png` });
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.screenshot({ path: `${output}/domain-sharing-narrow.png` });
  assert.equal(
    await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await owner.setViewportSize({ width: 1280, height: 900 });
  complete(
    "Owner enables company viewing in UI; pending invitations survive; consumer/unconfigured domains rejected",
  );
  await employee.goto(`${origin}/p/${pageId}`);
  await expect(content(employee)).toContainText("shared garden");
  await expect(content(employee)).not.toHaveAttribute("contenteditable", "true");
  const viewerAccess = (await api(employee, `/api/connect?page=${pageId}`)).body.access;
  assert.equal(viewerAccess.role, "viewer");
  assert.equal(viewerAccess.canWrite, false);
  assert.equal(viewerAccess.canManageAccess, false);
  for (const page of [excluded, consumer])
    assert.equal((await api(page, `/api/connect?page=${pageId}`)).status, 403);
  await mcp(keys.employee, "read_page", { page_id: pageId });
  await denyMcpWrite(keys.employee);
  await mcp(keys.blockedEmployee, "read_page", { page_id: pageId }, false);
  await mcp(keys.consumer, "read_page", { page_id: pageId }, false);
  const memberProjection = (await api(owner, `/api/access?page=${pageId}`)).body;
  assert.ok(
    !memberProjection.members.some(
      (member) => member.principal === identities[1].body.identity.principal,
    ),
  );
  complete(
    "Domain viewer opens native read-only sync and MCP; explicit denial and consumer account stay blocked without member insertion",
  );
  const employeeToken = await oauthGrant(employee);
  await mcp(employeeToken, "read_page", { page_id: pageId });
  await denyMcpWrite(employeeToken);
  await employee.goto(`${origin}/p/${pageId}`);
  await expect(content(employee)).toContainText("shared garden");
  await invited.goto(`${origin}/p/${pageId}`);
  await expect(content(invited)).toHaveAttribute("contenteditable", "true");
  await owner.keyboard.press("Escape");
  await expect(owner.getByRole("dialog", { name: "Share Page" })).not.toBeVisible();
  await content(owner).focus();
  await owner.keyboard.press("ControlOrMeta+End");
  await owner.keyboard.insertText(" Domain viewers receive live changes.");
  await expect(content(employee)).toContainText("Domain viewers receive live changes.");
  await expect(content(invited)).toContainText("Domain viewers receive live changes.");
  complete(
    "Company viewer receives native edits; OAuth write scope cannot exceed domain view role; explicit invite still edits",
  );
  await selectDomain("");
  await expect(employee.getByText(/no longer have access/i).first()).toBeVisible({
    timeout: 15000,
  });
  assert.equal((await api(employee, `/api/connect?page=${pageId}`)).status, 403);
  await mcp(keys.employee, "read_page", { page_id: pageId }, false);
  await mcp(employeeToken, "read_page", { page_id: pageId }, false);
  await expect(content(invited)).toHaveAttribute("contenteditable", "true");
  await content(invited).focus();
  await invited.keyboard.press("ControlOrMeta+End");
  await invited.keyboard.insertText(" Explicit editor remains.");
  await expect(content(owner)).toContainText("Explicit editor remains.");
  const disabled = (await api(owner, `/api/access?page=${pageId}`)).body;
  assert.equal(disabled.domainView, null);
  assert.ok(
    disabled.members.some(
      (member) =>
        member.principal === identities[4].body.identity.principal && member.role === "editor",
    ),
  );
  assert.deepEqual(
    disabled.invites,
    before.invites.filter((invite) => invite.email === "pending@example.org"),
  );
  complete(
    "Turning company viewing off closes active native access and denies existing MCP/OAuth grants; explicit editor and pending invite preserved",
  );
  await selectDomain("anaconda.com");
  await employee.reload();
  await expect(content(employee)).toContainText("Explicit editor remains.");
  await expect(content(employee)).not.toHaveAttribute("contenteditable", "true");
  await mcp(employeeToken, "read_page", { page_id: pageId });
  await mcp(keys.blockedEmployee, "read_page", { page_id: pageId }, false);
  await selectDomain("");
  complete("Re-enabling restores read-only access while explicit member denial continues to win");
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.message.replace(/pages_(?:at|rt)_[A-Za-z0-9_-]+/g, "[redacted]");
  for (const [name, page] of [
    ["owner", owner],
    ["employee", employee],
  ])
    if (page)
      await page
        .screenshot({ path: `${output}/failure-${name}.png`, fullPage: true })
        .catch(() => {});
  throw error;
} finally {
  const cleanup = async (page, id) => {
    const read = (await tool(page, "read_page", { page_id: id })).body;
    const catalog = (await tool(page, "list_pages")).body;
    const deleted = await tool(page, "delete_page", {
      page_id: id,
      base_heads: read.heads,
      ...retry(catalog),
    });
    return deleted.status === 200;
  };
  try {
    report.cleaned =
      (!pageId || !owner || (await cleanup(owner, pageId))) &&
      (!outsiderPageId || !consumer || (await cleanup(consumer, outsiderPageId))) &&
      !!pageId;
  } catch (error) {
    report.cleanupError = error.message;
  }
  await browser.close();
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + "\n");
}
