// Comment review mode against the running local fixture, at a wide and a
// narrow width. Review shows each thread's messages whole, with no Show more,
// through J and Resolve and next. While review is open the Page behind it
// holds still: wheel over every part of the workspace and its margins, and a
// touch drag over the conversation, leave the document's scroll where it was,
// including when a column is already at its top or bottom. The account
// menu's appearance controls open above review and change the theme without
// ending it. Exiting review leaves the Page at that same position.
// Measurements are written to review-report.json before any assertion fails.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-comments-review";
// 1440 shows the navigator and conversation docked; 800 is the bottom sheet.
const WIDTHS = [1440, 800];
const HEIGHT = 900;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: HEIGHT } });
const page = await context.newPage();
const report = { origin, widths: {}, failures: [], errors: [] };
page.on("pageerror", (error) => report.errors.push(error.message));
let pageId;

async function call(operation, args = {}) {
  return page.evaluate(
    async ({ operation, args }) => {
      const response = await fetch("/mcp", {
        credentials: "same-origin",
        signal: AbortSignal.timeout(10000),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Pages-Driver": "Comments review QA",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: { name: operation, arguments: args },
        }),
      });
      if (!response.ok) throw Error(`${operation}: HTTP ${response.status}`);
      const envelope = await response.json();
      if (envelope.error) throw Error(`${operation}: JSON-RPC error ${envelope.error.code}`);
      const result = envelope.result;
      const text = result?.content?.find((entry) => entry.type === "text")?.text;
      if (typeof text !== "string") throw Error(`${operation}: missing MCP text result`);
      const data = JSON.parse(text);
      if (result.isError) throw Error(`${operation}: tool error ${data.code ?? "unspecified"}`);
      return data;
    },
    { operation, args },
  );
}
async function mutate(operation, args = {}) {
  const catalog = ["create_page", "delete_page"].includes(operation);
  const authority = await call(
    catalog ? "list_pages" : "read_page",
    catalog ? {} : { page_id: args.page_id },
  );
  return call(operation, {
    ...args,
    revision:
      operation === "delete_page"
        ? (await call("read_page", { page_id: args.page_id })).revision
        : authority.revision,
    nonce: crypto.randomUUID(),
  });
}
function check(condition, message) {
  if (!condition) report.failures.push(message);
}
const settle = () =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
const scrollY = () => page.evaluate(() => Math.round(scrollY));
// Lets a wheel or gesture's scroll, smooth or chained, finish before reading.
const rest = async () => {
  await page.waitForTimeout(250);
  await settle();
};
// Center of the first visible match, or null when that part is hidden at this width.
async function centerOf(selector) {
  const box = await page
    .locator(selector)
    .first()
    .boundingBox()
    .catch(() => null);
  return box && box.width && box.height
    ? { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 40) }
    : null;
}
async function wheel(at, deltaY) {
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, deltaY);
  await rest();
}
// A one-finger drag through Chromium's gesture pipeline, the way a phone scrolls.
async function touchDrag(cdp, at, distance) {
  await cdp.send("Input.synthesizeScrollGesture", {
    x: Math.round(at.x),
    y: Math.round(at.y),
    yDistance: distance,
    gestureSourceType: "touch",
    speed: 2000,
  });
  await rest();
}
async function messagesClamped() {
  return page.locator("#page-comments .thread-view").evaluate((view) => ({
    clamped: view.querySelectorAll(".message-body-clamped").length,
    more: view.querySelectorAll(".message-more").length,
    bodies: view.querySelectorAll(".message-body").length,
  }));
}

const paragraph =
  "Pages keeps the reading column centered so a long line of prose sits where the eye expects it, " +
  "and the agent tool surface writes into the same Automerge document that browsers edit live.";
const longBody = (topic) =>
  [
    `About ${topic}: this note runs long on purpose.`,
    ...Array.from(
      { length: 8 },
      (_, index) => `Point ${index + 1}. A reviewer reads every line before resolving.`,
    ),
  ].join("\n");

