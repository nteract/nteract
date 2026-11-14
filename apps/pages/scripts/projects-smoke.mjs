// Projects through MCP and the browser on one local OIDC deployment: create a
// Project and nested Pages over MCP, list them, open them in the browser, follow
// breadcrumbs, browse /pages as a list and a grid at desktop width, browse
// /pages and /projects on a phone-sized screen, filter, sort and group the
// Pages library as an account with its own and shared Pages, add Pages
// from a Project at the 640px breakpoint and from the picker,
// check a direct-grant editor gets no create affordances, a Project editor
// adds Pages the owner owns while a Project viewer can't, and trash and
// restore Pages one at a time.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { pageAddress, pageIdOf } from "./page-address.mjs";
import { pageUrl } from "../shared/routes.mjs";
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
// A same-origin JSON request from a signed-in tab, as the viewer makes it.
async function browserApi(tab, path, body) {
  return tab.evaluate(
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
const ok = async (name, operation, args) => {
  const result = await mcp(name, operation, args);
  assert.equal(result.isError, false, `${operation}: ${JSON.stringify(result.body)}`);
  return result.body;
};
// A heading's action button keeps its label on one line and a 44px touch
// target, however long the title beside it.
async function oneLineButton(tab, name, label) {
  const button = tab.getByRole("button", { name, exact: true });
  await expect(button).toBeVisible();
  const { lines, height } = await button.evaluate((element) => {
    const range = document.createRange();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode()) && !text.textContent.trim()) {}
    range.selectNodeContents(text);
    const tops = [...range.getClientRects()].map((rect) => Math.round(rect.top));
    return { lines: new Set(tops).size, height: element.getBoundingClientRect().height };
  });
  assert.equal(lines, 1, `${label}: "${name}" wraps onto ${lines} lines`);
  assert.ok(height >= 44, `${label}: "${name}" is ${height}px tall`);
}
// A glide ghost lives for a few hundred milliseconds, so count ghosts and
// caret animations as they start rather than polling for them. With `pause`
// set, each new glide and ghost is paused for a test to step.
async function watchGlide(tab) {
  await tab.evaluate(() => {
    const log = { ghosts: 0, glides: 0, pause: false, paused: [] };
    window.__glide = log;
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node.classList?.contains("agent-caret-ghost")) log.ghosts++;
    }).observe(document.body, { subtree: true, childList: true });
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (this.matches(".peer-caret")) log.glides++;
      if (log.pause && this.matches(".peer-caret,.agent-caret-ghost")) {
        animation.pause();
        log.paused.push(animation);
      }
      return animation;
    };
  });
}
const glideLog = (tab) =>
  tab.evaluate(() => ({ ghosts: window.__glide.ghosts, glides: window.__glide.glides }));
/** The agent caret is still and sits at the end of `text`. */
function caretAtEnd(tab, text) {
  return tab.evaluate((text) => {
    const caret = [...document.querySelectorAll(".wordgard-caret-layer .peer-caret")].find(
      (element) => element.textContent.includes("Projects E2E agent"),
    );
    if (!caret || caret.getAnimations().some((animation) => animation.playState !== "finished"))
      return false;
    const walker = document.createTreeWalker(document.querySelector("wg-content"), 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent.indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at + text.length - 1);
      range.setEnd(node, at + text.length);
      const end = range.getBoundingClientRect();
      const box = caret.getBoundingClientRect();
      return Math.abs(box.left - end.right) <= 4 && box.top >= end.top - 6 && box.top <= end.bottom;
    }
    return false;
  }, text);
}
/** Wait until no CSS transition runs (a chevron turning, the progress bar
 * fading), with nothing focused, so a screenshot shows the settled screen. */
