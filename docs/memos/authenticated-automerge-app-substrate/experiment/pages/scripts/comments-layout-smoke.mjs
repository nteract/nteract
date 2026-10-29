// Comments placement against the running local fixture: measures the Page column
// before and after opening comments at desktop and sheet widths, and checks that
// the docked panel never covers the text column. Screenshots stay in the output
// directory; measurements are written to report.json before any assertion fails.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-comments-layout";
const label = process.env.PAGES_LAYOUT_LABEL || "layout";
// Matches the sheet breakpoint in style.css and CommentsPanel.jsx.
const SHEET_MAX_WIDTH = 900;
const WIDTHS = [1920, 1440, 1100, 800];
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
const report = { origin, label, widths: {}, failures: [], errors: [] };
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
          "X-Pages-Driver": "Comments layout QA",
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
    base_heads:
      operation === "delete_page"
        ? (await call("read_page", { page_id: args.page_id })).heads
        : authority.heads,
    retry_token: authority.retry_token,
    idempotency_key: authority.retry_key_prefix + crypto.randomUUID(),
  });
}
const settle = () =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
// The text column is the article plus the rendered text inside it. A panel that
// intersects either one hides prose.
function measure() {
  return page.evaluate(() => {
    const box = (rect) => ({
      left: Math.round(rect.left * 10) / 10,
      right: Math.round(rect.right * 10) / 10,
      top: Math.round(rect.top * 10) / 10,
      bottom: Math.round(rect.bottom * 10) / 10,
      width: Math.round(rect.width * 10) / 10,
    });
    const article = document.querySelector("main.document > article");
    const lines = [];
    for (const content of article.querySelectorAll("wg-content")) {
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        for (const rect of range.getClientRects()) if (rect.width) lines.push(rect);
      }
    }
    const text = {
      left: Math.min(...lines.map((rect) => rect.left)),
      right: Math.max(...lines.map((rect) => rect.right)),
      top: Math.min(...lines.map((rect) => rect.top)),
      bottom: Math.max(...lines.map((rect) => rect.bottom)),
    };
    const panel = document.getElementById("page-comments");
    return {
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      article: box(article.getBoundingClientRect()),
      text: box({ ...text, width: text.right - text.left }),
      panel: panel?.open ? box(panel.getBoundingClientRect()) : null,
      sheet: !!panel?.classList.contains("comments-sheet"),
      modal: !!panel?.matches(":modal"),
      expanded: !!panel?.classList.contains("comments-expanded"),
    };
  });
}
const intersects = (a, b) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
function check(condition, message) {
  if (!condition) report.failures.push(message);
}
function checkDocked(width, state, name) {
  check(state.panel, `${width} ${name}: panel is open`);
  if (!state.panel) return;
  check(!state.sheet && !state.modal, `${width} ${name}: panel docks beside the Page`);
  check(
    !intersects(state.panel, state.article),
    `${width} ${name}: panel ${JSON.stringify(state.panel)} overlaps article ${JSON.stringify(state.article)}`,
  );
  check(
    state.text.right <= state.panel.left,
    `${width} ${name}: text right ${state.text.right} runs under panel left ${state.panel.left}`,
  );
  check(state.panel.right <= state.viewport, `${width} ${name}: panel stays inside the viewport`);
  check(
    state.scrollWidth <= state.viewport,
    `${width} ${name}: no horizontal scroll (${state.scrollWidth} > ${state.viewport})`,
  );
}
const commentsToggle = () => page.getByRole("button", { name: "Comments", exact: true });
async function closeComments() {
  if (await page.locator("#page-comments[open]").count())
    await page.getByRole("button", { name: "Close comments", exact: true }).click();
  await expect(page.locator("#page-comments")).toBeHidden();
  await settle();
}
async function select(text) {
  const editor = page.locator("wg-content").first();
  await editor.focus();
  await editor.evaluate((element, text) => {
    const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const at = walk.currentNode.textContent.indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(walk.currentNode, at);
      range.setEnd(walk.currentNode, at + text.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return;
    }
    throw Error("Text not found");
  }, text);
  await page.waitForTimeout(80);
}

const paragraph =
  "Pages keeps the reading column centered so a long line of prose sits where the eye expects it, " +
  "and the agent tool surface writes into the same Automerge document that browsers edit live. " +
  "Anyone with access can join from another window and see each change as it lands.";
