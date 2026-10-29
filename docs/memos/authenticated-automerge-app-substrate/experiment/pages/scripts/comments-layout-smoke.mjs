// Comments placement against the running local fixture. At each width it
// measures the Page column before and after opening comments, narrow and
// expanded, and asserts the geometry from style.css: the panel starts at the
// Page's right edge, never covers prose, and the Page only moves or narrows
// when the right gutter cannot hold the panel. A zoomed iframe produces a
// 900.5px viewport to cover the boundary between the sheet and docked queries.
// Measurements are written to <label>-report.json before any assertion fails.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { COMMENTS_SHEET_QUERY } from "../viewer/comments-layout.mjs";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-comments-layout";
const label = process.env.PAGES_LAYOUT_LABEL || "layout";
const WIDTHS = [2560, 1920, 1536, 1440, 1366, 1280, 1180, 1100, 901, 800];
// Mirrors style.css: Page box, panel widths, and the 24px viewport margin.
const PAGE_WIDTH = 1056,
  PAGE_PADDING = 24,
  PANEL_WIDTH = 312,
  PANEL_MARGIN = 24;
const TOLERANCE = 1;
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

// Expected open layout for a viewport of `width` CSS px, from style.css.
function expectedLayout(width, expanded) {
  const panelWidth = expanded ? Math.min(680, Math.max(PANEL_WIDTH, width - 600)) : PANEL_WIDTH;
  const reserve = panelWidth + PANEL_MARGIN;
  const pageWidth = Math.min(PAGE_WIDTH, width - reserve);
  const pageLeft = Math.max(0, Math.min((width - pageWidth) / 2, width - pageWidth - reserve));
  return {
    panelWidth,
    panelLeft: pageLeft + pageWidth,
    articleLeft: pageLeft + PAGE_PADDING,
    articleWidth: pageWidth - 2 * PAGE_PADDING,
    centered: width >= PAGE_WIDTH + 2 * reserve,
  };
}
const settle = (target) =>
  target.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