async function still(tab) {
  await tab.evaluate(() => document.activeElement?.blur());
  await expect
    .poll(() =>
      tab.evaluate(
        () =>
          document
            .getAnimations()
            .filter((animation) => animation instanceof CSSTransition)
            .filter((animation) => animation.playState === "running").length,
      ),
    )
    .toBe(0);
  await expect(tab.locator('.library-progress[data-active="true"]')).toHaveCount(0);
}
let owner;
// Phone-sized tabs, captured too when a step fails.
const phones = new Map();
try {
  const title = "Projects fixture " + Date.now();
  const project = await ok("owner", "create_project", {
    title,
    description: "Where the launch lives.",
    nonce: crypto.randomUUID(),
  });
  assert.match(project.project_id, /^prj_/);
  assert.equal(project.url, `${origin}/project/${project.project_id}`);
  assert.match(project.document_id, /^[0-9a-f-]{36}$/, "the content document's ID");
  assert.equal(project.role, "owner");
  assert.doesNotMatch(JSON.stringify(project), /home/i, "no retired field on a Project");
  const roadmap = await ok("owner", "create_page", {
    title: "Roadmap",
    markdown: "What ships when.",
    project_id: project.project_id,
    nonce: crypto.randomUUID(),
  });
  const plan = await ok("owner", "create_page", {
    title: "Q4 plan",
    markdown: "The fourth quarter.",
    parent_id: roadmap.page_id,
    nonce: crypto.randomUUID(),
  });
  assert.equal(plan.project_id, project.project_id);
  assert.equal(plan.parent_id, roadmap.page_id);
  assert.equal(roadmap.project_id, project.project_id);
  assert.equal(roadmap.parent_id, null, "a Project's top level has parent_id null");
  complete("MCP created a Project with content and a nested Page");

  // The Project's content is its own document, addressed by project_id. It
  // reads as kind "project" with a Project breadcrumb, edits through the same
  // selector, and shares its history with the document_id the catalog names.
  const content = await ok("owner", "read_page", { project_id: project.project_id });
  assert.equal(content.kind, "project");
  assert.equal(content.project_id, project.project_id);
  assert.equal(content.page_id, project.document_id);
  assert.equal(content.title, title);
  assert.equal(content.url, project.url, "content links to its Project");
  assert.deepEqual(
    content.breadcrumbs.map((crumb) => [crumb.kind, crumb.project_id, crumb.title]),
    [["project", project.project_id, title]],
  );
  assert.ok(
    content.blocks.some((block) => block.markdown.includes("Where the launch lives.")),
    "create_project's description opens the content",
  );
  const contentEdit = {
    project_id: project.project_id,
    revision: content.revision,
    nonce: crypto.randomUUID(),
    operations: [{ op: "insert_markdown", markdown: "Content selector sentinel." }],
  };
  const contentReceipt = await ok("owner", "edit_page", contentEdit);
  assert.equal(contentReceipt.project_id, project.project_id);
  // An exact retry through the document_id alias replays the same receipt.
  const aliasEdit = Object.fromEntries(
    Object.entries(contentEdit).map(([key, value]) =>
      key === "project_id" ? ["page_id", project.document_id] : [key, value],
    ),
  );
  const aliasReceipt = await ok("owner", "edit_page", aliasEdit);
  assert.deepEqual(aliasReceipt.revision, contentReceipt.revision);
  const contentReadback = await ok("owner", "read_page", { project_id: project.project_id });
  assert.deepEqual(contentReadback.revision, contentReceipt.revision);
  assert.equal(
    contentReadback.blocks.filter((block) => block.markdown.includes("Content selector sentinel."))
      .length,
    1,
  );
  const bothSelectors = await mcp("owner", "read_page", {
    page_id: project.document_id,
    project_id: project.project_id,
  });
  assert.equal(bothSelectors.isError, true);
  assert.equal(bothSelectors.body.code, "invalid_arguments");
  complete(
    "Project content reads and writes through project_id, with one history behind document_id",
  );

  const projects = await ok("owner", "list_projects");
  const listedProject = projects.projects.find((entry) => entry.project_id === project.project_id);
  assert.equal(listedProject.document_id, project.document_id);
  assert.equal(listedProject.role, "owner");
  assert.equal(listedProject.url, project.url);
  assert.doesNotMatch(JSON.stringify(projects), /home/i);
  const listed = await ok("owner", "list_pages", { project_id: project.project_id });
  assert.deepEqual(
    listed.pages.map((page) => page.page_id).sort(),
    [roadmap.page_id, plan.page_id].sort(),
    "the content document is never listed as a Page",
  );
  const children = await ok("owner", "list_pages", { parent_id: roadmap.page_id });
  assert.deepEqual(
    children.pages.map((page) => page.page_id),
    [plan.page_id],
  );
  // The chain is the Project, then the parent Pages; nothing stands between.
  const read = await ok("owner", "read_page", { page_id: plan.page_id, include_content: false });
  assert.equal(read.kind, "page");
  assert.deepEqual(
    read.breadcrumbs.map((crumb) => [crumb.kind, crumb.title]),
    [
      ["project", title],
      ["page", "Roadmap"],
    ],
  );
  const topLevel = await ok("owner", "list_pages", {
    project_id: project.project_id,
    parent_id: null,
  });
  assert.deepEqual(
    topLevel.pages.map((page) => [page.page_id, page.parent_id]),
    [[roadmap.page_id, null]],
    "the Project's top level holds its immediate Pages, parent_id null",
  );
  const fetched = await ok("owner", "get_project", { project_id: project.project_id });
  assert.equal(fetched.document_id, project.document_id);
  assert.equal(fetched.revision, 0);
  // The content document is not in the tree: it can't move or go to Trash.
  for (const [operation, args] of [
    ["delete_page", { page_id: project.document_id, nonce: crypto.randomUUID() }],
    [
      "move_page",
      {
        page_id: project.document_id,
        parent_id: roadmap.page_id,
        nonce: crypto.randomUUID(),
      },
    ],
  ]) {
    const refused = await mcp("owner", operation, args);
    assert.equal(refused.isError, true, operation);
    assert.equal(refused.body.code, "project_content_protected", operation);
  }
  complete("list_projects, list_pages by Project and parent, get_project and breadcrumbs agree");

  const mixup = await mcp("owner", "read_page", { page_id: project.project_id });
  assert.equal(mixup.isError, true);
  assert.equal(mixup.body.code, "project_id_as_page_id");
  const other = await mcp("editor", "get_project", { project_id: project.project_id });
  assert.equal(other.isError, true);
  assert.equal(other.body.code, "project_not_found");
  const otherContent = await mcp("editor", "read_page", { project_id: project.project_id });
  assert.equal(otherContent.isError, true);
  assert.equal(
    otherContent.body.code,
    "project_not_found",
    "content answers with the Project's refusal",
  );
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
  await expect(owner.getByLabel("Page title")).toHaveValue(title, { timeout: 60000 });
  await expect(owner.locator("wg-content").first()).toContainText("Where the launch lives.");
  await expect(owner.locator("wg-content").first()).toHaveAttribute("contenteditable", "true");
  await expect(owner).toHaveURL(`${origin}/project/${project.project_id}`);
  const list = owner.getByRole("region", { name: `Pages in ${title}` }).getByRole("list");
  // Project content and its tree share one editor; the content document is not a row.
  await expect(list.getByRole("link", { name: title })).toHaveCount(0);
  await expect(
    owner.getByRole("navigation", { name: "Project", exact: true }).getByRole("link"),
  ).toHaveAttribute("href", `/project/${project.project_id}`);
  await expect(list.getByRole("link", { name: "Roadmap" })).toBeVisible();
  await expect(list.getByRole("link", { name: "Q4 plan" })).toBeVisible();
  await owner.screenshot({ path: `${output}/projects-view.png` });
  await owner.getByRole("button", { name: "Share", exact: true }).click();
  const sharing = owner.getByRole("dialog", { name: "Share Project", exact: true });
  const inviteEmail = sharing.getByLabel("Invite by email", { exact: true });
  await expect(inviteEmail).toBeVisible();
  await expect(sharing.getByRole("button", { name: "Invite", exact: true })).toBeDisabled();
  await inviteEmail.fill("pending-project@localhost");
  await sharing.getByRole("combobox", { name: "Access", exact: true }).selectOption("editor");
  await sharing.getByRole("button", { name: "Invite", exact: true }).click();
  // Match on the state label: hovering unmasks the email and changes the text.
  const pendingRow = sharing.locator("[data-sharing-row]").filter({ hasText: "Pending" });
  await expect(pendingRow).toContainText("p•••@localhost");
  await expect(pendingRow).toContainText("Can edit");
  await expect(sharing).not.toContainText("pending-project@localhost");
  await pendingRow.hover();
  await expect(pendingRow).toContainText("pending-project@localhost");
  await owner.screenshot({ path: `${output}/project-sharing-desktop.png` });
  await owner.mouse.move(0, 0);
  await expect(pendingRow).toContainText("p•••@localhost");
  await owner.emulateMedia({ colorScheme: "dark" });
  await owner.screenshot({ path: `${output}/project-sharing-desktop-dark.png` });
  await owner.emulateMedia({ colorScheme: "light" });
  await owner.keyboard.press("Escape");
  await expect(sharing).toHaveCount(0);
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.getByRole("button", { name: "Share", exact: true }).click();
  await expect(sharing).toBeVisible();
  await owner.screenshot({ path: `${output}/project-sharing-mobile.png` });
  const sharingBounds = await sharing.boundingBox();
  assert.ok(
    sharingBounds.x >= 0 && sharingBounds.x + sharingBounds.width <= 390,
    `Project sharing panel outside mobile viewport: ${JSON.stringify(sharingBounds)}`,
  );
  await sharing
    .getByRole("button", { name: "Remove pending-project@localhost", exact: true })
    .click();
  await expect(pendingRow).toHaveCount(0);
  await owner.keyboard.press("Escape");
  await owner.setViewportSize({ width: 1280, height: 900 });
  complete("The browser opened the unified Project editor and Page tree from an /s/ link");

  await list.getByRole("link", { name: "Q4 plan" }).click();
  await expect(owner.locator("wg-content").first()).toContainText("The fourth quarter.", {
    timeout: 30000,
  });
  const crumbs = owner.getByRole("navigation", { name: "Breadcrumbs" });
  await expect(crumbs).toContainText(title);
  await expect(crumbs).toContainText("Roadmap");
  await owner.screenshot({ path: `${output}/projects-breadcrumbs.png` });
  // A Page in a Project manages its direct grants; the Project note sits
  // inside the panel's gutter.
  await owner.getByRole("button", { name: "Share", exact: true }).click();
  const pageSharing = owner.getByRole("dialog", { name: "Share Page", exact: true });
  const projectNote = pageSharing.locator(".page-sharing-note");
  await expect(projectNote).toContainText("they also have access through the Project");
  const padding = await projectNote.evaluate((node) => {
    const style = getComputedStyle(node);
    return [parseFloat(style.paddingLeft), parseFloat(style.paddingRight)];
  });
  assert.ok(
    padding.every((value) => value >= 12),
    `Project note text runs to the Share Page edge: ${padding}`,
  );
  await owner.emulateMedia({ colorScheme: "dark" });
  await owner.screenshot({ path: `${output}/page-sharing-in-project-dark.png` });
  await owner.emulateMedia({ colorScheme: "light" });
  await owner.keyboard.press("Escape");
  await expect(pageSharing).toHaveCount(0);
  await crumbs.getByRole("link", { name: title }).click();
  await expect(owner.getByLabel("Page title")).toHaveValue(title);
  await expect(owner.locator("wg-content").first()).toContainText("Where the launch lives.");
  await owner.getByRole("button", { name: /, switch page$/ }).click();
  const switcher = owner.getByRole("dialog", { name: "Pages" });
  await expect(switcher.getByRole("navigation", { name: "Projects" })).toContainText(title);
  const browse = switcher.getByRole("navigation", { name: "Browse" });
  await expect(browse.getByRole("link", { name: "All Pages" })).toHaveAttribute("href", "/");
  await expect(browse.getByRole("link", { name: "All Projects" })).toHaveAttribute(
    "href",
    "/projects",
  );
  await switcher.getByRole("button", { name: "Close Pages" }).click();
  complete("Breadcrumbs led back to the Project, and the switcher lists it");

  await oneLineButton(owner, "New Page", "the Project at 1280px");
  await owner.getByRole("button", { name: "New Page" }).click();
  await expect(owner.getByLabel("Page title")).toBeVisible({ timeout: 30000 });
  await expect(owner.getByRole("navigation", { name: "Breadcrumbs" })).toContainText(title);
  const after = await ok("owner", "list_pages", { project_id: project.project_id });
  assert.equal(after.pages.length, 3);
  const newPage = after.pages.find(
    (entry) => ![roadmap.page_id, plan.page_id].includes(entry.page_id),
  );
  assert.equal(newPage.parent_id, null, "New Page lands at the Project's top level");
  complete("New Page in a Project created a Page at the Project's top level");

  // The content document is not a parent: a Page can't be created under it.
  const underContent = await mcp("owner", "create_page", {
    title: "Architecture",
    markdown: "How the pieces fit.",
    parent_id: project.document_id,
    nonce: crypto.randomUUID(),
  });
  assert.equal(underContent.isError, true);
  assert.equal(underContent.body.code, "parent_unavailable");
  const topPage = await ok("owner", "create_page", {
    title: "Architecture",
    markdown: "How the pieces fit.",
    project_id: project.project_id,
    nonce: crypto.randomUUID(),
  });
  assert.equal(topPage.parent_id, null);
  const topPageRead = await ok("owner", "read_page", {
    page_id: topPage.page_id,
    include_content: false,
  });
  assert.deepEqual(
    topPageRead.breadcrumbs.map((crumb) => [crumb.kind, crumb.title]),
    [["project", title]],
  );
  await owner.goto(`${origin}/p/${topPage.page_id}`);
  await expect(owner.locator("wg-content").first()).toContainText("How the pieces fit.", {
    timeout: 30000,
  });
  const topPageCrumbs = owner.getByRole("navigation", { name: "Breadcrumbs" });
  await expect(topPageCrumbs.getByRole("link")).toHaveCount(1);
  await expect(topPageCrumbs.getByRole("link", { name: title })).toHaveAttribute(
    "href",
    `/project/${project.project_id}`,
  );
  complete("A top-level Page shows the Project crumb once; the content document is no parent");

  // From a Page in the Project, the picker's New Page offers the Project and
  // Your items. "In <Project>" lands at the Project's top level and opens it.
  await owner.getByRole("button", { name: /, switch page$/ }).click();
  const picker = owner.getByRole("dialog", { name: "Pages" });
  const pickerCreate = picker.getByRole("group", { name: "New Page" });
  await expect(pickerCreate.getByRole("button", { name: `New Page In ${title}` })).toBeVisible();
  await expect(pickerCreate.getByRole("button", { name: "New Page In Your items" })).toBeVisible();
  // A long Project name truncates; "New Page" itself never wraps.
  for (const lines of await pickerCreate.locator(".picker-create-label").evaluateAll((labels) =>
    labels.map((label) => {
      const range = document.createRange();
      range.selectNodeContents(label);
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    }),
  ))
    assert.equal(lines, 1, "the picker's New Page label wraps");
  await owner.screenshot({ path: `${output}/picker-in-project.png` });
  const beforePicker = await ok("owner", "list_pages", { project_id: project.project_id });
  await pickerCreate.getByRole("button", { name: `New Page In ${title}` }).click();
  await expect(picker).toBeHidden({ timeout: 30000 });
  await expect(owner).not.toHaveURL(pageAddress(origin, topPage.page_id), { timeout: 30000 });
  await expect(owner.getByLabel("Page title")).toBeVisible({ timeout: 30000 });
  const afterPicker = await ok("owner", "list_pages", { project_id: project.project_id });
  assert.equal(afterPicker.pages.length, beforePicker.pages.length + 1);
  const pickerCreated = afterPicker.pages.find(
    (entry) => !beforePicker.pages.some((known) => known.page_id === entry.page_id),
  );
  assert.equal(pickerCreated.parent_id, null, "In <Project> is its top level");
  assert.equal(pickerCreated.project_id, project.project_id);
  await expect(owner).toHaveURL(pageAddress(origin, pickerCreated.page_id));
  complete(
    "The picker's New Page offers the Project and Your items; In <Project> lands at its top level",
  );

  // /pages at 1280px: Name, Source and Last activity columns, and a grid of cards
  // that this browser remembers, with no query or stored flag.
  await owner.goto(`${origin}/pages`);
  await expect(owner.getByRole("heading", { name: "Pages", exact: true })).toBeVisible({
    timeout: 60000,
  });
  const desktopPages = owner.getByRole("list", { name: "Pages", exact: true });
  const desktopRow = (name) =>
    desktopPages
      .getByRole("listitem")
      .filter({ has: owner.getByRole("link", { name, exact: true }) });
  for (const name of ["Roadmap", "Q4 plan", "Architecture"])
    await expect(desktopRow(name).getByRole("link", { name: `Project ${title}` })).toBeVisible();
  // Project content is not a Page, so the library has no row for it.
  await expect(desktopRow(title)).toHaveCount(0);
  const updated = desktopRow("Q4 plan").locator("time");
  await expect(updated.locator("[aria-hidden=true]")).toHaveText(/^(now|\d+m)$/);
  await expect(updated.locator(".sr-only")).toHaveText(/^Last active .+, .+/);
  assert.ok(
    Date.parse(await updated.getAttribute("datetime")),
    "the Last activity cell names its time",
  );
  // The whole row is one target: a mouse click on the time opens the Page.
  const timeBox = await updated.boundingBox();
  await owner.mouse.click(timeBox.x + timeBox.width / 2, timeBox.y + timeBox.height / 2);
  await expect(owner).toHaveURL(pageAddress(origin, plan.page_id));
  await owner.goBack();
  await expect(owner).toHaveURL(`${origin}/pages`);
  await owner.screenshot({ path: `${output}/pages-list-desktop.png` });
  const display = owner.getByRole("group", { name: "Display" });
  await expect(display.getByRole("button", { name: "Grid view" })).toBeVisible();
  await expect(display.getByRole("button", { name: "List view" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await display.getByRole("button", { name: "Grid view" }).click();
  await expect(display.getByRole("button", { name: "Grid view" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const card = desktopPages.getByRole("link", { name: "Q4 plan", exact: true });
  // A card links with the title's slug, and a click lands there.
  await expect(card).toHaveAttribute("href", `/p/${plan.page_id}/Q4-plan`);
  await expect(desktopPages.locator("a a")).toHaveCount(0);
  await owner.screenshot({ path: `${output}/pages-grid-desktop.png` });
  await owner.reload();
  await expect(display.getByRole("button", { name: "Grid view" })).toHaveAttribute(
    "aria-pressed",
    "true",
    { timeout: 60000 },
  );
  await card.click();
  await expect(owner).toHaveURL(`${origin}/p/${plan.page_id}/Q4-plan`);
  await owner.goBack();
  await expect(owner).toHaveURL(`${origin}/pages`);
  await display.getByRole("button", { name: "List view" }).click();
  await desktopRow("Q4 plan")
    .getByRole("link", { name: `Project ${title}` })
    .click();
  await expect(owner).toHaveURL(`${origin}/project/${project.project_id}`);
  await expect(owner.getByLabel("Page title")).toHaveValue(title);
  await owner.goBack();
  await expect(owner).toHaveURL(`${origin}/pages`);
  await expect(desktopRow("Q4 plan")).toBeVisible();
  complete(
    "/pages at 1280px shows Source and Last activity columns, a remembered grid of card links, and Project labels that open their Project",
  );

  // The heading row, tabs and menus hold still when a view comes back empty.
  // Nothing is shared with the owner, so Shared with you lists nothing. Every
  // frame of the switch keeps the same boxes, and the results start where
  // the list did: no line is pushed in above them while the request runs.
  {
    const ownerTab = (name) =>
      owner.getByRole("group", { name: "Show" }).getByRole("button", { name, exact: true });
    const sample = () =>
      owner.evaluate(() => {
        const box = (element) => {
          const rect = element.getBoundingClientRect();
          return [rect.x, rect.y, rect.width, rect.height].map(Math.round);
        };
        const body = document.querySelector(".library-body");
        const first = [...body.children].find((child) => !child.classList.contains("sr-only"));
        return JSON.stringify({
          header: box(document.querySelector(".library-header")),
          controls: box(document.querySelector(".library-controls")),
          tabs: [...document.querySelectorAll(".library-tab")].map(box),
          menus: [...document.querySelectorAll(".library-menu-button")].map(box),
          body: box(body).slice(0, 3),
          first: first ? Math.round(first.getBoundingClientRect().y) : null,
          clientWidth: document.documentElement.clientWidth,
        });
      });
    const record = () =>
      owner.evaluate(() => {
        window.__frames = [];
        const step = () => {
          const body = document.querySelector(".library-body");
          const box = (element) => {
            const rect = element.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height].map(Math.round);
          };
          const first = [...body.children].find((child) => !child.classList.contains("sr-only"));
          window.__frames.push(
            JSON.stringify({
              header: box(document.querySelector(".library-header")),
              controls: box(document.querySelector(".library-controls")),
              tabs: [...document.querySelectorAll(".library-tab")].map(box),
              menus: [...document.querySelectorAll(".library-menu-button")].map(box),
              body: box(body).slice(0, 3),
              first: first ? Math.round(first.getBoundingClientRect().y) : null,
              clientWidth: document.documentElement.clientWidth,
            }),
          );
          if (window.__frames.length < 90) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    await expect(owner.locator(".library-results")).toHaveAttribute("aria-busy", "false");
    assert.equal(
      await owner.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter),
      "stable",
      "the library keeps its scrollbar's room",
    );
    const before = await sample();
    await record();
    await ownerTab("Shared with you").click();
    await expect(owner.locator(".library-empty")).toHaveText("Nothing is shared with you yet.", {
      timeout: 30000,
    });
    await expect.poll(() => owner.evaluate(() => window.__frames.length)).toBe(90);
    const frames = await owner.evaluate(() => window.__frames);
    const moved = frames.filter((frame) => frame !== before);
    assert.deepEqual(moved, [], `the library moved switching to an empty tab: ${before}`);
    assert.equal(await sample(), before);
    await still(owner);
    await owner.screenshot({ path: `${output}/library-empty-shared.png` });
    await record();
    await ownerTab("All").click();
    await expect(desktopRow("Q4 plan")).toBeVisible({ timeout: 30000 });
    await expect.poll(() => owner.evaluate(() => window.__frames.length)).toBe(90);
    assert.deepEqual(
      (await owner.evaluate(() => window.__frames)).filter((frame) => frame !== before),
      [],
      "the library moved switching back from an empty tab",
    );
  }
  complete("Switching to an empty tab and back moves no control, and the results stay put");

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
    await ok("owner", "edit_page", {
      page_id: pageId,
      revision: read.revision,
      nonce: crypto.randomUUID(),
      operations: [
        { op: "replace_match", node_id: block.node_id, match_text: matchText, replacement },
      ],
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
  const allPages = phone.getByRole("list", { name: "Pages", exact: true });
  await expect(phone.getByRole("heading", { name: "Pages", exact: true })).toBeVisible({
    timeout: 60000,
  });
  const pageRow = (name) =>
    allPages.getByRole("listitem").filter({ has: phone.getByRole("link", { name, exact: true }) });
  // A phone keeps Name and Last activity; the Source column is desktop-only.
  for (const name of ["Roadmap", "Q4 plan", "Architecture"]) {
    await expect(pageRow(name).locator("time")).toBeVisible();
    await expect(pageRow(name).locator(".index-cell-source")).toBeHidden();
  }
  await expect(pageRow(title)).toHaveCount(0);
  await fitsScreen("/pages");
  await minimumRowHeight(allPages);
  assert.deepEqual(editorChunks(), [], "loading /pages fetched the editor chunk");
  await phone.screenshot({ path: `${output}/pages-mobile.png` });
  complete("/pages on a phone lists Pages by Name and Last activity, without the editor chunk");

  await phone.getByRole("searchbox", { name: "Search Pages" }).fill("Q4");
  await expect(phone).toHaveURL(`${origin}/pages?q=Q4`);
  await expect(allPages.getByRole("listitem")).toHaveCount(1);
  await expect(pageRow("Q4 plan")).toBeVisible();
  await phone.screenshot({ path: `${output}/pages-search-mobile.png` });
  // The whole row opens the Page: tap its far edge, away from the title.
  const row = pageRow("Q4 plan");
  const box = await row.boundingBox();
  await row.tap({ position: { x: box.width - 12, y: box.height - 8 } });
  await expect(phone).toHaveURL(pageAddress(origin, plan.page_id));
  await expect(phone.locator("wg-content").first()).toContainText("The fourth quarter.", {
    timeout: 30000,
  });
  assert.ok(editorChunks().length > 0, "opening a Page loads the editor chunk");
  await agentEdits(phone, plan.page_id, "The fourth quarter.", "The fourth quarter, revised.");
  await phone.screenshot({ path: `${output}/agent-caret-from-pages-mobile.png` });
  await phone.goBack();
  await expect(phone).toHaveURL(`${origin}/pages?q=Q4`);
  await expect(phone.getByRole("searchbox", { name: "Search Pages" })).toHaveValue("Q4");
  await expect(pageRow("Q4 plan")).toBeVisible();
  complete(
    "Search narrowed /pages, a row opened its Page with an agent's caret, and Back returned to the search",
  );

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
  await expect(phone.getByRole("region", { name: `Pages in ${title}` })).toBeVisible();
  await expect(phone.locator("wg-content").first()).toContainText("Where the launch lives.");
  await fitsScreen("the Project");
  await oneLineButton(phone, "New Page", "the Project");
  await phone.screenshot({ path: `${output}/project-mobile.png` });
  await phone.goBack();
  await expect(phone).toHaveURL(`${origin}/projects`);
  await expect(projectRow).toBeVisible();
  complete(
    "/projects lists the Project with its description, opens it with New Page on one line, and Back returns",
  );

  // The Project at the 640px breakpoint: a Project chip instead of a crumb
  // repeating the title, the Project's Pages under the body, and an inline
  // New Page row that adds one at the top level and opens it.
  await phone.setViewportSize({ width: 640, height: 900 });
  await phone.goto(`${origin}/project/${project.project_id}`);
  const chip = phone.getByRole("navigation", { name: "Project" }).getByRole("link");
  await expect(chip).toHaveText(/^Project · \d+ Pages?$/, { timeout: 60000 });
  await expect(chip).toHaveAttribute("href", `/project/${project.project_id}`);
  await expect(phone.getByRole("navigation", { name: "Breadcrumbs" })).toHaveCount(0);
  const projectPages = phone.getByRole("region", { name: `Pages in ${title}` });
  await expect(projectPages.getByRole("link", { name: "Roadmap" })).toBeVisible();
  await fitsScreen("the Project at 640px");
  await minimumRowHeight(projectPages.getByRole("list"));
  const chipHeight = (await chip.boundingBox()).height;
  assert.ok(chipHeight >= 44, `the Project chip is ${chipHeight}px tall at 640px`);
  await phone.screenshot({ path: `${output}/project-editor-640.png` });
  const beforeRowCreate = await ok("owner", "list_pages", { project_id: project.project_id });
  // A double tap: both clicks land before React disables the row. The
  // one-at-a-time guard drops the second; the unit tests pin the guard
  // itself (page-create-machine.test.mjs).
  await projectPages.getByRole("button", { name: "New Page" }).evaluate((button) => {
    button.click();
    button.click();
  });
  await expect(phone).not.toHaveURL(`${origin}/project/${project.project_id}`, {
    timeout: 30000,
  });
  await expect(phone.getByLabel("Page title")).toBeVisible({ timeout: 30000 });
  // A new Page names itself first: the title has focus, not the body.
  await expect(phone.getByLabel("Page title")).toBeFocused();
  const projectPageCount = async () =>
    (await ok("owner", "list_pages", { project_id: project.project_id })).pages.length;
  await expect.poll(projectPageCount, { timeout: 30000 }).toBe(beforeRowCreate.pages.length + 1);
  await phone.waitForTimeout(1000);
  assert.equal(
    await projectPageCount(),
    beforeRowCreate.pages.length + 1,
    "a double tap made one Page",
  );
  const afterRowCreate = await ok("owner", "list_pages", { project_id: project.project_id });
  const rowCreated = afterRowCreate.pages.find(
    (entry) => !beforeRowCreate.pages.some((known) => known.page_id === entry.page_id),
  );
  assert.equal(rowCreated.parent_id, null, "New Page lands at the top level");
  assert.equal(rowCreated.project_id, project.project_id);
  await expect(phone).toHaveURL(pageAddress(origin, rowCreated.page_id));
  // The phone header (⋯) starts below 601px, so at 640px the page menu is
  // Document actions. New sub-page there creates under the open Page.
  await phone.locator('summary[aria-label="Document actions"]').tap();
  await phone
    .locator(".document-actions .menu-popover")
    .getByRole("button", { name: "New sub-page" })
    .tap();
  await expect
    .poll(async () => (await ok("owner", "list_pages", { parent_id: rowCreated.page_id })).pages, {
      timeout: 30000,
    })
    .toHaveLength(1);
  const [sub] = (await ok("owner", "list_pages", { parent_id: rowCreated.page_id })).pages;
  await expect(phone).toHaveURL(pageAddress(origin, sub.page_id), { timeout: 30000 });
  await expect(phone.getByLabel("Page title")).toBeVisible({ timeout: 30000 });
  await fitsScreen("a new sub-page at 640px");
  complete(
    "At 640px the Project shows its chip, Pages and New Page; Document actions adds a sub-page",
  );

  // On a phone the same entry is in the ⋯ menu, on Pages but not on the
  // Project, which has its New Page row instead.
  await phone.setViewportSize({ width: 390, height: 844 });
  const phoneMenu = phone.getByRole("button", { name: "More page actions" });
  await phoneMenu.tap();
  await expect(phone.getByRole("menuitem", { name: "New sub-page" })).toBeVisible();
  await phone.screenshot({ path: `${output}/new-sub-page-menu-phone.png` });
  await phone.keyboard.press("Escape");
  await phone.goto(`${origin}/project/${project.project_id}`);
  await expect(chip).toBeVisible({ timeout: 60000 });
  await fitsScreen("the Project on a phone");
  await phoneMenu.tap();
  await expect(phone.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await expect(phone.getByRole("menuitem", { name: "New sub-page" })).toHaveCount(0);
  await phone.keyboard.press("Escape");
  complete("On a phone ⋯ offers New sub-page on a Project's Page, not on the Project itself");

  // Owner-only: alice holds direct grants on the content document (by its
  // document_id, as grants on existing content documents do) and on Roadmap,
  // but doesn't own the Project. She sees no chip, no Project Pages, no New
  // sub-page and a plain New Page, and the API refuses her creates in the
  // Project. Direct access never reveals the Project.
  for (const pageId of [project.document_id, roadmap.page_id]) {
    const current = await browserApi(owner, `/api/access?page=${pageId}`);
    assert.equal(current.status, 200);
    const invited = await browserApi(owner, `/api/access?page=${pageId}`, {
      action: "invite",
      email: "alice@localhost",
      role: "editor",
      expected_revision: current.body.access.revision,
      nonce: crypto.randomUUID(),
    });
    assert.equal(invited.status, 200, JSON.stringify(invited.body));
  }
  const aliceContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const alice = await aliceContext.newPage();
  phones.set("alice", alice);
  alice.on("pageerror", (error) => report.errors.push(error.message));
  const aliceLogin = await aliceContext.request.get(`${origin}/api/auth/login`, {
    maxRedirects: 0,
  });
  const aliceAuthorize = new URL(aliceLogin.headers().location);
  aliceAuthorize.searchParams.set("login_hint", "alice@localhost");
  await alice.goto(aliceAuthorize.href, { waitUntil: "domcontentloaded", timeout: 60000 });
  await expect(alice.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 60000,
  });
  const documentActions = (tab) =>
    tab.locator(".document-actions .menu-popover").getByRole("button");
  await alice.goto(`${origin}/p/${project.document_id}`);
  await expect(alice.locator("wg-content").first()).toContainText("Where the launch lives.", {
    timeout: 30000,
  });
  await expect(alice.locator("wg-content").first()).toHaveAttribute("contenteditable", "true");
  await expect(alice).toHaveURL(pageAddress(origin, project.document_id), {
    timeout: 30000,
  });
  await expect(alice.getByRole("navigation", { name: "Project", exact: true })).toHaveCount(0);
  await expect(alice.getByRole("region", { name: `Pages in ${title}` })).toHaveCount(0);
  // "editor" is alice's fixture API key.
  const aliceContent = await ok("editor", "read_page", {
    page_id: project.document_id,
    include_content: false,
  });
  assert.equal(aliceContent.kind, "page", "a direct grantee sees a Page, not the Project");
  assert.equal(aliceContent.project_id, undefined);
  const aliceByProject = await mcp("editor", "read_page", { project_id: project.project_id });
  assert.equal(aliceByProject.isError, true);
  assert.equal(aliceByProject.body.code, "project_not_found");
  await alice.goto(`${origin}/p/${roadmap.page_id}`);
  await expect(alice.locator("wg-content").first()).toContainText("What ships when", {
    timeout: 30000,
  });
  await expect(alice.locator("wg-content").first()).toHaveAttribute("contenteditable", "true");
  await alice.locator('summary[aria-label="Document actions"]').click();
  await expect(documentActions(alice).filter({ hasText: "Copy link" })).toBeVisible();
  await expect(documentActions(alice).filter({ hasText: "New sub-page" })).toHaveCount(0);
  await alice.locator('summary[aria-label="Document actions"]').click();
  await alice.getByRole("button", { name: /, switch page$/ }).click();
  const alicePicker = alice.getByRole("dialog", { name: "Pages" });
  await expect(alicePicker.getByRole("button", { name: "New Page", exact: true })).toBeVisible();
  await expect(alicePicker.getByRole("group", { name: "New Page" })).toHaveCount(0);
  await alice.screenshot({ path: `${output}/shared-editor-no-create.png` });
  await alicePicker.getByRole("button", { name: "Close Pages" }).click();
  // The Pages library as alice, who owns Pages in and out of a Project and has
  // two of the owner's Pages shared with her: tabs, the Project filter, sort,
  // groups, the address through reload and Back, and the list on a phone.
  const aliceProject = await ok("editor", "create_project", {
    title: "Field notes " + Date.now(),
    nonce: crypto.randomUUID(),
  });
  const alpha = await ok("editor", "create_page", {
    title: "Alpha survey",
    markdown: "Sites to visit.",
    project_id: aliceProject.project_id,
    nonce: crypto.randomUUID(),
  });
  assert.equal(alpha.project_id, aliceProject.project_id);
  const zeta = await ok("editor", "create_page", {
    title: "Zeta loose note",
    markdown: "Outside any Project.",
    nonce: crypto.randomUUID(),
  });
  // An edit after the catalog entry was written, so Zeta's content time
  // moves past its updated_at once the host reports it (at most one content
  // activity window, 60 s, later; checked below).
  {
    const read = await ok("editor", "read_page", { page_id: zeta.page_id });
    const block = read.blocks.find((entry) => entry.markdown.includes("Outside any Project."));
    assert.ok(block, "read_page finds Zeta's paragraph");
    await ok("editor", "edit_page", {
      page_id: zeta.page_id,
      revision: read.revision,
      nonce: crypto.randomUUID(),
      operations: [
        {
          op: "replace_match",
          node_id: block.node_id,
          match_text: "Outside any Project.",
          replacement: "Outside any Project. Revisited.",
        },
      ],
    });
  }
  const shots = output;
  const library = alice.locator(".library-results");
  const rowLink = (name) => library.getByRole("link", { name, exact: true });
  const tabButton = (name) =>
    alice.getByRole("group", { name: "Show" }).getByRole("button", { name, exact: true });
  const menu = (name) => alice.getByRole("button", { name: new RegExp(`^${name}: `) });
  const choose = async (name, choice) => {
    await menu(name).click();
    await alice.getByRole("menuitemradio", { name: choice, exact: true }).click();
  };
  const at = (search) => `${origin}/${search}`;
  // What each library visit costs: list_pages and list_projects calls at
  // /api/tools, counted from a mark once the screen has settled: the rows
  // are no longer busy and no tool call is in flight.
  const toolCalls = [];
  const toolsInFlight = new Set();
  const isToolCall = (request) =>
    request.method() === "POST" && new URL(request.url()).pathname === "/api/tools";
  alice.on("request", (request) => {
    if (!isToolCall(request)) return;
    toolsInFlight.add(request);
    try {
      toolCalls.push(JSON.parse(request.postData() ?? "{}").operation);
    } catch {}
  });
  for (const settled of ["requestfinished", "requestfailed"])
    alice.on(settled, (request) => toolsInFlight.delete(request));
  const listingsSince = async (mark) => {
    await expect(library).toHaveAttribute("aria-busy", "false", { timeout: 30000 });
    await expect.poll(() => toolsInFlight.size, { timeout: 30000 }).toBe(0);
    const made = toolCalls.slice(mark);
    return {
      list_pages: made.filter((name) => name === "list_pages").length,
      list_projects: made.filter((name) => name === "list_projects").length,
    };
  };
  const coldMark = toolCalls.length;
  await alice.goto(`${origin}/`);
  await expect(alice.getByRole("heading", { name: "Pages", exact: true })).toBeAttached({
    timeout: 60000,
  });
  for (const name of ["Alpha survey", "Zeta loose note", "Roadmap", title])
    await expect(rowLink(name)).toBeVisible({ timeout: 30000 });
  await expect(tabButton("All")).toHaveAttribute("aria-pressed", "true");
  assert.deepEqual(
    await listingsSince(coldMark),
    { list_pages: 1, list_projects: 1 },
    "a cold visit to / lists once and asks list_projects once",
  );
  complete("A cold library visit sends one list_pages and one list_projects");
  // Last activity is the time list_pages orders by: content_updated_at, else
  // updated_at. Zeta's edit above moves its content time past its catalog
  // time once the host reports it; the row then shows the content time.
  const aliceSession = await browserApi(alice, "/api/auth/session");
  assert.equal(aliceSession.status, 200, JSON.stringify(aliceSession.body));
  const listedZeta = async () => {
    const listed = await browserApi(alice, "/api/tools", {
      operation: "list_pages",
      arguments: { limit: 50, query: "Zeta loose note" },
    });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(
      listed.body.principal,
      aliceSession.body.identity.principal,
      "list_pages names the account that answered",
    );
    return listed.body.pages.find((page) => page.page_id === zeta.page_id) ?? null;
  };
  await expect
    .poll(
      async () => {
        const page = await listedZeta();
        return (
          !!page?.content_updated_at &&
          Date.parse(page.content_updated_at) > Date.parse(page.updated_at)
        );
      },
      { timeout: 90000, intervals: [1000, 2000, 5000] },
    )
    .toBe(true);
  const zetaListed = await listedZeta();
  await alice.reload();
  await expect(rowLink("Zeta loose note")).toBeVisible({ timeout: 30000 });
  await expect(
    library
      .getByRole("listitem")
      .filter({ has: alice.getByRole("link", { name: "Zeta loose note", exact: true }) })
      .locator(".index-cell-updated time"),
  ).toHaveAttribute("datetime", new Date(zetaListed.content_updated_at).toISOString());
  complete("A row whose content and catalog times differ shows its last activity");

  await tabButton("Shared with you").click();
  await expect(alice).toHaveURL(at("?show=shared"));
  await expect(rowLink("Roadmap")).toBeVisible();
  await expect(rowLink("Zeta loose note")).toHaveCount(0);
  await expect(
    library
      .getByRole("listitem")
      .filter({ has: alice.getByRole("link", { name: "Roadmap", exact: true }) })
      .locator(".index-row-shared"),
  ).toHaveText("Shared");
  await expect(menu("Project")).toHaveAttribute("aria-disabled", "true");
  await tabButton("Your items").click();
  await expect(alice).toHaveURL(at("?show=owned"));
  await expect(rowLink("Zeta loose note")).toBeVisible();
  await expect(rowLink("Roadmap")).toHaveCount(0);
  complete("The library's tabs list everything, Your items and Pages shared with you");

  await choose("Project", aliceProject.title);
  await expect(alice).toHaveURL(at(`?show=owned&project=${aliceProject.project_id}`));
  await expect(rowLink("Alpha survey")).toBeVisible();
  await expect(rowLink("Zeta loose note")).toHaveCount(0);
  await tabButton("All").click();
  await expect(alice).toHaveURL(at(""));
  await expect(rowLink("Roadmap")).toBeVisible();
  await alice.goBack();
  await expect(alice).toHaveURL(at(`?show=owned&project=${aliceProject.project_id}`));
  await expect(tabButton("Your items")).toHaveAttribute("aria-pressed", "true");
  await expect(rowLink("Zeta loose note")).toHaveCount(0);
  await expect(menu("Project")).toHaveAttribute("aria-label", `Project: ${aliceProject.title}`);
  await choose("Project", "Any project");
  await tabButton("All").click();
  await expect(alice).toHaveURL(at(""));
  complete("A Project filter lists Your items in it, and Back restores it");

  await choose("Sort", "Title");
  await expect(alice).toHaveURL(at("?sort=title"));
  await expect(rowLink("Zeta loose note")).toBeVisible();
  // The previous order shows, busy, until the title-sorted page lands.
  await expect(library).toHaveAttribute("aria-busy", "false");
  const titles = await library.locator(".index-row-link").allTextContents();
  assert.ok(
    titles.indexOf("Alpha survey") < titles.indexOf("Zeta loose note"),
    `title order: ${titles}`,
  );
  await menu("Group").click();
  await expect(alice.getByRole("menuitemradio", { name: /^Date/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await alice.keyboard.press("Escape");
  await expect(menu("Group")).toBeFocused();
  await choose("Sort", "Last activity");
  await choose("Group", "Project");
  await expect(alice).toHaveURL(at("?group=project"));
  const heading = (name) => alice.getByRole("heading", { level: 2, name: new RegExp(`^${name}`) });
  await expect(heading(aliceProject.title).getByRole("link")).toHaveAttribute(
    "href",
    `/project/${aliceProject.project_id}`,
  );
  await expect(heading("Shared with you")).toBeVisible();
  await expect(heading("Your items")).toBeVisible();
  await expect(
    alice.getByRole("list", { name: aliceProject.title, exact: true }).getByRole("link", {
      name: "Alpha survey",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    alice
      .getByRole("list", { name: "Shared with you", exact: true })
      .getByRole("link", { name: "Roadmap", exact: true }),
  ).toBeVisible();
  await alice.screenshot({ path: `${shots}/library-desktop-grouped-project.png` });
  // Fold a Project group with a click and Shared with you from the keyboard:
  // their rows go, their counts stay, and the folds survive a reload.
  const groupToggle = (name) =>
    alice.locator(".library-group-toggle").filter({
      has: alice.locator(".library-group-label", { hasText: new RegExp(`^${name}$`) }),
    });
  const aliceGroup = groupToggle(aliceProject.title);
  const aliceCount = aliceGroup.locator(".library-group-count [aria-hidden=true]");
  await expect(aliceGroup).toHaveAttribute("aria-expanded", "true");
  const countOpen = await aliceCount.textContent();
  await aliceGroup.click();
  await expect(aliceGroup).toHaveAttribute("aria-expanded", "false");
  await expect(rowLink("Alpha survey")).toBeHidden();
  await expect(aliceCount).toHaveText(countOpen);
  // A folded group's rows leave the tab order: Tab from its Open Project link
  // reaches the next heading.
  await alice
    .locator(".library-group-heading")
    .filter({ has: aliceGroup })
    .getByRole("link", { name: `Open Project ${aliceProject.title}` })
    .focus();
  await alice.keyboard.press("Tab");
  await expect(groupToggle("Shared with you")).toBeFocused();
  assert.notEqual(
    await groupToggle("Shared with you").evaluate(
      (element) => getComputedStyle(element).outlineStyle,
    ),
    "none",
    "a keyboard-focused heading shows its focus",
  );
  await alice.keyboard.press("Enter");
  await expect(groupToggle("Shared with you")).toHaveAttribute("aria-expanded", "false");
  await expect(rowLink("Roadmap")).toBeHidden();
  await alice.keyboard.press(" ");
  await expect(groupToggle("Shared with you")).toHaveAttribute("aria-expanded", "true");
  await alice.keyboard.press(" ");
  await expect(groupToggle("Shared with you")).toHaveAttribute("aria-expanded", "false");
  await expect(groupToggle("Your items")).toHaveAttribute("aria-expanded", "true");
  await expect(rowLink("Zeta loose note")).toBeVisible();
  await alice.mouse.move(0, 0);
  await still(alice);
  await alice.screenshot({ path: `${shots}/library-desktop-folded-light.png` });
  await alice.reload();
  await expect(groupToggle("Shared with you")).toHaveAttribute("aria-expanded", "false", {
    timeout: 60000,
  });
  await expect(groupToggle(aliceProject.title)).toHaveAttribute("aria-expanded", "false");
  await expect(groupToggle("Your items")).toHaveAttribute("aria-expanded", "true");
  await expect(rowLink("Alpha survey")).toBeHidden();
  await alice.emulateMedia({ colorScheme: "dark" });
  await alice.reload();
  await expect(alice.locator("html")).toHaveClass(/dark/);
  await expect(groupToggle("Shared with you")).toHaveAttribute("aria-expanded", "false", {
    timeout: 60000,
  });
  await expect(rowLink("Zeta loose note")).toBeVisible();
  await still(alice);
  await alice.screenshot({ path: `${shots}/library-desktop-folded-dark.png` });
  await alice.emulateMedia({ colorScheme: "light" });
  await alice.reload();
  await expect(groupToggle("Your items")).toHaveAttribute("aria-expanded", "true", {
    timeout: 60000,
  });
  // Fold all and Unfold all, from the Group menu.
  await menu("Group").click();
  await alice.getByRole("menuitem", { name: "Fold all", exact: true }).click();
  await expect(menu("Group")).toBeFocused();
  for (const name of [aliceProject.title, "Shared with you", "Your items"])
    await expect(groupToggle(name)).toHaveAttribute("aria-expanded", "false");
  await expect(alice.locator(".library-results .index-row")).toHaveCount(0);
  await menu("Group").click();
  await expect(alice.getByRole("menuitem", { name: "Fold all", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await alice.getByRole("menuitem", { name: "Unfold all", exact: true }).click();
  for (const name of [aliceProject.title, "Shared with you", "Your items"])
    await expect(groupToggle(name)).toHaveAttribute("aria-expanded", "true");
  await expect(rowLink("Alpha survey")).toBeVisible();
  complete(
    "Group headings fold by click and keyboard, survive a reload, and Fold all and Unfold all",
  );
  await alice.reload();
  await expect(heading("Shared with you")).toBeVisible({ timeout: 60000 });
  await expect(menu("Group")).toHaveAttribute("aria-label", "Group: Project");
  await alice.goBack();
  await expect(alice).toHaveURL(at(""));
  await expect(alice.locator(".library-group")).toHaveCount(0);
  await alice.goForward();
  await expect(alice).toHaveURL(at("?group=project"));
  await expect(heading("Shared with you")).toBeVisible({ timeout: 60000 });
  complete("Sort by title, then group by Project; the address survives reload, Back and Forward");

  await choose("Group", "Date");
  await expect(alice).toHaveURL(at("?group=date"));
  await expect(heading("Today")).toBeVisible();
  // Back and Forward over a grouping: the mounted library regroups the rows
  // it has, with nothing on the wire, and focus stays on the menu.
  const groupMark = toolCalls.length;
  await menu("Group").focus();
  await alice.goBack();
  await expect(alice).toHaveURL(at("?group=project"));
  await expect(heading("Shared with you")).toBeVisible();
  await alice.goForward();
  await expect(alice).toHaveURL(at("?group=date"));
  await expect(heading("Today")).toBeVisible();
  await expect(menu("Group")).toBeFocused();
  assert.deepEqual(
    await listingsSince(groupMark),
    { list_pages: 0, list_projects: 0 },
    "a grouping on Back and Forward asks for nothing",
  );
  complete("Back and Forward over a grouping send no request and keep focus");
  await rowLink("Zeta loose note").click();
  await expect(alice).toHaveURL(pageAddress(origin, zeta.page_id));
  await expect(alice.locator("wg-content").first()).toContainText("Outside any Project.", {
    timeout: 30000,
  });
  const backMark = toolCalls.length;
  await alice.goBack();
  await expect(alice).toHaveURL(at("?group=date"));
  await expect(heading("Today")).toBeVisible({ timeout: 30000 });
  assert.deepEqual(
    await listingsSince(backMark),
    { list_pages: 1, list_projects: 1 },
    "Back from a Page lists the library once",
  );
  complete("Back from a Page lists the library once, painted from memory first");
  await still(alice);
  await alice.screenshot({ path: `${shots}/library-desktop-grouped-date.png` });
  // The head script picks the theme on load, so reload under a dark system.
  await alice.emulateMedia({ colorScheme: "dark" });
  await alice.reload();
  await expect(alice.locator("html")).toHaveClass(/dark/);
  await expect(heading("Today")).toBeVisible({ timeout: 60000 });
  await choose("Group", "Project");
  await expect(heading("Shared with you")).toBeVisible();
  await alice.screenshot({ path: `${shots}/library-desktop-dark.png` });
  await alice.emulateMedia({ colorScheme: "light" });
  // The shortcut opens on the grid, and the library's address drops it.
  await alice.goto(`${origin}/?group=project&grid=1`);
  const aliceDisplay = alice.getByRole("group", { name: "Display" });
  await expect(aliceDisplay.getByRole("button", { name: "Grid view" })).toHaveAttribute(
    "aria-pressed",
    "true",
    { timeout: 60000 },
  );
  await expect(
    alice
      .getByRole("list", { name: aliceProject.title, exact: true })
      .locator(".index-card")
      .getByRole("link", { name: "Alpha survey", exact: true }),
  ).toBeVisible();
  await expect(alice).toHaveURL(at("?group=project"));
  await aliceDisplay.getByRole("button", { name: "List view" }).click();
  await expect(alice.locator(".index-grid")).toHaveCount(0);
  complete("?grid=1 opens the library on the grid");
  await alice.reload();
  await expect(heading("Shared with you")).toBeVisible({ timeout: 60000 });
  await expect(aliceDisplay.getByRole("button", { name: "List view" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await alice
    .getByRole("group", { name: "Display" })
    .getByRole("button", { name: "Grid view" })
    .click();
  await expect(
    alice.getByRole("list", { name: aliceProject.title, exact: true }).getByRole("link", {
      name: "Alpha survey",
      exact: true,
    }),
  ).toBeVisible();
  await alice.screenshot({ path: `${shots}/library-desktop-grid.png` });
  await alice.reload();
  await expect(aliceDisplay.getByRole("button", { name: "Grid view" })).toHaveAttribute(
    "aria-pressed",
    "true",
    { timeout: 60000 },
  );
  await alice
    .getByRole("group", { name: "Display" })
    .getByRole("button", { name: "List view" })
    .click();
  complete(
    "Date groups, a Page opened from them and Back, dark theme, and remembered display modes",
  );

  const alicePhone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    storageState: await aliceContext.storageState(),
  });
  const narrow = await alicePhone.newPage();
  phones.set("alice-phone", narrow);
  narrow.on("pageerror", (error) => report.errors.push(error.message));
  await narrow.goto(`${origin}/?group=project`);
  // The nav says Pages; on a phone the heading is for screen readers only.
  await expect(narrow.getByRole("heading", { name: "Pages", exact: true })).toBeAttached({
    timeout: 60000,
  });
  await expect(narrow.getByRole("heading", { level: 2, name: /^Shared with you/ })).toBeVisible({
    timeout: 30000,
  });
  const width = await narrow.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  assert.ok(width[0] <= width[1], `the library scrolls sideways on a phone: ${width}`);
  for (const control of [
    narrow.getByRole("group", { name: "Show" }).getByRole("button", { name: "All", exact: true }),
    narrow.getByRole("button", { name: /^Sort: / }),
    narrow.getByRole("button", { name: "New Page", exact: true }),
    narrow.getByRole("button", { name: "Grid view", exact: true }),
    narrow.getByRole("button", { name: "List view", exact: true }),
  ]) {
    const box = await control.boundingBox();
    assert.ok(box.height >= 44, `a phone control is ${box.height}px tall`);
  }
  const clipped = await narrow
    .locator(".library-menu-value")
    .evaluateAll((values) =>
      values.filter((value) => value.scrollWidth > value.clientWidth).map((v) => v.textContent),
    );
  assert.deepEqual(clipped, [], "phone menus show their whole labels");
  await still(narrow);
  await narrow.screenshot({ path: `${shots}/library-phone.png` });
  await narrow.getByRole("button", { name: /^Sort: / }).tap();
  await expect(narrow.getByRole("menu", { name: "Sort" })).toBeVisible();
  await narrow.screenshot({ path: `${shots}/library-phone-sort-menu.png` });
  await narrow.getByRole("menuitemradio", { name: "Title", exact: true }).tap();
  await expect(narrow).toHaveURL(`${origin}/?sort=title&group=project`);
  await alicePhone.close();
  phones.delete("alice-phone");
  complete("The library on a phone: no sideways scroll, 44px controls, and a menu sheet");
  await aliceContext.close();
  phones.delete("alice");
  const intoProject = await mcp("editor", "create_page", {
    title: "Not hers",
    project_id: project.project_id,
    nonce: crypto.randomUUID(),
  });
  assert.equal(intoProject.isError, true, "alice can't create at the Project's top level");
  assert.equal(intoProject.body.code, "project_not_found");
  const underRoadmap = await mcp("editor", "create_page", {
    title: "Not hers",
    parent_id: roadmap.page_id,
    nonce: crypto.randomUUID(),
  });
  assert.equal(underRoadmap.isError, true, "alice can't create under a Page she edits");
  assert.equal(underRoadmap.body.code, "parent_unavailable");
  complete(
    "A shared editor sees no create affordances in someone else's Project, and the API refuses her creates",
  );

  // Project members: alice is the Project's editor and bob its viewer. Alice
  // adds Pages, which the owner owns; bob is refused and sees no New Page.
  const teamTitle = "Team notes " + Date.now();
  const team = await ok("owner", "create_project", {
    title: teamTitle,
    description: "Where the team writes.",
    nonce: crypto.randomUUID(),
  });
  let teamRevision = 0;
  for (const [email, role] of [
    ["alice@localhost", "editor"],
    ["bob@localhost", "viewer"],
  ]) {
    const invited = await ok("owner", "manage_project_access", {
      project_id: team.project_id,
      action: "invite",
      email,
      role,
      expected_revision: teamRevision,
      nonce: crypto.randomUUID(),
    });
    teamRevision = invited.revision;
  }
  assert.equal((await ok("editor", "get_project", { project_id: team.project_id })).role, "editor");
  assert.equal((await ok("viewer", "get_project", { project_id: team.project_id })).role, "viewer");
  const aliceTop = await ok("editor", "create_page", {
    title: "Alice's agenda",
    markdown: "Added by a Project editor.",
    project_id: team.project_id,
    nonce: crypto.randomUUID(),
  });
  assert.equal(aliceTop.project_id, team.project_id);
  const aliceChild = await ok("editor", "create_page", {
    title: "Alice's follow-ups",
    parent_id: aliceTop.page_id,
    nonce: crypto.randomUUID(),
  });
  assert.equal(aliceChild.parent_id, aliceTop.page_id);
  const teamPages = await ok("owner", "list_pages", { project_id: team.project_id });
  assert.ok(
    [aliceTop.page_id, aliceChild.page_id].every((id) =>
      teamPages.pages.some((page) => page.page_id === id),
    ),
    "the owner lists the Pages alice added",
  );
  const bobCreate = await mcp("viewer", "create_page", {
    title: "Not his",
    project_id: team.project_id,
    nonce: crypto.randomUUID(),
  });
  assert.equal(bobCreate.isError, true);
  assert.equal(bobCreate.body.code, "project_create_forbidden");
  const memberTab = async (email) => {
    const memberContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const tab = await memberContext.newPage();
    tab.on("pageerror", (error) => report.errors.push(error.message));
    const login = await memberContext.request.get(`${origin}/api/auth/login`, {
      maxRedirects: 0,
    });
    const authorizeMember = new URL(login.headers().location);
    authorizeMember.searchParams.set("login_hint", email);
    await tab.goto(authorizeMember.href, { waitUntil: "domcontentloaded", timeout: 60000 });
    await expect(tab.getByRole("button", { name: /, switch page$/ })).toBeVisible({
      timeout: 60000,
    });
    await tab.goto(`${origin}/project/${team.project_id}`);
    await expect(tab.locator("wg-content").first()).toContainText("Where the team writes.", {
      timeout: 30000,
    });
    const teamList = tab.getByRole("region", { name: `Pages in ${teamTitle}` });
    await expect(teamList.getByRole("link", { name: "Alice's agenda" })).toBeVisible({
      timeout: 30000,
    });
    return { memberContext, tab, teamList };
  };
  {
    const { memberContext, teamList } = await memberTab("bob@localhost");
    await expect(teamList.getByRole("button", { name: "New Page" })).toHaveCount(0);
    await memberContext.close();
  }
  {
    const { memberContext, tab, teamList } = await memberTab("alice@localhost");
    const newPage = teamList.getByRole("button", { name: "New Page" });
    await expect(newPage).toBeVisible({ timeout: 30000 });
    await tab.screenshot({ path: `${output}/project-editor-new-page.png` });
    await newPage.click();
    await expect(tab).toHaveURL(/\/p\/[0-9a-f-]{36}(?:\/[A-Za-z0-9_-]+)?$/, { timeout: 30000 });
    const created = pageIdOf(tab.url());
    await expect(tab.getByLabel("Page title")).toBeFocused({ timeout: 30000 });
    // A Page alice added offers New sub-page to her too, and no Move or Trash.
    await tab.locator('summary[aria-label="Document actions"]').click();
    const actions = tab.locator(".document-actions .menu-popover").getByRole("button");
    await expect(actions.filter({ hasText: "New sub-page" })).toBeVisible({ timeout: 30000 });
    await expect(actions.filter({ hasText: "Move to Trash" })).toHaveCount(0);
    await tab.locator('summary[aria-label="Document actions"]').click();
    const listedTeam = await ok("owner", "list_pages", { project_id: team.project_id });
    assert.ok(
      listedTeam.pages.some((page) => page.page_id === created),
      "the owner lists the Page alice added in the browser",
    );
    await memberContext.close();
  }
  complete(
    "A Project editor adds Pages from the Project view and over MCP; the owner owns them, and a viewer sees no New Page",
  );

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
  const inProject = fresh.getByRole("region", { name: `Pages in ${title}` }).getByRole("list");
  await expect(fresh.locator("wg-content").first()).toContainText("Where the launch lives.");
  await inProject.getByRole("link", { name: "Roadmap" }).tap();
  await expect(fresh).toHaveURL(pageAddress(origin, roadmap.page_id));
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
  const browseNav = fresh.getByRole("navigation", { name: "Browse" });
  await expect(browseNav.getByRole("link", { name: "Pages", exact: true })).toHaveAttribute(
    "href",
    "/",
  );
  await expect(browseNav.getByRole("link", { name: "Pages", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(browseNav.getByRole("link", { name: "Projects" })).toHaveAttribute(
    "href",
    "/projects",
  );
  await oneLineButton(fresh, "New Page", "Pages library");
  await oneLineButton(fresh, "Trash", "Pages library");
  await fresh.screenshot({ path: `${output}/pages-library-mobile.png` });
  await phoneContext.close();
  complete(
    "A fresh /projects load lists without the editor, a Page in its Project shows an agent's caret, and / opens the Pages library",
  );

  // Agent caret glide (viewer/caret-glide.mjs), an experiment behind ?glide=1.
  // The owner tab keeps the default and must not change; a second tab opts in.
  const glidePage = await ok("owner", "create_page", {
    title: "Glide",
    markdown: Array.from(
      { length: 9 },
      (_, index) => `Paragraph ${index + 1}. Room for an agent caret to travel between writes.`,
    ).join("\n\n"),
    nonce: crypto.randomUUID(),
  });
  const glider = await context.newPage();
  glider.on("pageerror", (error) => report.errors.push(error.message));
  await owner.goto(`${origin}/p/${glidePage.page_id}`);
  await glider.goto(`${origin}/p/${glidePage.page_id}?glide=1`);
  for (const tab of [owner, glider]) {
    await expect(tab.locator("wg-content").first()).toContainText("Paragraph 9.", {
      timeout: 30000,
    });
    await watchGlide(tab);
  }
  const glideWrite = async (matchText, replacement) => {
    const read = await ok("owner", "read_page", { page_id: glidePage.page_id });
    await ok("owner", "edit_page", {
      page_id: glidePage.page_id,
      revision: read.revision,
      nonce: crypto.randomUUID(),
      operations: [
        {
          op: "replace_match",
          node_id: read.blocks[0].node_id,
          match_text: matchText,
          replacement,
        },
      ],
    });
    for (const tab of [owner, glider])
      await expect(tab.locator("wg-content").first()).toContainText(replacement, {
        timeout: 30000,
      });
  };
  await glideWrite("Paragraph 2.", "Paragraph 2 holds the first agent write!");
  await expect
    .poll(() => caretAtEnd(glider, "the first agent write!"), { timeout: 30000 })
    .toBe(true);
  assert.deepEqual(
    await glideLog(glider),
    { ghosts: 0, glides: 0 },
    "a first caret does not glide",
  );
  await glideWrite("Paragraph 8.", "Paragraph 8 was rewritten by the agent!");
  await expect.poll(() => glideLog(glider), { timeout: 30000 }).toEqual({ ghosts: 1, glides: 1 });
  await expect
    .poll(() => caretAtEnd(glider, "rewritten by the agent!"), { timeout: 30000 })
    .toBe(true);
  await expect(glider.locator(".agent-caret-ghost")).toHaveCount(0, { timeout: 5000 });
  await expect(glider.locator(".wordgard-caret-layer [data-glide]")).toHaveCount(1);
  complete("With ?glide=1 an agent caret glides to its next write and leaves a fading ghost");

  await expect
    .poll(() => caretAtEnd(owner, "rewritten by the agent!"), { timeout: 30000 })
    .toBe(true);
  assert.deepEqual(await glideLog(owner), { ghosts: 0, glides: 0 });
  await expect(owner.locator(".agent-caret-ghosts")).toHaveCount(0);
  await expect(owner.locator("[data-glide]")).toHaveCount(0);
  complete("Without the flag the same writes move the caret with no glide and no ghost");

  // Pause the next glide as it starts, then step it at fixed times for review.
  await glider.evaluate(() => {
    window.__glide.pause = true;
  });
  await glideWrite("Paragraph 4.", "Paragraph 4 takes the third write!");
  await expect.poll(() => glideLog(glider), { timeout: 30000 }).toEqual({ ghosts: 2, glides: 2 });
  for (const [index, ms] of [0, 70, 140, 210, 280, 600].entries()) {
    await glider.evaluate((ms) => {
      for (const animation of window.__glide.paused)
        animation.currentTime = Math.min(ms, animation.effect.getTiming().duration);
    }, ms);
    await glider
      .locator(".wordgard-editor")
      .first()
      .screenshot({ path: `${output}/glide-${index + 1}-${ms}ms.png` });
  }
  await glider.evaluate(() => {
    for (const animation of window.__glide.paused) animation.finish();
  });
  await expect
    .poll(() => caretAtEnd(glider, "takes the third write!"), { timeout: 30000 })
    .toBe(true);
  await glider.close();
  complete("A paused glide steps from the old position to the new one for screenshots");

  const authority = await ok("owner", "list_pages");
  const trashPage = (pageId) =>
    ok("owner", "read_page", { page_id: pageId, include_content: false }).then((read) =>
      mcp("owner", "delete_page", {
        page_id: pageId,
        revision: read.revision,
        nonce: crypto.randomUUID(),
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
  const protectedContent = await trashPage(project.document_id);
  assert.equal(protectedContent.isError, true);
  assert.equal(protectedContent.body.code, "project_content_protected");
  const restoreKey = () => crypto.randomUUID();
  const planBack = await ok("owner", "restore_page", {
    page_id: plan.page_id,
    nonce: restoreKey(),
  });
  assert.equal(
    planBack.parent_id,
    null,
    "its parent is in Trash, so it returns to the Project's top level",
  );
  assert.equal(planBack.project_id, project.project_id);
  const roadmapBack = await ok("owner", "restore_page", {
    page_id: roadmap.page_id,
    nonce: restoreKey(),
  });
  assert.equal(roadmapBack.restored, true);
  const top = await ok("owner", "list_pages", { project_id: project.project_id, parent_id: null });
  for (const pageId of [roadmap.page_id, plan.page_id])
    assert.ok(top.pages.some((page) => page.page_id === pageId));
  complete(
    "Trash refused a parent with sub-pages, preserved Project content, and restore relocated a child",
  );

  // move_page nests the restored Page under its old parent again, in one
  // Catalog write: the listing and the breadcrumbs follow, and its heads
  // don't change.
  const planHeads = (
    await ok("owner", "read_page", { page_id: plan.page_id, include_content: false })
  ).revision;
  const moveKey = () => crypto.randomUUID();
  const moved = await ok("owner", "move_page", {
    page_id: plan.page_id,
    parent_id: roadmap.page_id,
    position: "first",
    nonce: moveKey(),
  });
  assert.equal(moved.parent_id, roadmap.page_id);
  assert.equal(moved.project_id, project.project_id);
  assert.ok(Number.isSafeInteger(moved.location_revision) && moved.location_revision >= 1);
  assert.equal(moved.url, pageUrl(origin, { page_id: plan.page_id, title: moved.title }));
  const nestedAgain = await ok("owner", "list_pages", { parent_id: roadmap.page_id });
  assert.deepEqual(
    nestedAgain.pages.map((page) => [page.page_id, page.parent_id, page.position]),
    [[plan.page_id, roadmap.page_id, moved.position]],
  );
  const movedRead = await ok("owner", "read_page", {
    page_id: plan.page_id,
    include_content: false,
  });
  assert.deepEqual(movedRead.revision, planHeads, "a move changes no Page revision");
  assert.deepEqual(
    movedRead.breadcrumbs.map((crumb) => [crumb.kind, crumb.title]),
    [
      ["project", title],
      ["page", "Roadmap"],
    ],
  );
  const contentMove = await mcp("owner", "move_page", {
    page_id: project.document_id,
    parent_id: roadmap.page_id,
    nonce: moveKey(),
  });
  assert.equal(contentMove.isError, true);
  assert.equal(contentMove.body.code, "project_content_protected");
  const cycle = await mcp("owner", "move_page", {
    page_id: roadmap.page_id,
    parent_id: plan.page_id,
    nonce: moveKey(),
  });
  assert.equal(cycle.body.code, "placement_cycle");
  complete("move_page nested a Page under another over MCP; listing and breadcrumbs follow");

  // A person creates a Project from /projects, then moves a loose Page into
  // it from the Page's menu on a phone. The Page keeps its heads, its sub-page
  // follows, and it moves on to Your items and back over MCP.
  const notesTitle = "Conference notes " + Date.now();
  await owner.goto(`${origin}/projects`);
  await owner.getByRole("button", { name: "New Project", exact: true }).click();
  const creator = owner.getByRole("dialog", { name: "New Project" });
  await creator.getByLabel("Title").fill(notesTitle);
  await creator.getByLabel(/Description/).fill("Talks and hallway notes.");
  await owner.screenshot({ path: `${output}/new-project-dialog.png` });
  await creator.getByRole("button", { name: "Create Project" }).click();
  await expect(owner.getByLabel("Page title")).toHaveValue(notesTitle, { timeout: 30000 });
  await expect(owner).toHaveURL(new RegExp(`/project/prj_`));
  const notesProject = (await ok("owner", "list_projects")).projects.find(
    (entry) => entry.title === notesTitle,
  );
  assert.ok(notesProject, "the dialog created the Project through create_project");
  assert.equal(notesProject.description, "Talks and hallway notes.");
  // A new Project opens its editable content and a tree with only New Page.
  await expect(owner.locator("wg-content").first()).toContainText("Talks and hallway notes.");
  await expect(owner.locator("wg-content").first()).toHaveAttribute("contenteditable", "true");
  const emptyTree = owner.getByRole("region", { name: `Pages in ${notesTitle}` });
  await expect(emptyTree.getByRole("link")).toHaveCount(0);
  await expect(emptyTree.getByRole("listitem")).toHaveCount(1);
  await expect(owner.getByRole("button", { name: "New Page", exact: true })).toHaveCount(1);
  await expect(emptyTree.getByRole("button", { name: "New Page" })).toBeVisible();
  await expect(
    owner.getByRole("navigation", { name: "Project", exact: true }).getByRole("link"),
  ).toHaveAttribute("href", `/project/${notesProject.project_id}`);
  await owner.screenshot({ path: `${output}/project-empty.png` });
  complete("New Project opened editable content and an empty tree with one New Page action");

  const loose = await ok("owner", "create_page", {
    title: "Keynote",
    markdown: "Opening remarks.",
    nonce: crypto.randomUUID(),
  });
  const looseChild = await ok("owner", "create_page", {
    title: "Keynote Q&A",
    parent_id: loose.page_id,
    nonce: crypto.randomUUID(),
  });
  const looseHeads = (
    await ok("owner", "read_page", { page_id: loose.page_id, include_content: false })
  ).revision;
  const moverContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    storageState: await context.storageState(),
  });
  const movePhone = await moverContext.newPage();
  phones.set("move", movePhone);
  movePhone.on("pageerror", (error) => report.errors.push(error.message));
  await movePhone.goto(`${origin}/p/${loose.page_id}`);
  await expect(movePhone.locator("wg-content").first()).toContainText("Opening remarks.", {
    timeout: 30000,
  });
  await movePhone.getByRole("button", { name: "More page actions" }).first().click();
  await movePhone.getByRole("menuitem", { name: "Move to…" }).click();
  const mover = movePhone.getByRole("dialog", { name: /^Move/ });
  await expect(mover.getByLabel("Move to")).toHaveValue("your-items");
  await mover.getByLabel("Move to").selectOption({ label: notesTitle });
  await expect(mover.getByLabel(/Under/)).toBeEnabled({ timeout: 30000 });
  await movePhone.screenshot({ path: `${output}/move-dialog-phone.png` });
  await mover.getByRole("button", { name: "Move", exact: true }).click();
  await expect(mover).toBeHidden({ timeout: 30000 });
  await expect(movePhone.getByRole("navigation", { name: "Breadcrumbs" })).toContainText(
    notesTitle,
    {
      timeout: 30000,
    },
  );
  const notesPages = await ok("owner", "list_pages", { project_id: notesProject.project_id });
  for (const pageId of [loose.page_id, looseChild.page_id])
    assert.ok(
      notesPages.pages.some((entry) => entry.page_id === pageId),
      "the Page and its sub-page are in the Project",
    );
  assert.deepEqual(
    (await ok("owner", "read_page", { page_id: loose.page_id, include_content: false })).revision,
    looseHeads,
    "a move changes no Page revision",
  );
  await moverContext.close();
  phones.delete("move");
  complete("Move to… on a phone moved a Page from Your items into the new Project");

  const across = await ok("owner", "move_page", {
    page_id: loose.page_id,
    parent_id: roadmap.page_id,
    nonce: moveKey(),
  });
  assert.equal(across.project_id, project.project_id, "Project to Project");
  const out = await ok("owner", "move_page", {
    page_id: loose.page_id,
    project_id: null,
    nonce: moveKey(),
  });
  assert.equal(out.project_id, null, "Project to Your items");
  assert.equal(out.parent_id, null);
  assert.equal(out.descendants, 1);
  const missing = await mcp("owner", "move_page", {
    page_id: loose.page_id,
    nonce: moveKey(),
  });
  assert.equal(missing.body.code, "move_destination_required");
  complete("move_page moved the Page between Projects and out to Your items over MCP");

  // A real browser claims an email invitation, then crosses two hard Project
  // lease deadlines. Capture protocol facts only, never cookies or signer keys.
  const leaseProject = await ok("owner", "create_project", {
    title: "Inherited lease fixture",
    nonce: crypto.randomUUID(),
  });
  const leasePage = await ok("owner", "create_page", {
    title: "Inherited lease Page",
    markdown: "Shared through the Project only.",
    project_id: leaseProject.project_id,
    nonce: crypto.randomUUID(),
  });
  const grant = await ok("owner", "get_project_access", { project_id: leaseProject.project_id });
  await ok("owner", "manage_project_access", {
    project_id: leaseProject.project_id,
    action: "invite",
    email: "alice@localhost",
    role: "editor",
    expected_revision: grant.revision,
    nonce: crypto.randomUUID(),
  });
  const leaseContext = await browser.newContext();
  await leaseContext.addInitScript(() => {
    window.__leaseEvents = [];
    window.__leaseHold = null;
    let sequence = 0;
    const Base = WebSocket;
    window.WebSocket = class extends Base {
      constructor(...args) {
        super(...args);
        this.fixtureId = ++sequence;
        for (const name of ["open", "close"])
          this.addEventListener(name, (event) => {
            window.__leaseEvents.push({
              name,
              id: this.fixtureId,
              at: Date.now(),
              ...(name === "close" && { code: event.code, reason: event.reason }),
            });
          });
      }
      send(bytes) {
        // Hold only the admitted connection under test, never a fresh handshake.
        if (this.fixtureId !== window.__leaseHold) super.send(bytes);
      }
    };
  });
  const member = await leaseContext.newPage();
  phones.set("project-member", member);
  member.on("pageerror", (error) => report.errors.push(error.message));
  const memberLogin = await leaseContext.request.get(`${origin}/api/auth/login`, {
    maxRedirects: 0,
  });
  const memberAuthorize = new URL(memberLogin.headers().location);
  memberAuthorize.searchParams.set("login_hint", "alice@localhost");
  await member.goto(memberAuthorize.href, { waitUntil: "domcontentloaded" });
  await expect(member.getByRole("button", { name: /, switch page$/ })).toBeVisible();
  const claimed = await ok("owner", "get_project_access", { project_id: leaseProject.project_id });
  const memberPrincipal = (await browserApi(member, "/api/auth/session")).body.identity.principal;
  assert.equal(claimed.members[memberPrincipal]?.role, "editor");
  assert.equal(claimed.invites.length, 0, "verified login claims the Project email invitation");
  await member.goto(`${origin}/p/${leasePage.page_id}`);
  const leaseContent = member.locator(".page-block wg-content").first();
  await expect(leaseContent).toHaveAttribute("contenteditable", "true");
  await expect(member.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();
  const events = () => member.evaluate(() => window.__leaseEvents);
  for (let cycle = 1; cycle <= 2; cycle++) {
    await expect
      .poll(async () => (await events()).filter((event) => event.name === "close").length, {
        timeout: 17000,
      })
      .toBe(cycle);
    const closed = (await events()).filter((event) => event.name === "close").at(-1);
    assert.equal(closed.code, 4503);
    assert.equal(closed.reason, "project_lease_expired");
    await expect
      .poll(async () => (await events()).filter((event) => event.name === "open").length)
      .toBe(cycle + 1);
    const reopened = (await events()).filter((event) => event.name === "open").at(-1);
    assert.ok(reopened.at - closed.at < 2000, "scheduled renewal stays near base backoff");
    await expect(leaseContent).toHaveAttribute("contenteditable", "true");
    await expect(member.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();
    await expect(member.getByText(/Server unreachable|Sign in again/)).toHaveCount(0);
  }
  report.projectLease = { cycles: await events() };
  complete(
    "An accepted Project editor crossed two real 15-second lease closes and reconnected without an outage",
  );
  await member.evaluate(() => {
    window.__leaseHold = window.__leaseEvents.filter((event) => event.name === "open").at(-1).id;
  });
  await leaseContent.click();
  await member.keyboard.press("End");
  await member.keyboard.insertText(" Unsynced lease recovery.");
  await expect(leaseContent).toContainText("Unsynced lease recovery.");
  const latestAccess = await ok("owner", "get_project_access", {
    project_id: leaseProject.project_id,
  });
  const revokedAt = Date.now();
  await ok("owner", "manage_project_access", {
    project_id: leaseProject.project_id,
    action: "set_role",
    principal: memberPrincipal,
    role: null,
    expected_revision: latestAccess.revision,
    nonce: crypto.randomUUID(),
  });
  await expect(member.getByRole("heading", { name: "You no longer have access" })).toBeVisible({
    timeout: 17000,
  });
  report.projectLease.revocation_ms = Date.now() - revokedAt;
  assert.ok(
    report.projectLease.revocation_ms <= 15000,
    "revocation is bounded by the inherited lease",
  );
  await expect(leaseContent).toHaveCount(0);
  const downloaded = member.waitForEvent("download");
  await member.getByRole("button", { name: /^Download .*local cop/ }).click();
  const download = await downloaded;
  assert.match(await readFile(await download.path(), "utf8"), /Unsynced lease recovery/);
  report.projectLease.finalEvents = await events();
  await member.screenshot({ path: `${output}/project-lease-revoked.png` });
  await leaseContext.close();
  phones.delete("project-member");
  complete(
    "Project revocation stopped the live member within the lease bound and preserved the unsynced draft download",
  );
  report.cleaned = true;
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
