// A Page's scrollbar track against the running local fixture. Chromium runs
// with its scrollbars shown (no --hide-scrollbars), so where they take room the
// Page draws its track before it scrolls: a Page too short to scroll already
// has a layout viewport narrower than the window by the track, and when an
// agent's write grows it past the window the viewport and the article's x
// stay where they were. Playwright's headless Chromium draws classic 15px
// scrollbars once they're shown, on macOS and on the Linux CI runner.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-page-scrollbar";
await mkdir(output, { recursive: true });
/** A classic scrollbar track's width in headless Chromium. */
const TRACK = 15;
const browser = await chromium.launch({
  headless: true,
  ignoreDefaultArgs: ["--hide-scrollbars"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const report = { origin, completed: [], errors: [] };
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
          "X-Pages-Driver": "Page scrollbar QA",
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
const complete = (name) => {
  report.completed.push(name);
  console.log("PASS " + name);
};
const measure = () =>
  page.evaluate(() => ({
    window: innerWidth,
    layout: document.documentElement.clientWidth,
    scrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    article: document.querySelector("main.document > article").getBoundingClientRect().x,
    actions: document.querySelector(".header-actions")?.getBoundingClientRect().right ?? null,
  }));

try {
  await page.goto(origin + "/api/auth/login");
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible();
  const created = await mutate("create_page", {
    title: "Page scrollbar QA",
    markdown: "One short paragraph.",
  });
  pageId = created.page_id;
  await page.goto(`${origin}/p/${pageId}`);
  await expect(page.locator("wg-content").first()).toContainText("One short paragraph.");
  const short = await measure();
  report.short = short;
  assert.equal(short.scrolls, false, "the fixture Page is too short to scroll");
  assert.equal(
    short.window - short.layout,
    TRACK,
    `a Page that doesn't scroll draws its track (window ${short.window}, layout ${short.layout})`,
  );
  complete("a Page too short to scroll keeps its scrollbar track");

  const paragraphs = Array.from(
    { length: 40 },
    (_, i) => `Paragraph ${i + 1}, written while the Page is open, until it scrolls.`,
  );
  await mutate("edit_page", {
    page_id: pageId,
    operations: [{ op: "insert_markdown", markdown: paragraphs.join("\n\n") }],
  });
  await expect(page.locator("wg-content").last()).toContainText("Paragraph 40,", {
    timeout: 20000,
  });
  await expect.poll(async () => (await measure()).scrolls, { timeout: 10000 }).toBe(true);
  const tall = await measure();
  report.tall = tall;
  assert.deepEqual(
    { layout: tall.layout, article: tall.article, actions: tall.actions },
    { layout: short.layout, article: short.article, actions: short.actions },
    "growing past the window moves neither the column nor the header's actions",
  );
  await page.screenshot({ path: `${output}/page-scrollbar.png` });
  complete("growing past the window moves neither the column nor the header's actions");
  assert.deepEqual(report.errors, []);
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
  await writeFile(`${output}/page-scrollbar-report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(`PASS page scrollbar. Artifacts: ${output}`);
