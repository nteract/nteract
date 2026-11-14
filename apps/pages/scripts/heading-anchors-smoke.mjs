// Heading links in a real browser, against a running local Wordgard fixture.
//
// One long Page carries a table with in-page links at the top, two headings
// named "Notes", an image drawn late just above its target heading, and a
// heading with accents, a symbol and CJK. A second Page links to the target's
// heading. The owner edits both; alice@localhost reads the target as a viewer.
//
//   PAGES_ORIGIN=http://localhost:9894 node scripts/heading-anchors-smoke.mjs
//
// Each check waits on what the reader sees (a heading's position, the address,
// a loaded image), never on a fixed delay.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { pageAddress } from "./page-address.mjs";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost", "Generated fixture requires local OIDC");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-heading-anchors";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const completed = [];
const VIEWPORT = { width: 1280, height: 800 };
const TARGET = "Getting lean: Automerge";
const TARGET_ANCHOR = "getting-lean-automerge";
const UNICODE = "Café ✨ 東京";
const UNICODE_ANCHOR = "café-東京";
const IMAGE_ALT = "Sync diagram";
const SKIP = "the last section";

const checkpoint = (name) => {
  completed.push(name);
  console.log("PASS " + name);
};
const filler = (label, count) =>
  Array.from({ length: count }, (_, i) => `${label} paragraph ${i + 1}.`).join("\n\n");

/** A signed-in context for `email` at the loopback issuer. */
async function signIn(email, options = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT, ...options });
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

async function api(page, path, body) {
  const response = await page.request.fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Origin: origin },
    ...(body === undefined ? {} : { data: body }),
  });
  assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
  return response.json();
}
const tool = (page, operation, args = {}) =>
  api(page, "/api/tools", { operation, arguments: args });
const key = () => "anchors-" + crypto.randomUUID();

const heading = (page, name, nth = 0) =>
  page.locator("wg-content").getByRole("heading", { name, exact: true }).nth(nth);
const top = async (locator) => (await locator.boundingBox())?.y ?? Number.NaN;
const docTop = (locator) =>
  locator.evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
// Two animation frames: a scroll the Page would make from what is drawn now
// has happened by then.
const frames = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

/** The heading's top edge sits just under the sticky header and toolbar. */
async function expectInView(locator, timeout = 15000) {
  await expect(locator).toBeVisible({ timeout });
  await expect.poll(() => top(locator), { timeout }).toBeGreaterThan(40);
  await expect.poll(() => top(locator), { timeout }).toBeLessThan(260);
}
async function expectBelowView(locator) {
  await expect(locator).toBeAttached();
  expect(await top(locator)).toBeGreaterThan(VIEWPORT.height);
}

const scrollY = (page) => page.evaluate(() => window.scrollY);
/** The scroll position is `y`, give or take a pixel. */
const expectScrollY = (page, y) =>
  expect.poll(async () => Math.abs((await scrollY(page)) - y), { timeout: 15000 }).toBeLessThan(2);
/** The history entry showing now has recorded the current scroll position:
 * Back and Forward will return to it. */
const expectRecorded = (page) =>
  expect
    .poll(() => page.evaluate(() => history.state?.scroll?.y === window.scrollY), {
      timeout: 15000,
    })
    .toBe(true);

/** Holds the sync socket's messages to the browser until release(): a Page
 * whose sync is slow, while the boot preview shows. */
async function holdSync(context) {
  let released = false;
  const held = [];
  await context.routeWebSocket(/\/api\/sync\?/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((data) => server.send(data));
    server.onMessage((data) => (released ? ws.send(data) : held.push({ ws, data })));
  });
  return {
    release() {
      released = true;
      for (const { ws, data } of held.splice(0)) ws.send(data);
    },
  };
}

/** Holds image asset responses until release(): an image that draws after
 * the Page and its heading. */