try {
  await page.goto(origin + "/api/auth/login");
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible();
  const markdown = Array.from({ length: 40 }, (_, index) =>
    index === 18
      ? "The first passage for review sits here."
      : index === 24
        ? "The second passage for review sits here."
        : `Paragraph ${index + 1}: ${paragraph}`,
  ).join("\n\n");
  const created = await mutate("create_page", { title: "Comments review QA", markdown });
  pageId = created.page_id;
  report.pageId = pageId;
  const document = await call("read_page", { page_id: pageId });
  for (const quote of ["first passage for review", "second passage for review"])
    await mutate("manage_page_comment", {
      page_id: pageId,
      action: "add",
      node_id: document.blocks.find((block) => JSON.stringify(block).includes(quote)).node_id,
      selected_text: quote,
      body: longBody(quote),
      body_format: "plain",
    });
  await page.goto(origin + "/p/" + pageId);
  await expect(page.locator("wg-content").first()).toContainText("reading column");

  for (const width of WIDTHS) {
    const at = String(width);
    const entry = (report.widths[at] = { wheel: {}, touch: {} });
    // A fresh load opens comments on the thread list, where Review starts.
    await page.setViewportSize({ width, height: HEIGHT });
    await page.goto(origin + "/p/" + pageId);
    await expect(page.locator("wg-content").first()).toContainText("reading column");
    await expect(page.locator("#page-comments")).toBeHidden();
    await page.evaluate(() => scrollTo(0, 0));
    await page.mouse.move(width / 2, HEIGHT / 2);
    await page.mouse.wheel(0, 900);
    await rest();
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    await expect(page.locator("#page-comments")).toBeVisible();
    await page.getByRole("button", { name: "Review open threads", exact: true }).click();
    await expect(page.locator("#page-comments.comments-review")).toBeVisible();
    await rest();
    const start = await scrollY();
    entry.start = start;
    check(start > 0, `${at}: the Page is scrolled before review (${start})`);
    entry.overflow = await page.evaluate(() => getComputedStyle(document.documentElement).overflow);
    await page.screenshot({ path: `${output}/review-${at}.png` });

    const whole = await messagesClamped();
    entry.messages = whole;
    check(
      whole.bodies > 0 && whole.clamped === 0 && whole.more === 0,
      `${at}: review shows the thread whole ${JSON.stringify(whole)}`,
    );

    // Each region, then each scrolling column pushed past both ends.
    const regions = {
      heading: ".review-heading",
      keys: ".review-keys",
      columnHead: ".review-conversation .review-column-head",
      navigator: ".review-navigator .comments-list",
      excerpt: ".page-excerpt",
      conversation: ".review-conversation .thread-view-scroll",
      dock: ".review-dock",
    };
    for (const [name, selector] of Object.entries(regions)) {
      const point = await centerOf(selector);
      if (!point) continue;
      for (const delta of [-1200, 2400, 2400, -2400, -2400]) await wheel(point, delta);
      entry.wheel[name] = await scrollY();
      check(entry.wheel[name] === start, `${at}: wheel over ${name} moved the Page`);
    }
    // The margin around the workspace, where the Page itself shows.
    const panel = await page.locator("#page-comments").boundingBox();
    if (panel.y > 20) {
      const margin = { x: Math.max(4, panel.x / 2), y: panel.y / 2 + 4 };
      for (const delta of [800, -800]) await wheel(margin, delta);
      entry.wheel.margin = await scrollY();
      check(entry.wheel.margin === start, `${at}: wheel over the margin moved the Page`);
    }

    const cdp = await context.newCDPSession(page);
    const conversation = await centerOf(".review-conversation .thread-view-scroll");
    for (const distance of [-1200, 1200, -1200]) await touchDrag(cdp, conversation, distance);
    entry.touch.conversation = await scrollY();
    check(
      entry.touch.conversation === start,
      `${at}: a touch drag over the conversation moved the Page`,
    );
    await cdp.detach();

    // Hovering Resolve and next fills it with the resolve green in both themes.
    entry.hover = {};
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator(`:root.${colorScheme}`)).toHaveCount(1);
      await page.locator(".review-resolve-next").hover();
      await rest();
      const hover = await page.locator(".review-resolve-next").evaluate((button) => {
        const probe = document.body.appendChild(document.createElement("div"));
        probe.style.background = "var(--success)";
        const success = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const style = getComputedStyle(button);
        return { background: style.backgroundColor, color: style.color, success };
      });
      entry.hover[colorScheme] = hover;
      check(
        hover.background === hover.success,
        `${at} ${colorScheme}: hovered Resolve and next is the resolve green ${JSON.stringify(hover)}`,
      );
      await page.screenshot({ path: `${output}/review-${at}-${colorScheme}-hover.png` });
    }
    await page.emulateMedia({ colorScheme: null });
    await page.mouse.move(4, 4);

    // The account menu's appearance controls switch the theme during review.
    // Beside the Page the menu opens over the workspace and review stays up;
    // a click back in the conversation returns the review keys. The sheet is
    // modal, so a tap outside it closes it and Comments brings review back.
    const sheet = await page
      .locator("#page-comments")
      .evaluate((dialog) => dialog.matches(":modal"));
    entry.appearance = { sheet };
    if (sheet) {
      await page.mouse.click(width / 2, 20);
      await expect(page.locator("#page-comments")).toBeHidden();
    }
    await page.locator("details.account-actions summary").click();
    const dark = page.getByRole("button", { name: "Dark", exact: true });
    await expect(dark).toBeVisible();
    entry.appearance.menuOnTop = await dark.evaluate((button) => {
      const box = button.getBoundingClientRect();
      return button.contains(
        document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
      );
    });
    check(entry.appearance.menuOnTop, `${at}: the appearance controls open above review`);
    await dark.click();
    await expect(page.locator(":root.dark")).toHaveCount(1);
    await page.screenshot({ path: `${output}/review-${at}-appearance.png` });
    await page.getByRole("button", { name: "System", exact: true }).click();
    await expect(page.locator(":root.light")).toHaveCount(1);
    if (sheet) await page.getByRole("button", { name: "Comments", exact: true }).click();
    else await page.locator("#page-comments .thread-view .message-body").first().click();
    await expect(page.locator("details.account-actions[open]")).toHaveCount(0);
    await expect(page.locator("#page-comments.comments-review")).toBeVisible();
    entry.appearance.focusInReview = await page.evaluate(() =>
      document.getElementById("page-comments").contains(document.activeElement),
    );
    check(entry.appearance.focusInReview, `${at}: review has the keyboard after a theme change`);
    await rest();

    await page.keyboard.press("j");
    await rest();
    const next = await messagesClamped();
    entry.afterNext = next;
    check(next.clamped === 0 && next.more === 0, `${at}: J keeps the next thread whole`);
    await page.keyboard.press("k");
    await rest();

    await page.getByRole("button", { name: "Exit review", exact: true }).click();
    await expect(page.locator("#page-comments.comments-review")).toHaveCount(0);
    await rest();
    entry.afterExit = await scrollY();
    entry.overflowAfterExit = await page.evaluate(
      () => getComputedStyle(document.documentElement).overflow,
    );
    check(entry.overflowAfterExit !== "hidden", `${at}: exiting review frees the Page's scroll`);
    check(
      Math.abs(entry.afterExit - start) <= 1,
      `${at}: exiting review leaves the Page where it was (${start} -> ${entry.afterExit})`,
    );
    const clampedAgain = await messagesClamped();
    check(clampedAgain.more > 0, `${at}: the panel's thread view still offers Show more`);
    await page.screenshot({ path: `${output}/review-${at}-exited.png` });
    console.log(`review ${at}: ${JSON.stringify(entry)}`);
  }
  check(report.errors.length === 0, `page errors: ${report.errors.join("; ")}`);
} finally {
  if (pageId) {
    try {
      if (!page.url().startsWith(origin)) await page.goto(origin);
      await mutate("delete_page", { page_id: pageId });
      report.fixtureDeleted = true;
    } catch (error) {
      report.cleanupError = error.message;
    }
  }
  await writeFile(`${output}/review-report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
for (const failure of report.failures) console.log("FAIL " + failure);
assert.deepEqual(report.failures, [], `${report.failures.length} review checks failed`);
console.log(`PASS comments review. Artifacts: ${output}`);
