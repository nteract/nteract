// Links between Pages in a real browser, against a running local Wordgard
// fixture: the Page glyph (once per link, however its text is formatted),
// the hover card's faces, crossing a formatted link, Escape, keyboard access
// from a comment link, Open in place, and the caret around a glyph link in
// an editable block.
//
// dev@localhost owns a target Page and a Page that links to it, to a Page
// alice@localhost keeps private, to a heading on the same Page and to an
// external site. alice's Page must read as unavailable to dev.
//
//   PAGES_ORIGIN=http://localhost:9894 node scripts/page-links-smoke.mjs
//
// Screenshots of each face, light and dark, desktop and phone width, land in
// PAGES_SCREENSHOTS. Each check waits on what the reader sees.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

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
    idempotency_key: key(),
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
    base_heads: read.heads,
    idempotency_key: key(),
    operations: [{ op: "insert_markdown", markdown: "Two items need a decision before Friday." }],
  });
  const slow = await tool(owner.page, "create_page", {
    title: "Slow to load",
    idempotency_key: key(),
    markdown: "Nothing to see.",
  });
  const secret = await tool(alice.page, "create_page", {
    title: "Alice's private notes",
    idempotency_key: key(),
    markdown: "Not for dev.",
  });
  const source = await tool(owner.page, "create_page", {
    title: "Links elsewhere",
    idempotency_key: key(),
    markdown: [
      `Tonight's list is in [the evening focus](/p/${target.page_id}), and ` +
        `[Alice's notes](/p/${secret.page_id}) have the rest. ` +
        `[Another](/p/${slow.page_id}) is slow.`,
      `Jump to [the plan](#plan) or read [the nteract docs](https://nteract.io).`,
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
    block_id: sourceRead.blocks[0].id,
    body: `See [the evening focus](/p/${target.page_id}) before standup.`,
    body_format: "markdown",
    idempotency_key: key(),
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
      await context.close();
    }
  checkpoint(`screenshots: ${shots.length} in ${output}`);

  stage = "open in place";
  await hover(page, link(page, target.page_id).first(), "readable");
  await card(page).getByRole("link", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/p/${target.page_id}`, { timeout: 15000 });
  await expect(page.locator("wg-content").first()).toContainText("Tonight's list, with an owner", {
    timeout: 30000,
  });
  await expect(card(page)).toHaveCount(0);
  checkpoint("Open goes to the Page in place");

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