try {
  await page.goto(origin + "/api/auth/login");
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible();
  const created = await mutate("create_page", {
    title: "Comments layout QA",
    markdown: [paragraph, paragraph, "A passage for discussion sits here.", paragraph].join("\n\n"),
  });
  pageId = created.page_id;
  report.pageId = pageId;
  const document = await call("read_page", { page_id: pageId });
  await mutate("manage_page_comment", {
    page_id: pageId,
    action: "add",
    block_id: document.blocks[0].id,
    selected_text: "passage for discussion",
    body: "Does the panel cover this line?",
    body_format: "plain",
  });
  await page.goto(origin + "/p/" + pageId);
  await expect(page.locator("wg-content").first()).toContainText("reading column");

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 1000 });
    await closeComments();
    const closed = await measure();
    await page.screenshot({ path: `${output}/${label}-${width}-closed.png` });
    await commentsToggle().click();
    await expect(page.locator("#page-comments")).toBeVisible();
    await settle();
    const open = await measure();
    await page.screenshot({ path: `${output}/${label}-${width}-open.png` });
    const entry = (report.widths[width] = {
      closedLeft: closed.article.left,
      openLeft: open.article.left,
      shift: Math.round((open.article.left - closed.article.left) * 10) / 10,
      closedWidth: closed.article.width,
      openWidth: open.article.width,
      textRight: open.text.right,
      panel: open.panel,
      sheet: open.sheet,
      closed,
      open,
    });
    if (width > SHEET_MAX_WIDTH) {
      checkDocked(width, open, "narrow");
      await page.getByRole("button", { name: "Expand comments", exact: true }).click();
      await expect(page.locator("#page-comments.comments-expanded")).toBeVisible();
      await settle();
      const expanded = await measure();
      await page.screenshot({ path: `${output}/${label}-${width}-expanded.png` });
      entry.expanded = {
        articleLeft: expanded.article.left,
        articleWidth: expanded.article.width,
        textRight: expanded.text.right,
        panel: expanded.panel,
      };
      checkDocked(width, expanded, "expanded");
      await page.getByRole("button", { name: "Narrow comments", exact: true }).click();
      await expect(page.locator("#page-comments.comments-expanded")).toHaveCount(0);
    } else {
      check(open.sheet && open.modal, `${width}: comments open as the modal sheet`);
      check(
        Math.abs(entry.shift) < 1 && Math.abs(open.article.width - closed.article.width) < 1,
        `${width}: the sheet leaves the Page column in place`,
      );
    }
    console.log(
      `${label} ${width}: left ${closed.article.left} -> ${open.article.left}, ` +
        `article ${closed.article.width} -> ${open.article.width}, text right ${open.text.right}, ` +
        `panel ${open.panel ? `${open.panel.left}-${open.panel.right}` : "closed"}${open.sheet ? " (sheet)" : ""}`,
    );
  }
  const wide = report.widths[1920];
  check(
    Math.abs(wide.shift) < 1 && Math.abs(wide.openWidth - wide.closedWidth) < 1,
    `1920: the Page column stays put (shift ${wide.shift}, width ${wide.closedWidth} -> ${wide.openWidth})`,
  );

  // Comment on selection opens the panel without moving the Page under the
  // writer, focuses the draft, and keeps it in place while typing.
  await page.setViewportSize({ width: 1920, height: 1000 });
  await closeComments();
  const beforeSelection = await measure();
  await select("reading column");
  await page.getByRole("button", { name: "Comment on selection", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "Comment on selection", exact: true });
  await expect(draft).toBeFocused();
  await expect(page.locator(".composer-context")).toHaveText("reading column");
  await settle();
  const composing = await measure();
  await page.keyboard.type("The column should not move while I type.");
  await settle();
  const typed = await measure();
  await page.screenshot({ path: `${output}/${label}-1920-comment-on-selection.png` });
  report.commentOnSelection = {
    before: beforeSelection.article.left,
    composing: composing.article.left,
    typed: typed.article.left,
  };
  checkDocked(1920, typed, "comment on selection");
  check(
    Math.abs(composing.article.left - beforeSelection.article.left) < 1 &&
      Math.abs(typed.article.left - composing.article.left) < 1,
    `1920 comment on selection: column stays put (${beforeSelection.article.left} -> ${composing.article.left} -> ${typed.article.left})`,
  );
  await expect(draft).toBeFocused();
  await page
    .locator(".comment-composer")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await closeComments();
  check(report.errors.length === 0, `page errors: ${report.errors.join("; ")}`);
} finally {
  if (pageId) {
    try {
      await mutate("delete_page", { page_id: pageId });
      report.fixtureDeleted = true;
    } catch (error) {
      report.cleanupError = error.message;
    }
  }
  await writeFile(`${output}/${label}-report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
for (const failure of report.failures) console.log("FAIL " + failure);
assert.deepEqual(report.failures, [], `${report.failures.length} layout checks failed`);
console.log(`PASS comments layout (${label}). Artifacts: ${output}`);