async function holdImages(context) {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const seen = [];
  await context.route("**/api/pages/*/assets/*", async (route) => {
    seen.push(route.request().url());
    await gate;
    await route.continue().catch(() => {});
  });
  return { release, seen };
}
const imageLoaded = (page) =>
  expect
    .poll(
      () =>
        page
          .locator("wg-content img")
          .first()
          .evaluate((img) => img.complete && img.naturalWidth > 0)
          .catch(() => false),
      { timeout: 15000 },
    )
    .toBe(true);

let stage = "sign in";
try {
  const owner = await signIn("dev@localhost");
  await owner.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });

  stage = "create the Pages";
  // Block 1: the table of links, then enough text to put everything below
  // the fold, then the first "Notes".
  const target = await tool(owner.page, "create_page", {
    title: "Heading anchors " + Date.now(),
    nonce: key(),
    markdown: [
      "Intro.",
      "| Topic | Where |\n| --- | --- |\n" +
        `| Sync | See [*${TARGET}*](#${TARGET_ANCHOR}) |\n` +
        "| Later notes | [the second Notes](#notes-1) |",
      filler("Lead", 40),
      "## Notes",
      "First notes.",
      `Skip ahead to [${SKIP}](#${encodeURIComponent(UNICODE_ANCHOR)}).`,
      filler("Middle", 20),
    ].join("\n\n"),
  });
  const pageId = target.page_id;
  const first = (await tool(owner.page, "read_page", { page_id: pageId })).blocks[0].node_id;
  // Block 2: an image a few lines above the target heading.
  const png = await owner.page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 720;
    canvas.height = 480;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#dbe7f3";
    ctx.fillRect(0, 0, 720, 480);
    ctx.fillStyle = "#1d3557";
    ctx.font = "bold 40px sans-serif";
    ctx.fillText("Sync diagram", 40, 80);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const uploaded = await owner.page.request.post(`${origin}/api/pages/${pageId}/assets`, {
    data: Buffer.from(png, "base64"),
    headers: { Origin: origin, "Content-Type": "image/png" },
  });
  assert.equal(uploaded.status(), 201, await uploaded.text());
  const asset = await uploaded.json();
  let read = await tool(owner.page, "read_page", { page_id: pageId, include_content: false });
  const inserted = await tool(owner.page, "edit_page", {
    page_id: pageId,
    revision: read.revision,
    nonce: key(),
    operations: [
      { op: "insert_image", after_node_id: first, asset_id: asset.asset_id, alt: IMAGE_ALT },
    ],
  });
  // Block 3: the target heading, the second "Notes", and the Unicode heading.
  await tool(owner.page, "edit_page", {
    page_id: pageId,
    revision: inserted.revision,
    nonce: key(),
    operations: [
      {
        op: "insert_markdown",
        after_node_id: inserted.result.edits[0].node_id,
        markdown: [
          "Just above the section.",
          `## ${TARGET}`,
          "The section.",
          filler("After", 20),
          "## Notes",
          "Second notes.",
          filler("Late", 10),
          `### ${UNICODE}`,
          "Last section.",
          filler("Tail", 40),
        ].join("\n\n"),
      },
    ],
  });
  const source = await tool(owner.page, "create_page", {
    title: "Links elsewhere " + Date.now(),
    nonce: key(),
    markdown: [
      filler("Before", 30),
      `Read [the Automerge section](/p/${pageId}#${TARGET_ANCHOR}).`,
      filler("Beyond", 30),
    ].join("\n\n"),
  });
  const targetUrl = (anchor) => `${origin}/p/${pageId}#${encodeURIComponent(anchor)}`;
  // The address names the same heading with or without the title's slug.
  const targetAddress = (anchor) => pageAddress(origin, pageId, `#${encodeURIComponent(anchor)}`);

  // alice reads the target Page as a viewer.
  const access = await api(owner.page, `/api/access?page=${pageId}`);
  await api(owner.page, `/api/access?page=${pageId}`, {
    action: "invite",
    email: "alice@localhost",
    role: "viewer",
    expected_revision: access.access.revision,
    nonce: key(),
  });

  stage = "read_page outline anchors";
  const outline = [];
  for (let offset = 0, heads; offset !== null; ) {
    read = await tool(owner.page, "read_page", {
      page_id: pageId,
      include_content: false,
      outline_offset: offset,
      ...(heads ? { revision: heads } : {}),
    });
    heads = read.revision;
    for (const entry of read.outline.entries)
      if (entry.type === "heading") outline.push(entry.anchor);
    offset = read.outline.next_offset ?? null;
  }
  assert.deepEqual(outline, ["notes", TARGET_ANCHOR, "notes-1", UNICODE_ANCHOR]);
  checkpoint("read_page's outline names every heading's anchor, duplicates numbered");

  stage = "cold load of a shared link";
  {
    const { page } = owner;
    const images = await holdImages(owner.context);
    await page.goto(targetUrl(TARGET_ANCHOR));
    const section = heading(page, TARGET);
    await expectInView(section);
    expect(page.url()).toMatch(targetAddress(TARGET_ANCHOR));
    // The image above the heading draws only now, pushing the heading down
    // the document; the heading stays in view.
    const before = await docTop(section);
    images.release();
    await imageLoaded(page);
    await expect.poll(() => docTop(section)).toBeGreaterThan(before + 100);
    await expectInView(section);
    await frames(page);
    await expectInView(section);
    await owner.context.unroute("**/api/pages/*/assets/*");
    checkpoint("a shared link scrolls to its heading and holds it through a late image");
  }

  stage = "warm reload";
  // From the top, so the browser's own scroll restoration can't pass for it.
  await owner.page.evaluate(() => window.scrollTo(0, 0));
  await owner.page.reload();
  await expectInView(heading(owner.page, TARGET));
  checkpoint("a reload with the Page cached scrolls to the heading again");

  stage = "fresh browser context";
  const reader = await signIn("alice@localhost");
  await reader.page.goto(targetUrl(TARGET_ANCHOR));
  await expectInView(heading(reader.page, TARGET), 30000);
  await expect(reader.page.locator("wg-content").first()).not.toHaveAttribute(
    "contenteditable",
    "true",
  );
  checkpoint("the link scrolls in a fresh context with nothing cached, read-only");

  stage = "duplicate headings";
  // about:blank first, so each goto loads the Page instead of changing the
  // fragment of the one open.
  await reader.page.goto("about:blank");
  await reader.page.goto(targetUrl("notes-1"));
  await expectInView(heading(reader.page, "Notes", 1));
  expect(await top(heading(reader.page, "Notes", 0))).toBeLessThan(0);
  checkpoint("#notes-1 shows the second heading named Notes");

  stage = "Unicode heading";
  // Same Page, new fragment: a hash change, as if typed into the address bar.
  await reader.page.goto(targetUrl(UNICODE_ANCHOR));
  await expectInView(heading(reader.page, UNICODE));
  checkpoint("a fragment changed in the address finds a percent-encoded Unicode heading");

  stage = "unknown anchor";
  {
    const { page } = reader;
    const before = errors.length;
    await page.goto("about:blank");
    await page.goto(targetUrl("no-such-heading"));
    // The whole Page has drawn, so a matching heading would have been found.
    await expect(page.locator("wg-content").last()).toContainText("Tail paragraph 40.");
    await frames(page);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expectBelowView(heading(page, "Notes"));
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(errors.slice(before)).toEqual([]);
    checkpoint("an unknown anchor leaves the Page at its top without an error");
  }

  stage = "in-page link, read-only";
  {
    const { page } = reader;
    // Still at the top from the unknown anchor.
    await page.evaluate(() => (window.__anchorMarker = "same document"));
    await page.locator("wg-content table a", { hasText: TARGET }).click();
    await expect(page).toHaveURL(targetAddress(TARGET_ANCHOR));
    await expectInView(heading(page, TARGET));
    await expect(page.getByRole("dialog", { name: "Link" })).toHaveCount(0);
    expect(await page.evaluate(() => window.__anchorMarker)).toBe("same document");
    expect(reader.context.pages()).toHaveLength(1);
    checkpoint("a table cell's in-page link scrolls a read-only Page without a reload");
  }

  stage = "in-page link, editor";
  {
    const { page } = owner;
    await page.goto(`${origin}/p/${pageId}`);
    await expect(page.locator("wg-content").last()).toContainText("Tail paragraph 40.");
    await page.evaluate(() => (window.__anchorMarker = "same document"));
    await page.locator("wg-content table a", { hasText: "the second Notes" }).click();
    const go = page.getByRole("link", { name: "Go to section" });
    await expect(go).toBeVisible();
    await go.click();
    await expect(page.getByRole("dialog", { name: "Link" })).toHaveCount(0);
    await expect(page).toHaveURL(targetAddress("notes-1"));
    await expectInView(heading(page, "Notes", 1));
    expect(await page.evaluate(() => window.__anchorMarker)).toBe("same document");
    expect(owner.context.pages()).toHaveLength(1);
    checkpoint("the editor's link menu offers Go to section and goes there in place");
  }

  stage = "copy a heading's link";
  {
    const { page } = owner;
    await page.goto(`${origin}/p/${pageId}`);
    for (const [name, nth, anchor] of [
      [TARGET, 0, TARGET_ANCHOR],
      ["Notes", 1, "notes-1"],
      [UNICODE, 0, UNICODE_ANCHOR],
    ]) {
      const section = heading(page, name, nth);
      await section.scrollIntoViewIfNeeded();
      await section.hover();
      const copy = page.getByRole("button", { name: `Copy link to section ${name}` });
      await expect(copy).toBeVisible();
      // It sits left of the heading's text and stays while the pointer walks to it.
      const [text, button] = [await section.boundingBox(), await copy.boundingBox()];
      assert.ok(button.x + button.width <= text.x + 1, "the # is left of the heading");
      await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2, {
        steps: 8,
      });
      await expect(copy).toBeVisible();
      // The gutter is part of the heading's row: pointing straight at the
      // "#" from away from the heading shows it.
      await page.mouse.move(text.x + text.width / 2, text.y + text.height + 200);
      await expect(copy).toBeHidden();
      await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
      await expect(copy).toBeVisible();
      await copy.click();
      await expect(page.getByText("Link to section copied")).toBeVisible();
      // The copied link is the viewer's anchor, and the outline's.
      expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
        targetAddress(anchor),
      );
      await expect(page).toHaveURL(targetAddress(anchor));
    }
    await page.screenshot({ path: `${output}/heading-anchor-copy.png` });
    checkpoint("the # copies the full link, matching read_page's anchors");
  }

  stage = "Back and Forward on the same Page";
  {
    const { page } = reader;
    await page.goto("about:blank");
    await page.goto(`${origin}/p/${pageId}`);
    await expect(page.locator("wg-content").last()).toContainText("Tail paragraph 40.");
    const skip = page.locator("wg-content a", { hasText: SKIP });
    await skip.scrollIntoViewIfNeeded();
    await expect(skip).toBeInViewport();
    const before = await scrollY(page);
    expect(before).toBeGreaterThan(0);
    await skip.click();
    await expect(page).toHaveURL(targetAddress(UNICODE_ANCHOR));
    await expectInView(heading(page, UNICODE));
    const landed = await scrollY(page);
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, 200);
    await expect.poll(() => scrollY(page)).toBeGreaterThan(landed + 100);
    await expectRecorded(page);
    const after = await scrollY(page);
    await page.goBack();
    await expect(page).toHaveURL(pageAddress(origin, pageId));
    await expectScrollY(page, before);
    await frames(page);
    await expectScrollY(page, before);
    await page.goForward();
    await expect(page).toHaveURL(targetAddress(UNICODE_ANCHOR));
    await expectScrollY(page, after);
    await frames(page);
    await expectScrollY(page, after);
    checkpoint("Back and Forward between a Page and its heading restore each position");
  }

  stage = "cross-Page link";
  {
    const { page } = owner;
    await page.goto(`${origin}/p/${source.page_id}`);
    const link = page.locator("wg-content a", { hasText: "the Automerge section" });
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeInViewport();
    const position = await page.evaluate(() => window.scrollY);
    expect(position).toBeGreaterThan(0);
    await page.evaluate(() => (window.__anchorMarker = "same document"));
    await link.click();
    const open = page.getByRole("link", { name: "Open link" });
    await expect(open).toBeVisible();
    const before = await scrollY(page);
    expect(before).toBeGreaterThan(0);
    await open.click();
    await expect(page).toHaveURL(targetAddress(TARGET_ANCHOR));
    await expectInView(heading(page, TARGET));
    expect(await page.evaluate(() => window.__anchorMarker)).toBe("same document");
    expect(owner.context.pages()).toHaveLength(1);
    // The reader moves on a little from the heading, and that entry records it.
    const landed = await scrollY(page);
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => scrollY(page)).toBeGreaterThan(landed + 100);
    await expectRecorded(page);
    const after = await scrollY(page);
    // Back shows the source Page again in the same document, where it was.
    await page.goBack();
    await expect(page).toHaveURL(pageAddress(origin, source.page_id));
    await expect(link).toBeAttached();
    await expectScrollY(page, before);
    await frames(page);
    await expectScrollY(page, before);
    await expect(link).toBeInViewport();
    expect(await page.evaluate(() => window.__anchorMarker)).toBe("same document");
    // Forward returns to where the reader left the other Page, not its heading.
    await page.goForward();
    await expect(page).toHaveURL(targetAddress(TARGET_ANCHOR));
    await expectScrollY(page, after);
    await frames(page);
    await expectScrollY(page, after);
    expect(await page.evaluate(() => window.__anchorMarker)).toBe("same document");
    checkpoint("another Page's heading opens in place; Back and Forward restore each position");
  }

  stage = "reader scrolls while the heading settles";
  {
    // A fresh context, so the image isn't in its cache.
    const late = await signIn("dev@localhost");
    const { page } = late;
    const images = await holdImages(late.context);
    await page.goto(targetUrl(TARGET_ANCHOR));
    const section = heading(page, TARGET);
    await expectInView(section);
    // The reader scrolls back up; the image then draws above the heading.
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, -400);
    await expect.poll(() => top(section)).toBeGreaterThan(400);
    images.release();
    await imageLoaded(page);
    await frames(page);
    expect(await top(section)).toBeGreaterThan(400);
    checkpoint("scrolling during the settle stops the scroll to the heading");
    await late.context.close();
  }

  stage = "slow sync, reader waits";
  {
    // A fresh context: nothing cached, so the boot preview shows while the
    // sync socket is held.
    const slow = await signIn("dev@localhost");
    const { page } = slow;
    const sync = await holdSync(slow.context);
    await page.goto(targetUrl(TARGET_ANCHOR));
    await expect(page.locator(".page-preview")).toBeVisible({ timeout: 15000 });
    sync.release();
    await expectInView(heading(page, TARGET), 30000);
    checkpoint("a held sync still scrolls to the heading once it lets through");
    await slow.context.close();
  }

  stage = "slow sync, reader scrolls the preview";
  {
    const slow = await signIn("dev@localhost");
    const { page } = slow;
    const sync = await holdSync(slow.context);
    await page.goto(targetUrl(TARGET_ANCHOR));
    await expect(page.locator(".page-preview")).toBeVisible({ timeout: 15000 });
    await expect(page.locator("wg-content")).toHaveCount(0);
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => scrollY(page)).toBeGreaterThan(0);
    sync.release();
    // The whole Page draws; a scroll to the heading would have happened by
    // two frames later.
    await expect(page.locator("wg-content").last()).toContainText("Tail paragraph 40.", {
      timeout: 30000,
    });
    await frames(page);
    await expectBelowView(heading(page, TARGET));
    checkpoint("scrolling the preview before sync completes cancels the scroll to the heading");
    await slow.context.close();
  }

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ page_id: pageId, checks: completed }));
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
