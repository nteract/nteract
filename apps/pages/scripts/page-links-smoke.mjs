// Links between Pages and to Projects in a real browser, against a running
// local Wordgard fixture: the Page and Project glyphs (once per link,
// however its text is formatted), the hover card's faces for both kinds,
// crossing a formatted link, Escape, keyboard access from a comment link,
// Open in place for a Page and a Project, the open Project's own links left
// plain, and the caret around a glyph link in an editable block. Then
// chits: bare links drawing titles or Page unavailable, their hover card and
// link menu, reveal on caret, pasting a URL (undo, paste as plain text),
// copying, and chits in comments.
//
// dev@localhost owns a target Page, a Project, and a Page that links to
// them, to a Page and a Project alice@localhost keeps private, to a heading
// on the same Page and to an external site. alice's Page and Project must
// read as unavailable to dev.
//
//   PAGES_ORIGIN=http://localhost:9894 node scripts/page-links-smoke.mjs
//
// Screenshots of each face, light and dark, desktop and phone width, land in
// PAGES_SCREENSHOTS. Each check waits on what the reader sees.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { pageAddress } from "./page-address.mjs";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost", "Generated fixture requires local OIDC");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-page-links";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const completed = [];
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const TARGET_TITLE = "Nov 5 Evening Focus";

const checkpoint = (name) => {
  completed.push(name);
  console.log("PASS " + name);
};

