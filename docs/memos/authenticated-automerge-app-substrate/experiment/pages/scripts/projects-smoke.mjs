// Projects through MCP and the browser on one local OIDC deployment: create a
// Project and nested Pages over MCP, list them, open them in the browser, follow
// breadcrumbs, and trash and restore Pages one at a time.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
assert.equal(new URL(origin).protocol, "http:");
const keyFile = process.env.PAGES_E2E_KEY_FILE;
assert.ok(keyFile, "Run through local-sharing-e2e.mjs --projects for fixture API keys");
const keys = JSON.parse(await readFile(keyFile, "utf8"));
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-projects-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = { completed: [], errors: [] };
const complete = (name) => {
  report.completed.push(name);
  console.log(`[Projects E2E] ${name}`);
};
async function mcp(name, operation, args = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${keys[name]}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Pages-Driver": "Projects E2E agent",
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
const ok = async (name, operation, args) => {
  const result = await mcp(name, operation, args);
  assert.equal(result.isError, false, `${operation}: ${JSON.stringify(result.body)}`);
  return result.body;
};
let owner;
try {
  const title = "Projects fixture " + Date.now();
  const project = await ok("owner", "create_project", {
    title,
    description: "Where the launch lives.",
    idempotency_key: crypto.randomUUID(),
  });
  assert.match(project.project_id, /^prj_/);
  assert.equal(project.url, `${origin}/project/${project.project_id}`);
  assert.equal(project.home_page_url, `${origin}/p/${project.home_page_id}`);
  const roadmap = await ok("owner", "create_page", {
    title: "Roadmap",
    markdown: "What ships when.",
    project_id: project.project_id,
    idempotency_key: crypto.randomUUID(),
  });
  const plan = await ok("owner", "create_page", {
    title: "Q4 plan",
    markdown: "The fourth quarter.",
    parent_id: roadmap.page_id,
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(plan.project_id, project.project_id);
  assert.equal(plan.parent_id, roadmap.page_id);
  complete("MCP created a Project with its home Page and a nested Page");

  const projects = await ok("owner", "list_projects");
  assert.ok(projects.projects.some((entry) => entry.project_id === project.project_id));
  const listed = await ok("owner", "list_pages", { project_id: project.project_id });
  assert.deepEqual(
    listed.pages.map((page) => page.page_id).sort(),
    [project.home_page_id, roadmap.page_id, plan.page_id].sort(),
  );
  const children = await ok("owner", "list_pages", { parent_id: roadmap.page_id });
  assert.deepEqual(
    children.pages.map((page) => page.page_id),
    [plan.page_id],
  );
  const read = await ok("owner", "read_page", { page_id: plan.page_id, include_content: false });
  assert.deepEqual(
    read.breadcrumbs.map((crumb) => crumb.title),
    [title, "Roadmap"],
  );
  const home = await ok("owner", "get_project", { project_id: project.project_id });
  assert.equal(home.home_page_id, project.home_page_id);
  complete("list_projects, list_pages by Project and parent, get_project and breadcrumbs agree");

  const mixup = await mcp("owner", "read_page", { page_id: project.project_id });
  assert.equal(mixup.isError, true);
  assert.equal(mixup.body.code, "project_id_as_page_id");
  const other = await mcp("editor", "get_project", { project_id: project.project_id });
  assert.equal(other.isError, true);
  assert.equal(other.body.code, "project_not_found");
  complete("A Project ID passed as page_id names get_project; another account sees no Project");

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  owner = await context.newPage();
  owner.on("pageerror", (error) => report.errors.push(error.message));
  const begin = await context.request.get(`${origin}/api/auth/login`, { maxRedirects: 0 });
  assert.equal(begin.status(), 302);
  const authorize = new URL(begin.headers().location);
  authorize.searchParams.set("login_hint", "dev@localhost");
  await owner.goto(authorize.href, { waitUntil: "domcontentloaded", timeout: 60000 });
  await expect(owner.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 60000,
  });
  // A link from before the Project name opens the Project at its own path.
  await owner.goto(`${origin}/s/${project.project_id}`);
  await expect(owner.getByRole("heading", { name: title })).toBeVisible({ timeout: 60000 });
  await expect(owner).toHaveURL(`${origin}/project/${project.project_id}`);
  const list = owner.getByRole("list", { name: `Pages in ${title}` });
  await expect(list.locator(".project-home")).toContainText("Home");
  await expect(list.getByRole("link", { name: "Roadmap" })).toBeVisible();
  await expect(list.getByRole("link", { name: "Q4 plan" })).toBeVisible();
  await owner.screenshot({ path: `${output}/projects-view.png` });
  complete("The browser opened the Project from an /s/ link with its home Page and Page tree");

  await list.getByRole("link", { name: "Q4 plan" }).click();
  await expect(owner.locator("wg-content").first()).toContainText("The fourth quarter.", {
    timeout: 30000,
  });
  const crumbs = owner.getByRole("navigation", { name: "Breadcrumbs" });
  await expect(crumbs).toContainText(title);
  await expect(crumbs).toContainText("Roadmap");
  await owner.screenshot({ path: `${output}/projects-breadcrumbs.png` });
  await crumbs.getByRole("link", { name: title }).click();
  await expect(owner.getByRole("heading", { name: title })).toBeVisible();
  await owner.getByRole("button", { name: /, switch page$/ }).click();
  const switcher = owner.getByRole("dialog", { name: "Pages" });
  await expect(switcher.getByRole("navigation", { name: "Projects" })).toContainText(title);
  await switcher.getByRole("button", { name: "Close Pages" }).click();
  complete("Breadcrumbs led back to the Project, and the switcher lists it");

  await owner.getByRole("button", { name: "New Page" }).click();
  await expect(owner.getByLabel("Page title")).toBeVisible({ timeout: 30000 });
  await expect(owner.getByRole("navigation", { name: "Breadcrumbs" })).toContainText(title);
  const after = await ok("owner", "list_pages", { project_id: project.project_id });
  assert.equal(after.pages.length, 4);
  complete("New Page in a Project created a Page at the Project's top level");

  // The home Page shares the Project's title, so the viewer shows one crumb
  // for both. The API keeps the home crumb, marked home:true.
  const underHome = await ok("owner", "create_page", {
    title: "Architecture",
    markdown: "How the pieces fit.",
    parent_id: project.home_page_id,
    idempotency_key: crypto.randomUUID(),
  });
  const underHomeRead = await ok("owner", "read_page", {
    page_id: underHome.page_id,
    include_content: false,
  });
  assert.deepEqual(
    underHomeRead.breadcrumbs.map((crumb) => [crumb.kind, crumb.home === true]),
    [
      ["project", false],
      ["page", true],
    ],
  );
  await owner.goto(`${origin}/p/${underHome.page_id}`);
  await expect(owner.locator("wg-content").first()).toContainText("How the pieces fit.", {
    timeout: 30000,
  });
  const underHomeCrumbs = owner.getByRole("navigation", { name: "Breadcrumbs" });
  await expect(underHomeCrumbs.getByRole("link")).toHaveCount(1);
  await expect(underHomeCrumbs.getByRole("link", { name: title })).toHaveAttribute(
    "href",
    `/project/${project.project_id}`,
  );
  complete("A Page under the home Page shows the Project crumb once");

  const authority = await ok("owner", "list_pages");
  const trashPage = (pageId) =>
    ok("owner", "read_page", { page_id: pageId, include_content: false }).then((read) =>
      mcp("owner", "delete_page", {
        page_id: pageId,
        base_heads: read.heads,
        retry_token: authority.retry_token,
        idempotency_key: authority.retry_key_prefix + crypto.randomUUID(),
      }),
    );
  const blocked = await trashPage(roadmap.page_id);
  assert.equal(blocked.isError, true);
  assert.equal(blocked.body.code, "page_has_children");
  for (const pageId of [plan.page_id, roadmap.page_id]) {
    const trashed = await trashPage(pageId);
    assert.equal(trashed.isError, false, JSON.stringify(trashed.body));
    assert.equal(trashed.body.state, "trashed");
  }
  const protectedHome = await trashPage(project.home_page_id);
  assert.equal(protectedHome.body.code, "home_page_protected");
  const restoreKey = () => authority.retry_key_prefix + crypto.randomUUID();
  const planBack = await ok("owner", "restore_page", {
    page_id: plan.page_id,
    retry_token: authority.retry_token,
    idempotency_key: restoreKey(),
  });
  assert.equal(planBack.parent_id, null, "its parent is in Trash, so it returns to the top level");
  const roadmapBack = await ok("owner", "restore_page", {
    page_id: roadmap.page_id,
    retry_token: authority.retry_token,
    idempotency_key: restoreKey(),
  });
  assert.equal(roadmapBack.restored, true);
  const top = await ok("owner", "list_pages", { project_id: project.project_id, parent_id: null });
  for (const pageId of [roadmap.page_id, plan.page_id])
    assert.ok(top.pages.some((page) => page.page_id === pageId));
  report.cleaned = true;
  complete(
    "Trash refused a parent with sub-pages, kept the home Page, and restore re-homed a child",
  );
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.stack || error.message;
  if (owner)
    await owner.screenshot({ path: `${output}/failure-owner.png`, fullPage: true }).catch(() => {});
  throw error;
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + "\n");
  await browser.close();
}
