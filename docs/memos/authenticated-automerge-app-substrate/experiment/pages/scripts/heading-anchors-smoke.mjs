// Heading links in a real browser, against the running Wordgard fixture: an
// address with a fragment scrolls to its heading, a link to a heading in a
// table cell goes there through the link menu, the # beside a heading copies
// its link, and a link to another Page's heading opens it in place.
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const browser = await chromium.launch({ headless: true });
const errors = [];
const api = async (page, operation, args = {}) => {
  const response = await page.request.post(origin + "/api/tools", {
    data: { operation, arguments: args },
    headers: { Origin: origin },
  });
  assert.ok(response.ok(), await response.text());
  return response.json();
};
const filler = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i + 1} keeps the heading below the fold.`,
).join("\n\n");
// The heading's top edge sits just under the sticky header and toolbar.
const headingInView = async (page, name) => {
  const heading = page.getByRole("heading", { name, exact: true });
  await expect(heading).toBeVisible();
  await expect
    .poll(async () => (await heading.boundingBox())?.y ?? -1, { timeout: 15000 })
    .toBeGreaterThan(40);
  await expect
    .poll(async () => (await heading.boundingBox())?.y ?? 9999, { timeout: 15000 })
    .toBeLessThan(260);
};
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/api/auth/login");
  await expect(page.getByRole("button", { name: "New Page", exact: true })).toBeVisible();
  const target = await api(page, "create_page", {
    title: "Heading anchors " + Date.now(),
    idempotency_key: "anchors-" + crypto.randomUUID(),
    markdown: `Intro.\n\n| Topic | Where |\n| --- | --- |\n| Sync | See [*Getting lean: Automerge*](#getting-lean-automerge) |\n\n${filler}\n\n## Getting lean: Automerge\n\nThe section.\n\n${filler}`,
  });
  const outline = await api(page, "read_page", {
    page_id: target.page_id,
    include_content: false,
  });
  assert.equal(
    outline.outline.entries.find((entry) => entry.type === "heading")?.anchor,
    "getting-lean-automerge",
  );
  const source = await api(page, "create_page", {
    title: "Links elsewhere " + Date.now(),
    idempotency_key: "anchors-" + crypto.randomUUID(),
    markdown: `Read [the Automerge section](/p/${target.page_id}#getting-lean-automerge).`,
  });

  // An address with a fragment scrolls once the Page draws.
  await page.goto(`${origin}/p/${target.page_id}#getting-lean-automerge`);
  await headingInView(page, "Getting lean: Automerge");
  expect(page.url()).toBe(`${origin}/p/${target.page_id}#getting-lean-automerge`);

  // The table cell's link: the link menu offers Go to section.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole("link", { name: "Getting lean: Automerge" }).click();
  const go = page.getByRole("link", { name: "Go to section" });
  await expect(go).toBeVisible();
  await go.click();
  await expect(page.getByRole("dialog", { name: "Link" })).toHaveCount(0);
  await headingInView(page, "Getting lean: Automerge");
  expect(context.pages()).toHaveLength(1);

  // The # beside a hovered heading copies its link.
  await page.goto(`${origin}/p/${target.page_id}`);
  await expect(page.getByRole("status", { name: "All changes saved", exact: true })).toBeVisible({
    timeout: 20000,
  });
  const heading = page.getByRole("heading", { name: "Getting lean: Automerge", exact: true });
  await expect(heading).toBeVisible();
  await heading.hover();
  const copy = page.getByRole("button", {
    name: "Copy link to section Getting lean: Automerge",
  });
  await expect(copy).toBeVisible();
  // It sits left of the heading's text, and stays while the pointer walks to it.
  const [textBox, copyBox] = [await heading.boundingBox(), await copy.boundingBox()];
  assert.ok(copyBox.x + copyBox.width <= textBox.x + 1, "the # is left of the heading");
  await page.mouse.move(copyBox.x + copyBox.width / 2, copyBox.y + copyBox.height / 2, {
    steps: 12,
  });
  await expect(copy).toBeVisible();
  if (process.env.PAGES_SMOKE_SCREENSHOT)
    await page.screenshot({ path: process.env.PAGES_SMOKE_SCREENSHOT });
  await copy.click();
  await expect(page.getByText("Link to section copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `${origin}/p/${target.page_id}#getting-lean-automerge`,
  );

  // Another Page's heading opens in place: no reload, no new tab.
  await page.goto(`${origin}/p/${source.page_id}`);
  await expect(page.getByRole("status", { name: "All changes saved", exact: true })).toBeVisible({
    timeout: 20000,
  });
  await page.evaluate(() => (window.__sameDocument = true));
  await page.locator("wg-content a", { hasText: "the Automerge section" }).click();
  await page.getByRole("link", { name: "Open link" }).click();
  await expect(page).toHaveURL(`${origin}/p/${target.page_id}#getting-lean-automerge`);
  await headingInView(page, "Getting lean: Automerge");
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  expect(context.pages()).toHaveLength(1);
  await page.goBack();
  await expect(page).toHaveURL(`${origin}/p/${source.page_id}`);
  assert.deepEqual(errors, []);
  console.log("heading anchors smoke passed");
} finally {
  await browser.close();
}