// The text column is the article plus the rendered text inside it. A panel that
// intersects either one hides prose. The viewport width comes from a fixed
// probe because innerWidth rounds fractional widths.
function measure(target) {
  return target.evaluate((sheetQuery) => {
    const box = (rect) => ({
      left: Math.round(rect.left * 100) / 100,
      right: Math.round(rect.right * 100) / 100,
      top: Math.round(rect.top * 100) / 100,
      bottom: Math.round(rect.bottom * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
    });
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:0;right:0;top:0;height:0;visibility:hidden";
    document.body.append(probe);
    const viewport = probe.getBoundingClientRect().width;
    probe.remove();
    const article = document.querySelector("main.document > article");
    const lines = [],
      contents = [...article.querySelectorAll("wg-content")];
    for (const content of contents) {
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
      viewport,
      sheetQuery: matchMedia(sheetQuery).matches,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      article: box(article.getBoundingClientRect()),
      text: box({ ...text, width: text.right - text.left }),
      contentRight: Math.max(...contents.map((content) => content.getBoundingClientRect().right)),
      panel: panel?.open ? box(panel.getBoundingClientRect()) : null,
      sheet: !!panel?.classList.contains("comments-sheet"),
      modal: !!panel?.matches(":modal"),
      expanded: !!panel?.classList.contains("comments-expanded"),
    };
  }, COMMENTS_SHEET_QUERY);
}
const intersects = (a, b) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const near = (actual, expected) => Math.abs(actual - expected) <= TOLERANCE;
function check(condition, message) {
  if (!condition) report.failures.push(message);
}
function checkDocked(name, state, expanded) {
  const at = `${name} ${expanded ? "expanded" : "narrow"}`;
  check(state.panel, `${at}: panel is open`);
  if (!state.panel) return;
  check(!state.sheet && !state.modal, `${at}: panel docks beside the Page`);
  check(
    !intersects(state.panel, state.article),
    `${at}: panel ${JSON.stringify(state.panel)} overlaps article ${JSON.stringify(state.article)}`,
  );
  // Main and article padding put 3rem between the editor box and the panel.
  // Rendered glyphs can hang a trailing space past the editor box, so they only
  // need to stay clear of the panel by one padding.
  check(
    near(state.panel.left - state.contentRight, 2 * PAGE_PADDING),
    `${at}: editor ends ${state.panel.left - state.contentRight}px from the panel, expected ${2 * PAGE_PADDING}`,
  );
  check(
    state.panel.left - state.text.right >= PAGE_PADDING,
    `${at}: prose ends ${state.panel.left - state.text.right}px from the panel`,
  );
  check(
    near(state.panel.left - state.article.right, PAGE_PADDING),
    `${at}: panel starts at the Page's right edge (article right ${state.article.right}, panel left ${state.panel.left})`,
  );
  check(state.panel.right <= state.viewport + 0.01, `${at}: panel stays inside the viewport`);
  check(
    state.scrollWidth <= state.clientWidth,
    `${at}: no horizontal scroll (${state.scrollWidth} > ${state.clientWidth})`,
  );
  const expected = expectedLayout(state.viewport, expanded);
  for (const [field, actual] of [
    ["panelWidth", state.panel.width],
    ["panelLeft", state.panel.left],
    ["articleLeft", state.article.left],
    ["articleWidth", state.article.width],
  ])
    check(near(actual, expected[field]), `${at}: ${field} ${actual}, expected ${expected[field]}`);
}
// Playwright's hit testing does not account for CSS zoom on an iframe, so
// buttons inside the zoomed frame are activated directly.
const press = (target, name) => {
  const button = target.getByRole("button", { name, exact: true });
  return target === page ? button.click() : button.evaluate((element) => element.click());
};
async function closeComments(target) {
  if (await target.locator("#page-comments[open]").count()) await press(target, "Close comments");
  await expect(target.locator("#page-comments")).toBeHidden();
  await settle(target);
}
// Opens comments at the current size and checks narrow and expanded placement.
async function checkWidth(target, name, screenshot) {
  await closeComments(target);
  const closed = await measure(target);
  await screenshot(`${name}-closed`);
  await press(target, "Comments");
  await expect(target.locator("#page-comments")).toBeVisible();
  await settle(target);
  const open = await measure(target);
  await screenshot(`${name}-open`);
  const entry = (report.widths[name] = {
    viewport: open.viewport,
    closedLeft: closed.article.left,
    openLeft: open.article.left,
    shift: Math.round((open.article.left - closed.article.left) * 100) / 100,
    closedWidth: closed.article.width,
    openWidth: open.article.width,
    textRight: open.text.right,
    panel: open.panel,
    sheet: open.sheet,
  });
  if (!open.sheetQuery) {
    checkDocked(name, open, false);
    if (expectedLayout(open.viewport, false).centered)
      check(
        near(entry.shift, 0) && near(open.article.width, closed.article.width),
        `${name}: the Page stays put while the gutter fits the panel (shift ${entry.shift})`,
      );
    await press(target, "Expand comments");
    await expect(target.locator("#page-comments.comments-expanded")).toBeVisible();
    await settle(target);
    const expanded = await measure(target);
    await screenshot(`${name}-expanded`);
    entry.expanded = {
      articleLeft: expanded.article.left,
      articleWidth: expanded.article.width,
      textRight: expanded.text.right,
      panel: expanded.panel,
    };
    checkDocked(name, expanded, true);
    if (expectedLayout(open.viewport, true).panelWidth > PANEL_WIDTH + TOLERANCE)
      check(
        expanded.panel && expanded.panel.width > open.panel.width + TOLERANCE,
        `${name}: Expand widens the panel (${open.panel.width} -> ${expanded.panel?.width})`,
      );
    await press(target, "Narrow comments");
    await expect(target.locator("#page-comments.comments-expanded")).toHaveCount(0);
  } else {
    check(open.sheet && open.modal, `${name}: comments open as the modal sheet`);
    check(
      near(entry.shift, 0) && near(open.article.width, closed.article.width),
      `${name}: the sheet leaves the Page column in place`,
    );
  }
  console.log(
    `${label} ${name}: viewport ${open.viewport}, left ${closed.article.left} -> ${open.article.left}, ` +
      `article ${closed.article.width} -> ${open.article.width}, ` +
      `panel ${open.panel ? `${open.panel.left}-${open.panel.right}` : "closed"}${open.sheet ? " (sheet)" : ""}` +
      (entry.expanded
        ? `, expanded panel ${entry.expanded.panel.left}-${entry.expanded.panel.right}`
        : ""),
  );
  return entry;
}
async function select(target, text) {
  const editor = target.locator("wg-content").first();
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
    await checkWidth(page, String(width), (name) =>
      page.screenshot({ path: `${output}/${label}-${name}.png` }),
    );
  }

  // Comment on selection opens the panel without moving the Page under the
  // writer, focuses the draft, and keeps it in place while typing.
  await page.setViewportSize({ width: 1920, height: 1000 });
  await closeComments(page);
  const beforeSelection = await measure(page);
  await select(page, "reading column");
  await page.getByRole("button", { name: "Comment on selection", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "Comment on selection", exact: true });
  await expect(draft).toBeFocused();
  await expect(page.locator(".composer-context")).toHaveText("reading column");
  await settle(page);
  const composing = await measure(page);
  await page.keyboard.type("The column should not move while I type.");
  await settle(page);
  const typed = await measure(page);
  await page.screenshot({ path: `${output}/${label}-1920-comment-on-selection.png` });
  report.commentOnSelection = {
    before: beforeSelection.article.left,
    composing: composing.article.left,
    typed: typed.article.left,
  };
  checkDocked("1920 comment on selection", typed, false);
  check(
    near(composing.article.left, beforeSelection.article.left) &&
      near(typed.article.left, composing.article.left),
    `1920 comment on selection: column stays put (${beforeSelection.article.left} -> ${composing.article.left} -> ${typed.article.left})`,
  );
  await expect(draft).toBeFocused();
  await page
    .locator(".comment-composer")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await closeComments(page);

  // Browser zoom can produce a fractional CSS viewport. A zoom:2 iframe that is
  // 900.5px wide gives its document a 900.5px viewport, between the sheet's
  // max-width: 900px and an integer min-width: 901px. The Page document refuses
  // framing, so this test-only route drops frame-ancestors from its response.
  await page.setViewportSize({ width: 1900, height: 1100 });
  await page.route(`${origin}/p/${pageId}`, async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers() };
    delete headers["x-frame-options"];
    if (headers["content-security-policy"])
      headers["content-security-policy"] = headers["content-security-policy"]
        .split(";")
        .filter((directive) => !directive.trim().startsWith("frame-ancestors"))
        .join(";");
    await route.fulfill({ response, headers });
  });
  const host = `${origin}/__comments-layout-frame`;
  await page.route(host, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><body style="margin:0"><iframe title="Page at 900.5px" src="/p/${pageId}" style="border:0;zoom:2;width:900.5px;height:540px"></iframe></body>`,
    }),
  );
  await page.goto(host);
  const frame = await (await page.locator("iframe").elementHandle()).contentFrame();
  await expect(frame.locator("wg-content").first()).toContainText("reading column");
  const fractional = await measure(frame);
  check(
    fractional.viewport % 1 !== 0 && !fractional.sheetQuery,
    `fixture produces a fractional desktop viewport (got ${fractional.viewport}, sheet ${fractional.sheetQuery})`,
  );
  await checkWidth(frame, "900.5", (name) =>
    page.screenshot({ path: `${output}/${label}-${name}.png` }),
  );
  await closeComments(frame);
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
  await writeFile(`${output}/${label}-report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
for (const failure of report.failures) console.log("FAIL " + failure);
assert.deepEqual(report.failures, [], `${report.failures.length} layout checks failed`);
console.log(`PASS comments layout (${label}). Artifacts: ${output}`);
