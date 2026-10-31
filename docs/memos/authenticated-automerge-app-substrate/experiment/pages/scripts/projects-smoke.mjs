// Projects through MCP and the browser on one local OIDC deployment: create a
// Project and nested Pages over MCP, list them, open them in the browser, follow
// breadcrumbs, browse /pages and /projects on a phone-sized screen, and trash
// and restore Pages one at a time.
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
// Phone-sized tabs, captured too when a step fails.
const phones = new Map();
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
  const browse = switcher.getByRole("navigation", { name: "Browse" });
  await expect(browse.getByRole("link", { name: "All Pages" })).toHaveAttribute("href", "/pages");
  await expect(browse.getByRole("link", { name: "All Projects" })).toHaveAttribute(
    "href",
    "/projects",
  );
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

  // /pages and /projects on a phone. They list from the shell: the only
  // chunks a fresh load fetches are the ones index.html preloads for app.js,
  // never the editor chunk, which waits until a Page opens.
  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    storageState: await context.storageState(),
  });
  const phone = await phoneContext.newPage();
  phones.set("phone", phone);
  phone.on("pageerror", (error) => report.errors.push(error.message));
  const chunks = [];
  phone.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (/^\/chunks\/[A-Z2-7]{8}\.js$/.test(pathname)) chunks.push(pathname);
  });
  const shellChunks = [
    ...(await (await phoneContext.request.get(`${origin}/`)).text()).matchAll(
      /rel="modulepreload" href="(\/chunks\/[A-Z2-7]{8}\.js)"/g,
    ),
  ].map((match) => match[1]);
  const editorChunks = () => chunks.filter((chunk) => !shellChunks.includes(chunk));
  // An agent edits the Page the phone opened from an index route; its caret
  // must show, with the editor chunk loaded on demand rather than at boot.
  const agentEdits = async (tab, pageId, matchText, replacement) => {
    const read = await ok("owner", "read_page", { page_id: pageId });
    const block = read.blocks.find((entry) => entry.markdown.includes(matchText));
    assert.ok(block, `read_page finds "${matchText}"`);
    await ok("owner", "patch_page", {
      page_id: pageId,
      base_heads: read.heads,
      idempotency_key: crypto.randomUUID(),
      operations: [{ op: "replace_match", block_id: block.id, match_text: matchText, replacement }],
    });
    await expect(tab.locator("wg-content").first()).toContainText(replacement, {
      timeout: 30000,
    });
    await expect(
      tab.locator(".wordgard-caret-layer .peer-caret", { hasText: "Projects E2E agent" }),
    ).toBeVisible({ timeout: 30000 });
  };
  const fitsScreen = async (label) => {
    const width = await phone.evaluate(() => [
      document.documentElement.scrollWidth,
      window.innerWidth,
    ]);
    assert.ok(width[0] <= width[1], `${label} scrolls sideways: ${width}`);
  };
  const minimumRowHeight = async (list) => {
    const heights = await list
      .locator(":scope > li")
      .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
    assert.ok(heights.length > 0);
    assert.ok(Math.min(...heights) >= 44, `row heights ${heights}`);
  };

  await phone.goto(`${origin}/pages`);
  const allPages = phone.getByRole("list", { name: "All Pages" });
  await expect(phone.getByRole("heading", { name: "All Pages" })).toBeVisible({ timeout: 60000 });
  const pageRow = (name) =>
    allPages.getByRole("listitem").filter({ has: phone.getByRole("link", { name, exact: true }) });
  for (const name of ["Roadmap", "Q4 plan", "Architecture", title])
    await expect(pageRow(name).getByRole("link", { name: `Project ${title}` })).toHaveAttribute(
      "href",
      `/project/${project.project_id}`,
    );
  await fitsScreen("/pages");
  await minimumRowHeight(allPages);
  assert.deepEqual(editorChunks(), [], "loading /pages fetched the editor chunk");
  await phone.screenshot({ path: `${output}/pages-mobile.png` });
  complete("/pages on a phone lists Pages with Project labels, without the editor chunk");

  await phone.getByRole("searchbox", { name: "Search all Pages" }).fill("Q4");
  await expect(phone).toHaveURL(`${origin}/pages?q=Q4`);
  await expect(allPages.getByRole("listitem")).toHaveCount(1);
  await expect(pageRow("Q4 plan")).toBeVisible();
  await phone.screenshot({ path: `${output}/pages-search-mobile.png` });
  // The whole row opens the Page: tap its far edge, away from the title.
  const row = pageRow("Q4 plan");
  const box = await row.boundingBox();
  await row.tap({ position: { x: box.width - 12, y: box.height - 8 } });
  await expect(phone).toHaveURL(`${origin}/p/${plan.page_id}`);
  await expect(phone.locator("wg-content").first()).toContainText("The fourth quarter.", {
    timeout: 30000,
  });
  assert.ok(editorChunks().length > 0, "opening a Page loads the editor chunk");
  await agentEdits(phone, plan.page_id, "The fourth quarter.", "The fourth quarter, revised.");
  await phone.screenshot({ path: `${output}/agent-caret-from-pages-mobile.png` });
  await phone.goBack();
  await expect(phone).toHaveURL(`${origin}/pages?q=Q4`);
  await expect(phone.getByRole("searchbox", { name: "Search all Pages" })).toHaveValue("Q4");
  await expect(pageRow("Q4 plan")).toBeVisible();
  complete(
    "Search narrowed /pages, a row opened its Page with an agent's caret, and Back returned to the search",
  );

  await pageRow("Q4 plan")
    .getByRole("link", { name: `Project ${title}` })
    .tap();
  await expect(phone).toHaveURL(`${origin}/project/${project.project_id}`);
  await expect(phone.getByRole("heading", { name: title })).toBeVisible();
  await phone.goBack();
  await expect(phone).toHaveURL(`${origin}/pages?q=Q4`);
  await expect(pageRow("Q4 plan")).toBeVisible();
  complete("A Project label opened its Project, and Back returned to /pages");

  await phone
    .getByRole("navigation", { name: "Browse" })
    .getByRole("link", { name: "Projects" })
    .tap();
  await expect(phone).toHaveURL(`${origin}/projects`);
  const projectList = phone.getByRole("list", { name: "Projects" });
  const projectRow = projectList
    .getByRole("listitem")
    .filter({ has: phone.getByRole("link", { name: title, exact: true }) });
  await expect(projectRow).toContainText("Where the launch lives.");
  await fitsScreen("/projects");
  await minimumRowHeight(projectList);
  await phone.screenshot({ path: `${output}/projects-mobile.png` });
  await projectRow.getByRole("link", { name: title, exact: true }).tap();
  await expect(phone).toHaveURL(`${origin}/project/${project.project_id}`);
  await expect(phone.getByRole("list", { name: `Pages in ${title}` })).toBeVisible();
  await phone.goBack();
  await expect(phone).toHaveURL(`${origin}/projects`);
  await expect(projectRow).toBeVisible();
  complete("/projects lists the Project with its description, opens it, and Back returns");

  const fresh = await phoneContext.newPage();
  phones.set("fresh", fresh);
  const freshChunks = [];
  fresh.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/chunks/")) freshChunks.push(pathname);
  });
  await fresh.goto(`${origin}/projects`);
  await expect(fresh.getByRole("link", { name: title, exact: true })).toBeVisible({
    timeout: 60000,
  });
  assert.deepEqual(
    freshChunks.filter((chunk) => !shellChunks.includes(chunk)),
    [],
    "loading /projects fetched the editor chunk",
  );
  // From that fresh /projects load, into the Project and one of its Pages: the
  // editor loads on demand there, and an agent's caret shows.
  await fresh.getByRole("link", { name: title, exact: true }).tap();
  const inProject = fresh.getByRole("list", { name: `Pages in ${title}` });
  await inProject.getByRole("link", { name: "Roadmap" }).tap();
  await expect(fresh).toHaveURL(`${origin}/p/${roadmap.page_id}`);
  await expect(fresh.locator("wg-content").first()).toContainText("What ships when.", {
    timeout: 30000,
  });
  assert.ok(
    freshChunks.some((chunk) => !shellChunks.includes(chunk)),
    "opening a Page from /projects loads the editor chunk",
  );
  await agentEdits(fresh, roadmap.page_id, "What ships when.", "What ships when, and why.");
  await fresh.goBack();
  await expect(fresh).toHaveURL(`${origin}/project/${project.project_id}`);
  await fresh.goBack();
  await expect(fresh).toHaveURL(`${origin}/projects`);
  await fresh.goto(`${origin}/`);
  const homeNav = fresh.getByRole("navigation", { name: "Browse" });
  await expect(homeNav.getByRole("link", { name: "All Pages" })).toHaveAttribute("href", "/pages");
  await expect(homeNav.getByRole("link", { name: "Projects" })).toHaveAttribute(
    "href",
    "/projects",
  );
  await fresh.screenshot({ path: `${output}/home-mobile.png` });
  await phoneContext.close();
  complete(
    "A fresh /projects load lists without the editor, a Page in its Project shows an agent's caret, and Home links both index routes",
  );

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
  for (const [name, tab] of phones) {
    await tab.screenshot({ path: `${output}/failure-${name}.png`, fullPage: true }).catch(() => {});
    await tab
      .content()
      .then((html) => writeFile(`${output}/failure-${name}.html`, html))
      .catch(() => {});
  }
  throw error;
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + "\n");
  await browser.close();
}