/** A signed-in context for `email` at the loopback issuer. */
async function signIn(email, options = {}) {
  const context = await browser.newContext({ viewport: DESKTOP, ...options });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${email}: ${error.message}`));
  const begin = await context.request.get(`${origin}/api/auth/login`, { maxRedirects: 0 });
  assert.equal(begin.status(), 302);
  const authorize = new URL(begin.headers().location);
  authorize.searchParams.set("login_hint", email);
  await page.goto(authorize.href, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 30000,
  });
  return { context, page };
}

async function tool(page, operation, args = {}) {
  const response = await page.request.fetch(`${origin}/api/tools`, {
    method: "POST",
    headers: { Origin: origin },
    data: { operation, arguments: args },
  });
  assert.ok(response.ok(), `${operation}: ${response.status()} ${await response.text()}`);
  return response.json();
}
const key = () => "page-links-" + crypto.randomUUID();
const card = (page) => page.locator(".page-link-card");
const link = (page, pageId) => page.locator(`wg-content a.page-link[data-page-id="${pageId}"]`);
const projectLink = (page, projectId) =>
  page.locator(`wg-content a.project-link[data-project-id="${projectId}"]`);
const PROJECT_TITLE = "Launch week";
const PROJECT_DESCRIPTION = "Everything for shipping link previews: plans, owners and dates.";

/** Rest the pointer on `locator` until its card shows `face`. */
async function hover(page, locator, face) {
  await page.mouse.move(2, 2);
  await expect(card(page)).toHaveCount(0, { timeout: 5000 });
  await locator.hover();
  await expect(card(page)).toHaveAttribute("data-face", face, { timeout: 15000 });
}

let stage = "sign in";
try {
  const owner = await signIn("dev@localhost");
  const alice = await signIn("alice@localhost");

  stage = "create the Pages";
  const target = await tool(owner.page, "create_page", {
    title: TARGET_TITLE,
    nonce: key(),
    markdown: [
      "Tonight's list, with an owner for each item.",
      "## Where things landed",
      "| Item | Owner |\n| --- | --- |\n| Storage spike | Kyle |\n| Chits | Quill |",
      "## Follow-ups",
      "- [ ] Decide on bare-URL chits\n- [x] Ship the hover card",
    ].join("\n\n"),
  });
  // An edit after creation: the host records when content last changed.
  const read = await tool(owner.page, "read_page", {
    page_id: target.page_id,
    include_content: false,
  });
  await tool(owner.page, "edit_page", {
    page_id: target.page_id,
    revision: read.revision,
    nonce: key(),
    operations: [{ op: "insert_markdown", markdown: "Two items need a decision before Friday." }],
  });
  const slow = await tool(owner.page, "create_page", {
    title: "Slow to load",
    nonce: key(),
    markdown: "Nothing to see.",
  });
  const secret = await tool(alice.page, "create_page", {
    title: "Alice's private notes",
    nonce: key(),
    markdown: "Not for dev.",
  });
  // dev's Project, whose content links to itself and to the target, and
  // alice's, which dev can't read.
  const project = await tool(owner.page, "create_project", {
    title: PROJECT_TITLE,
    description: PROJECT_DESCRIPTION,
    nonce: key(),
  });
  const projectRead = await tool(owner.page, "read_page", {
    project_id: project.project_id,
    include_content: false,
  });
  await tool(owner.page, "edit_page", {
    project_id: project.project_id,
    revision: projectRead.revision,
    nonce: key(),
    operations: [
      {
        op: "insert_markdown",
        after_node_id: null,
        markdown:
          "## This week\n\nShip the hover card, then chits. " +
          `See [this Project](/project/${project.project_id}) and ` +
          `[the evening focus](/p/${target.page_id}).`,
      },
    ],
  });
  const secretProject = await tool(alice.page, "create_project", {
    title: "Alice's private Project",
    nonce: key(),
  });
  const source = await tool(owner.page, "create_page", {
    title: "Links elsewhere",
    nonce: key(),
    markdown: [
      `Tonight's list is in [the evening focus](/p/${target.page_id}), and ` +
        `[Alice's notes](/p/${secret.page_id}) have the rest. ` +
        `[Another](/p/${slow.page_id}) is slow.`,
      `Jump to [the plan](#plan) or read [the nteract docs](https://nteract.io).`,
      `Plans live in [the launch Project](/project/${project.project_id}); ` +
        `[Alice's Project](/project/${secretProject.project_id}) is hers.`,
      `Formatted: [the **evening** focus](/p/${target.page_id}), ` +
        `[a <mark data-color="yellow">highlighted</mark> one](/p/${target.page_id}) and ` +
        `[some \`inline code\` too](/p/${target.page_id}).`,
      "## Plan",
      "Anything still open moves to tomorrow's list before standup.",
    ].join("\n\n"),
  });
  const sourceUrl = `${origin}/p/${source.page_id}`;
  // A comment that links to the target: its card offers only Open in new tab.
  const sourceRead = await tool(owner.page, "read_page", { page_id: source.page_id });
  const { result: comment } = await tool(owner.page, "manage_page_comment", {
    page_id: source.page_id,
    action: "add",
    node_id: sourceRead.blocks[0].node_id,
    body: `See [the evening focus](/p/${target.page_id}) before standup.`,
    body_format: "markdown",
    nonce: key(),
  });
  assert.ok(comment?.thread_id, "the comment's thread");
  // The routes themselves: alice's Page is the same 404 as a missing one.
  const meta = await owner.page.request.get(`${origin}/p/${target.page_id}/meta.json`);
  assert.equal(meta.status(), 200);
  assert.equal((await meta.json()).title, TARGET_TITLE);
  const refused = await owner.page.request.get(`${origin}/p/${secret.page_id}/meta.json`);
  const missing = await owner.page.request.get(`${origin}/p/${crypto.randomUUID()}/meta.json`);
  assert.equal(refused.status(), 404);
  assert.equal(await refused.text(), await missing.text());
  checkpoint("meta.json answers the owner and refuses alice's Page like a missing one");
  const projectMeta = await owner.page.request.get(
    `${origin}/project/${project.project_id}/meta.json`,
  );
  assert.equal(projectMeta.status(), 200);
  assert.deepEqual(await projectMeta.json(), {
    v: 1,
    kind: "project",
    project_id: project.project_id,
    title: PROJECT_TITLE,
    description: PROJECT_DESCRIPTION,
    role: "owner",
  });
  const projectRefused = await owner.page.request.get(
    `${origin}/project/${secretProject.project_id}/meta.json`,
  );
  const projectMissing = await owner.page.request.get(
    `${origin}/project/prj_${crypto.randomUUID()}/meta.json`,
  );
  assert.equal(projectRefused.status(), 404);
  assert.equal(await projectRefused.text(), await projectMissing.text());
  assert.equal(
    await projectRefused.text(),
    '{"error":"Project unavailable","code":"project_unavailable"}',
  );
  // The content document's card: its host writes one beside the content
  // flush that followed the edit above.
  let projectCard = null;
  for (let attempt = 0; attempt < 40 && !projectCard; attempt++) {
    const answer = await owner.page.request.get(
      `${origin}/project/${project.project_id}/card.json`,
    );
    assert.equal(answer.status(), 200);
    projectCard = (await answer.json()).card;
    if (!projectCard) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(projectCard, "the Project's content document has a stored card");
  assert.match(JSON.stringify(projectCard.blocks), /This week/);
  checkpoint("Project meta.json and card.json answer dev; alice's Project is a missing one's 404");

  stage = "glyph";
  const { page } = owner;
  await page.goto(sourceUrl);
  await expect(link(page, target.page_id).first()).toBeVisible({ timeout: 30000 });
  await expect(link(page, secret.page_id)).toBeVisible();
  // The section link and the external link draw as ordinary links.
  await expect(page.locator('wg-content a[href$="#plan"]')).not.toHaveClass(/page-link/);
  await expect(page.locator('wg-content a[href^="https://nteract.io"]')).not.toHaveClass(
    /page-link/,
  );
  const glyph = await link(page, target.page_id)
    .first()
    .evaluate((a) => {
      const after = getComputedStyle(a, "::after");
      return { content: after.content, mask: after.maskImage || after.webkitMaskImage };
    });
  // The word joiner, with empty alternative text for the accessible name.
  assert.match(glyph.content, /^"\u2060"( \/ "")?$/);
  assert.match(glyph.mask, /^url\("data:image\/svg\+xml/);
  await expect(link(page, target.page_id).first()).toHaveText("the evening focus");
  // One element, so one glyph, per link however its text is formatted.
  const formatted = page.locator("wg-content p", { hasText: "Formatted:" });
  await expect(formatted.locator("a.page-link")).toHaveText([
    "the evening focus",
    "a highlighted one",
    "some inline code too",
  ]);
  for (const [index, tag] of ["strong", "mark", "code"].entries())
    await expect(formatted.locator("a.page-link").nth(index).locator(tag)).toHaveCount(1);
  const glyphs = await formatted.evaluate(
    (p) =>
      [...p.querySelectorAll("a")].filter((a) =>
        getComputedStyle(a, "::after").maskImage?.startsWith("url("),
      ).length,
  );
  assert.equal(glyphs, 3, "three links, three glyphs");
  checkpoint("only links to other Pages draw the glyph, once per link; the link text is unchanged");
  // Project links draw the Project glyph, a different mask from the Page's.
  await expect(projectLink(page, project.project_id)).toHaveText("the launch Project");
  await expect(projectLink(page, secretProject.project_id)).toHaveText("Alice's Project");
  const projectGlyph = await projectLink(page, project.project_id).evaluate((a) => {
    const after = getComputedStyle(a, "::after");
    return { content: after.content, mask: after.maskImage || after.webkitMaskImage };
  });
  assert.match(projectGlyph.content, /^"\u2060"( \/ "")?$/);
  assert.match(projectGlyph.mask, /^url\("data:image\/svg\+xml/);
  assert.notEqual(projectGlyph.mask, glyph.mask, "the Project glyph isn't the Page glyph");
  checkpoint("Project links draw the Project glyph");

  stage = "caret and copy";
  {
    // Put the caret right after each link's last letter with the keyboard
    // and type: a Page link and an external link behave the same.
    const typedAfter = async (locator) => {
      await locator.click({ position: { x: 4, y: 4 } });
      // The editor opens its link menu on a click; close it.
      await page.keyboard.press("Escape");
      await expect(page.locator(".link-popover")).toHaveCount(0);
      const text = await locator.textContent();
      await locator.evaluate((a, length) => {
        const range = document.createRange();
        range.setStart(a.firstChild, length);
        range.collapse(true);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }, text.length);
      await page.keyboard.type("Z");
      const inside = await locator.textContent();
      await page.keyboard.press("Backspace");
      await expect(locator).toHaveText(text);
      return inside.endsWith("Z");
    };
    const pageLink = await typedAfter(link(page, target.page_id).first());
    const external = await typedAfter(page.locator('wg-content a[href^="https://nteract.io"]'));
    assert.equal(pageLink, external, "a glyph link takes typing at its end like any link");
    // Selecting the paragraph copies its text without the glyph.
    const copied = await link(page, target.page_id)
      .first()
      .evaluate((a) => {
        const range = document.createRange();
        range.selectNodeContents(a.closest("p"));
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return selection.toString();
      });
    assert.match(copied, /^Tonight's list is in the evening focus, and Alice's notes have/);
    assert.doesNotMatch(copied, /\u2060/);
    await page.mouse.click(2, 300);
    checkpoint("the caret, typing and copying around a glyph link behave as for any link");
  }

  stage = "readable card";
  await hover(page, link(page, target.page_id).first(), "readable");
  await expect(card(page).locator(".page-link-card-title")).toHaveText(TARGET_TITLE);
  await expect(card(page)).toContainText(/Edited (just now|\d+ (second|minute)s? ago)/);
  await expect(card(page).getByRole("link", { name: "Open", exact: true })).toBeVisible();
  await expect(card(page).getByRole("button", { name: "Open in new tab" })).toBeVisible();
  // The card's first screen: the stored card once the target's host wrote
  // it, or the Page icon until then.
  await expect(card(page).locator(".index-card-preview")).toBeVisible();
  const focusBefore = await page.evaluate(() => document.activeElement?.className ?? "");
  assert.doesNotMatch(focusBefore, /page-link-card/, "hovering doesn't move focus");
  // Moving from the link into the card keeps it open.
  const box = await card(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 10, { steps: 4 });
  await page.waitForTimeout(400);
  await expect(card(page)).toHaveAttribute("data-face", "readable");
  checkpoint("hovering a Page link shows its title, edit time, first screen and actions");

  stage = "escape";
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
  checkpoint("Escape closes the card");

  stage = "formatted link";
  {
    // Crossing from plain text into the bold word and on keeps one card.
    const bold = formatted.locator("a.page-link").first();
    await hover(page, bold, "readable");
    const box = await bold.boundingBox();
    const y = box.y + box.height / 2;
    for (const x of [box.x + 4, box.x + box.width * 0.45, box.x + box.width - 6]) {
      await page.mouse.move(x, y, { steps: 3 });
      await page.waitForTimeout(250);
      await expect(card(page)).toHaveAttribute("data-face", "readable");
    }
    checkpoint("the pointer crosses a formatted link without the card closing");
  }

  stage = "unavailable card";
  await hover(page, link(page, secret.page_id), "unavailable");
  await expect(card(page)).toHaveText("Page unavailable");
  await expect(card(page).locator("a, button")).toHaveCount(0);
  checkpoint("a Page the reader can't open says only that");

  stage = "Project cards";
  await hover(page, projectLink(page, project.project_id), "readable");
  await expect(card(page)).toHaveAttribute("data-kind", "project");
  await expect(card(page).locator(".page-link-card-kind")).toHaveText("Project");
  await expect(card(page).locator(".page-link-card-title")).toHaveText(PROJECT_TITLE);
  await expect(card(page).locator(".page-link-card-description")).toHaveText(PROJECT_DESCRIPTION);
  await expect(card(page).locator(".index-card-preview")).toContainText("This week");
  await expect(card(page).getByRole("link", { name: "Open", exact: true })).toHaveAttribute(
    "href",
    `${origin}/project/${project.project_id}`,
  );
  await hover(page, projectLink(page, secretProject.project_id), "unavailable");
  await expect(card(page)).toHaveText("Project unavailable");
  await expect(card(page).locator("a, button")).toHaveCount(0);
  checkpoint(
    "a Project link's card shows its title, description and content; alice's says only that",
  );

  stage = "keyboard from a comment link";
  {
    await page.mouse.move(2, 2);
    await expect(card(page)).toHaveCount(0, { timeout: 5000 });
    await page.getByRole("button", { name: /^Comments/ }).click();
    await page.locator(`.thread-row[data-thread-id="${comment.thread_id}"]`).click();
    const commentLink = page.locator(
      `#page-comments .comment-rich-content a.page-link[data-page-id="${target.page_id}"]`,
    );
    await expect(commentLink).toBeVisible();
    // Focus the element before the link, then Tab onto it: keyboard focus.
    await commentLink.evaluate((a) => {
      const all = [...document.querySelectorAll("a[href], button, [tabindex]")];
      const before = all[all.indexOf(a) - 1];
      before?.focus();
    });
    await page.keyboard.press("Tab");
    await expect(commentLink).toBeFocused();
    await expect(card(page)).toHaveAttribute("data-face", "readable", { timeout: 15000 });
    // A comment link's card offers only Open in new tab.
    await expect(card(page).locator(".page-link-card-actions > *")).toHaveText([/Open in new tab/]);
    await expect(page.locator("[data-page-link-announcer]")).toHaveText(TARGET_TITLE);
    await expect(commentLink).toHaveAttribute("aria-describedby", /page-link-card-/);
    await page.keyboard.press("Tab");
    await expect(card(page).getByRole("button", { name: "Open in new tab" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(commentLink).toBeFocused();
    await expect(card(page)).toHaveCount(1);
    // Escape closes the card only: the thread stays open.
    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
    await expect(commentLink).toBeFocused();
    await expect(page.locator(".thread-view")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".thread-view")).toHaveCount(0);
    checkpoint(
      "Tab reaches a comment link's card and Shift-Tab returns; Escape closes only the card",
    );
    await page.goto(sourceUrl);
    await expect(link(page, target.page_id).first()).toBeVisible({ timeout: 30000 });
  }

  stage = "loading card";
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route(`**/p/${slow.page_id}/meta.json`, async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  await page.mouse.move(2, 2);
  await expect(card(page)).toHaveCount(0, { timeout: 5000 });
  await link(page, slow.page_id).hover();
  await expect(card(page)).toHaveAttribute("data-face", "loading", { timeout: 15000 });
  checkpoint("a card waiting for its answer shows a skeleton");

  stage = "screenshots";
  const shots = [];
  const shoot = async (target, name) => {
    const file = `${output}/${name}.png`;
    // The card fades in; shoot it settled.
    await target.evaluate(() =>
      Promise.all(document.getAnimations().map((animation) => animation.finished)),
    );
    await target.screenshot({ path: file });
    shots.push(file);
  };
  await shoot(page, "desktop-light-loading");
  release();
  await expect(card(page)).toHaveAttribute("data-face", "readable", { timeout: 15000 });
  await page.unroute(`**/p/${slow.page_id}/meta.json`);
  for (const scheme of ["light", "dark"])
    for (const [label, viewport] of [
      ["desktop", DESKTOP],
      ["phone", PHONE],
    ]) {
      const context = await browser.newContext({
        viewport,
        colorScheme: scheme,
        storageState: await owner.context.storageState(),
      });
      const shot = await context.newPage();
      shot.on("pageerror", (error) => errors.push(`${label}-${scheme}: ${error.message}`));
      await shot.goto(sourceUrl);
      await expect(link(shot, target.page_id).first()).toBeVisible({ timeout: 30000 });
      await shoot(shot, `${label}-${scheme}-glyph`);
      await hover(shot, link(shot, target.page_id).first(), "readable");
      await expect(card(shot).locator(".page-link-card-title")).toHaveText(TARGET_TITLE);
      await shoot(shot, `${label}-${scheme}-readable`);
      // The card stays inside the viewport.
      const placed = await card(shot).boundingBox();
      assert.ok(placed.x >= 0 && placed.x + placed.width <= viewport.width, `${label} x`);
      assert.ok(placed.y >= 0 && placed.y + placed.height <= viewport.height, `${label} y`);
      await hover(shot, link(shot, secret.page_id), "unavailable");
      await shoot(shot, `${label}-${scheme}-unavailable`);
      await projectLink(shot, project.project_id).scrollIntoViewIfNeeded();
      await hover(shot, projectLink(shot, project.project_id), "readable");
      await expect(card(shot).locator(".page-link-card-description")).toHaveText(
        PROJECT_DESCRIPTION,
      );
      await expect(card(shot).locator(".index-card-preview")).toContainText("This week");
      await shoot(shot, `${label}-${scheme}-project-readable`);
      const projectPlaced = await card(shot).boundingBox();
      assert.ok(
        projectPlaced.x >= 0 && projectPlaced.x + projectPlaced.width <= viewport.width,
        `${label} project x`,
      );
      assert.ok(
        projectPlaced.y >= 0 && projectPlaced.y + projectPlaced.height <= viewport.height,
        `${label} project y`,
      );
      await hover(shot, projectLink(shot, secretProject.project_id), "unavailable");
      await shoot(shot, `${label}-${scheme}-project-unavailable`);
      await context.close();
    }
  checkpoint(`screenshots: ${shots.length} in ${output}`);

  stage = "open in place";
  await hover(page, link(page, target.page_id).first(), "readable");
  await card(page).getByRole("link", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(pageAddress(origin, target.page_id), { timeout: 15000 });
  await expect(page.locator("wg-content").first()).toContainText("Tonight's list, with an owner", {
    timeout: 30000,
  });
  await expect(card(page)).toHaveCount(0);
  checkpoint("Open goes to the Page in place");

  stage = "open a Project in place";
  await page.goto(sourceUrl);
  await expect(projectLink(page, project.project_id)).toBeVisible({ timeout: 30000 });
  await hover(page, projectLink(page, project.project_id), "readable");
  await card(page).getByRole("link", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/project/${project.project_id}`, { timeout: 15000 });
  await expect(page.locator("wg-content").first()).toContainText("Ship the hover card", {
    timeout: 30000,
  });
  // In the Project's content its own link is plain; its Page link isn't.
  const self = page.locator(`wg-content a[href$="/project/${project.project_id}"]`);
  await expect(self).toHaveText("this Project");
  await expect(self).not.toHaveClass(/project-link/);
  await expect(link(page, target.page_id)).toHaveText("the evening focus");
  checkpoint("Open goes to the Project in place, whose content leaves its own link plain");

  stage = "chits";
  {
    // Bare links: an agent's autolinks, to the target, alice's Page and the
    // Project, and a comment holding one.
    const targetUrl = `${origin}/p/${target.page_id}`;
    const chits = await tool(owner.page, "create_page", {
      title: "Chits",
      nonce: key(),
      markdown: [
        `See <${targetUrl}> for tonight's list; <${origin}/p/${secret.page_id}> is Alice's.`,
        `Plans: <${origin}/project/${project.project_id}>. Docs: <https://nteract.io>.`,
        "Paste here:",
      ].join("\n\n"),
    });
    const chitsRead = await tool(owner.page, "read_page", { page_id: chits.page_id });
    const { result: chitComment } = await tool(owner.page, "manage_page_comment", {
      page_id: chits.page_id,
      action: "add",
      node_id: chitsRead.blocks[0].node_id,
      body: `Start from <${targetUrl}>.`,
      body_format: "markdown",
      nonce: key(),
    });
    const chitsUrl = `${origin}/p/${chits.page_id}`;
    const chit = (page, id) =>
      page.locator(`wg-content a.wg-chit:is([data-page-id="${id}"], [data-project-id="${id}"])`);
    const paragraph = (page, index) => page.locator("article wg-content p").nth(index);
    await owner.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const page = owner.page;
    await page.goto(chitsUrl);
    await expect(chit(page, target.page_id)).toHaveText(TARGET_TITLE, { timeout: 30000 });
    await expect(chit(page, secret.page_id)).toHaveText("Page unavailable");
    await expect(chit(page, project.project_id)).toHaveText(PROJECT_TITLE);
    // The external autolink stays a plain link showing its URL.
    await expect(paragraph(page, 1).locator('a[href="https://nteract.io/"]')).toHaveText(
      "https://nteract.io",
    );
    await expect(page.locator("wg-content .wg-chit-source").first()).toBeHidden();
    checkpoint("bare links draw as chits with each reader's title, or Page unavailable");

    await hover(page, chit(page, target.page_id), "readable");
    await expect(card(page).locator(".page-link-card-title")).toHaveText(TARGET_TITLE);
    await page.mouse.move(2, 2);
    await expect(card(page)).toHaveCount(0, { timeout: 5000 });
    await chit(page, target.page_id).click();
    await expect(page.getByRole("dialog", { name: "Link" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Link" })).toContainText(targetUrl);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Link" })).toHaveCount(0);
    checkpoint("a chit opens the hover card, and a click opens the link menu");

    // The caret reveals the URL as text; leaving closes the chit again.
    const first = paragraph(page, 0);
    const box = await first.boundingBox();
    await page.mouse.click(box.x + 2, box.y + box.height / 2);
    await page.keyboard.press("Home");
    for (let i = 0; i < "See ".length; i++) await page.keyboard.press("ArrowRight");
    await expect(chit(page, target.page_id)).toHaveCount(0);
    await expect(first).toContainText(targetUrl);
    await page.keyboard.press("Home");
    await expect(chit(page, target.page_id)).toHaveText(TARGET_TITLE);
    checkpoint("arrowing into a chit shows its URL as text; leaving closes it");

    // Pasting a Page URL makes a bare link, a chit once the caret moves on.
    const third = paragraph(page, 2);
    await third.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" ");
    await page.evaluate((text) => navigator.clipboard.writeText(text), targetUrl);
    await page.keyboard.press("ControlOrMeta+V");
    await expect(third.locator(`a[href="${targetUrl}"]`)).toHaveText(targetUrl);
    await page.keyboard.type(" and on");
    await expect(third.locator("a.wg-chit")).toHaveText(TARGET_TITLE);
    await expect(third).toContainText("and on");
    // Undo takes the typing back, then the link, leaving the URL as text;
    // redo puts both back.
    await page.keyboard.press("ControlOrMeta+Z");
    await page.keyboard.press("ControlOrMeta+Z");
    await expect(third.locator("a")).toHaveCount(0);
    await expect(third).toContainText(targetUrl);
    await page.keyboard.press("ControlOrMeta+Shift+Z");
    await page.keyboard.press("ControlOrMeta+Shift+Z");
    await expect(third.locator("a.wg-chit")).toHaveText(TARGET_TITLE);
    await expect(third).toContainText("and on");
    // Paste as plain text keeps plain text.
    await page.keyboard.press("End");
    await page.keyboard.type(" ");
    // Paste and Match Style (Shift held). Playwright's key table has no
    // editing command for it, so send the key with the command over CDP.
    {
      const cdp = await page.context().newCDPSession(page);
      const shift = { modifiers: 8, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 };
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...shift });
      const v = { modifiers: 8 | 4 | 2, key: "V", code: "KeyV", windowsVirtualKeyCode: 86 };
      await cdp.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        ...v,
        commands: ["pasteAndMatchStyle"],
      });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...v });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...shift, modifiers: 0 });
      await cdp.detach();
    }
    await page.keyboard.type(" plain");
    // One stored link: the chit's hidden source.
    await expect(third.locator("a:not(.wg-chit)")).toHaveCount(1);
    await expect(async () => {
      const read = await tool(page, "read_page", { page_id: chits.page_id, comments: "none" });
      const markdown = read.blocks.map((block) => block.markdown).join("\n\n");
      assert.match(markdown, new RegExp(`Paste here: <${targetUrl}> and on ${targetUrl} plain`));
    }).toPass({ timeout: 15000 });
    checkpoint("a pasted URL is a bare link (<url> to agents); paste as plain text stays text");

    // Copying a chit copies the ordinary link.
    await first.click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await page.keyboard.press("ControlOrMeta+C");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(copied.includes(targetUrl), copied);
    await page.keyboard.press("Home");
    checkpoint("copying across a chit copies its URL");

    // A comment's bare link is a chit too, and a URL pasted into a reply
    // becomes a bare link.
    await page.getByRole("button", { name: /^Comments/ }).click();
    await page.locator(`.thread-row[data-thread-id="${chitComment.thread_id}"]`).click();
    await expect(
      page.locator(
        `#page-comments .comment-rich-content a.wg-chit[data-page-id="${target.page_id}"]`,
      ),
    ).toHaveText(TARGET_TITLE, { timeout: 15000 });
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    const reply = page.locator(".thread-view .comment-rich-editor wg-content").last();
    await expect(reply).toBeFocused();
    await page.evaluate((text) => navigator.clipboard.writeText(text), targetUrl);
    await page.keyboard.press("ControlOrMeta+V");
    await page.keyboard.type(" ok");
    await expect(reply.locator("a.wg-chit")).toHaveText(TARGET_TITLE);
    // A plain click on a chit in a draft doesn't follow it.
    const opened = owner.context.waitForEvent("page", { timeout: 1500 }).catch(() => null);
    await reply.locator("a.wg-chit").click();
    assert.equal(await opened, null, "a draft's chit opened a tab");
    await page.keyboard.press("Escape");
    checkpoint(
      "comments draw chits, and a URL pasted into a reply becomes one that a click doesn't follow",
    );

    for (const scheme of ["light", "dark"])
      for (const [label, viewport] of [
        ["desktop", DESKTOP],
        ["phone", PHONE],
      ]) {
        const context = await browser.newContext({
          viewport,
          colorScheme: scheme,
          storageState: await owner.context.storageState(),
        });
        const shot = await context.newPage();
        shot.on("pageerror", (error) => errors.push(`chits-${label}-${scheme}: ${error.message}`));
        await shot.goto(chitsUrl);
        await expect(chit(shot, target.page_id).first()).toHaveText(TARGET_TITLE, {
          timeout: 30000,
        });
        await shot.screenshot({ path: `${output}/${label}-${scheme}-chits.png` });
        await context.close();
      }
    checkpoint(`chit screenshots in ${output}`);
  }

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ page_id: source.page_id, checks: completed }));
} catch (error) {
  console.error(`Failed at: ${stage}`);
  for (const [i, context] of browser.contexts().entries())
    for (const [j, page] of context.pages().entries())
      await page
        .screenshot({ path: `${output}/failure-${i}-${j}.png`, fullPage: false })
        .catch(() => {});
  console.error("Browser errors:", errors);
  throw error;
} finally {
  await browser.close();
}
