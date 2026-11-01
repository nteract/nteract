// Editor chrome against the local Wordgard fixture: the reload banner stays in
// view while a Page scrolls, a person in the browser is labeled by name, a
// final code block can be left from the keyboard, and task-list checkboxes sit
// in the list indent. Real local OIDC; no public Pages mutations.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { purgeTrashedFixture } from "./purge-fixture.mjs";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-editor-chrome-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = { origin, completed: [], errors: [], screenshots: [] };
const fixtures = [];
let stage = "local OIDC sign-in",
  a,
  b;

const content = (page) => page.locator(".page-block wg-content");
const banner = (page) => page.locator(".build-update");
function complete(name) {
  report.completed.push(name);
  console.log("PASS " + name);
}
async function shot(page, name) {
  const path = `${output}/${name}.png`;
  await page.screenshot({ path });
  report.screenshots.push(path);
}
async function tool(page, operation, args = {}) {
  const result = await page.evaluate(
    async ({ operation, args }) => {
      const response = await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation, arguments: args }),
      });
      return { status: response.status, body: await response.json() };
    },
    { operation, args },
  );
  assert.equal(result.status, 200, `${operation}: ${JSON.stringify(result.body)}`);
  return result.body;
}
async function create(page, title, markdown) {
  const created = await tool(page, "create_page", {
    title: `${title} ${Date.now()}`,
    markdown,
    idempotency_key: crypto.randomUUID(),
  });
  fixtures.push(created.page_id);
  return created.page_id;
}
const read = (page, pageId) => tool(page, "read_page", { page_id: pageId });
const markdownOf = (page) => page.blocks.map((block) => block.markdown).join("\n\n");
async function signIn(viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport });
  context.setDefaultTimeout(10000);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message.slice(0, 1000)));
  await page.goto(origin + "/api/auth/login", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 20000,
  });
  return page;
}
async function openPage(page, pageId, text) {
  await page.goto(`${origin}/p/${pageId}`);
  await expect(content(page).first()).toContainText(text, { timeout: 20000 });
}
/** Put Wordgard's caret at `pos` in the first block and wait for the DOM caret. */
async function caretAt(page, pick) {
  const root = content(page).first();
  await root.focus();
  await root.evaluate((element, pick) => {
    const editor = element.closest(".wordgard-document").wg;
    const doc = editor.state.doc;
    let pos = 0,
      target = null;
    for (const node of doc.content) {
      if (pick.type === node.type.name && target === null)
        target = pick.side === "end" ? pos + node.length - 1 : pos + 1 + (pick.offset ?? 0);
      pos += node.length;
    }
    if (target === null) throw Error(`no ${pick.type} block`);
    editor.dispatch({ selection: { anchor: target } });
  }, pick);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}
const blockTypes = (page) =>
  content(page)
    .first()
    .evaluate((element) =>
      element.closest(".wordgard-document").wg.state.doc.content.map((node) => node.type.name),
    );

try {
  a = await signIn();

  stage = "reload banner stays visible when scrolled";
  const longId = await create(
    a,
    "Banner scroll",
    Array.from(
      { length: 60 },
      (_, index) => `Paragraph ${index + 1} keeps the Page tall enough to scroll.`,
    ).join("\n\n"),
  );
  await openPage(a, longId, "Paragraph 60");
  // A deploy under an open tab: the next receipt advertises another build.
  const current = await a.evaluate(async () => (await fetch("/health")).json());
  const nextBuild = current.build === "b".repeat(12) ? "c".repeat(12) : "b".repeat(12);
  await a.route("**/api/**", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), "x-pages-build": nextBuild },
    });
  });
  await caretAt(a, { type: "Paragraph", offset: 3 });
  await a.keyboard.insertText("!");
  await expect(banner(a).locator(".build-update-message")).toHaveText(
    "App updated. Reload to use the latest version.",
    { timeout: 30000 },
  );
  await expect(banner(a).getByRole("button", { name: "Reload", exact: true })).toBeVisible();
  await expect(banner(a)).toHaveAttribute("role", "status");
  await a.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => a.evaluate(() => scrollY)).toBeGreaterThan(400);
  const stuck = async () =>
    a.evaluate(() => {
      const header = document.querySelector(".app-header").getBoundingClientRect();
      const notice = document.querySelector(".build-update").getBoundingClientRect();
      const toolbar = document.querySelector(".toolbar-host .rich-toolbar.is-pinned");
      const hit = document.elementFromPoint(notice.left + 4, notice.top + notice.height / 2);
      return {
        headerBottom: Math.round(header.bottom),
        top: Math.round(notice.top),
        bottom: Math.round(notice.bottom),
        toolbarBottom: toolbar
          ? Math.round(toolbar.closest(".toolbar-host").getBoundingClientRect().bottom)
          : null,
        onTop: !!hit?.closest(".build-update"),
      };
    });
  let geometry = await stuck();
  assert.equal(geometry.top, geometry.headerBottom, JSON.stringify(geometry));
  assert.ok(geometry.onTop, "the banner is not covered by the document");
  await shot(a, "banner-scrolled");
  // With formatting pinned, the banner sits below the toolbar.
  await caretAt(a, { type: "Paragraph", offset: 3 });
  await a.keyboard.press("Alt+F10");
  await expect(a.locator("#page-formatting .rich-toolbar.is-pinned")).toBeVisible();
  await a.keyboard.press("Escape");
  await a.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect
    .poll(async () => {
      geometry = await stuck();
      return geometry.toolbarBottom !== null && geometry.top === geometry.toolbarBottom;
    })
    .toBe(true);
  assert.ok(geometry.toolbarBottom > geometry.headerBottom, JSON.stringify(geometry));
  assert.ok(geometry.onTop, "the banner is not covered by the document");
  await shot(a, "banner-under-toolbar");
  // A phone-sized window keeps it under the header too.
  await a.keyboard.press("Alt+F10");
  await a.setViewportSize({ width: 390, height: 760 });
  await a.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect
    .poll(async () => {
      geometry = await stuck();
      return geometry.onTop && geometry.top >= geometry.headerBottom - 1;
    })
    .toBe(true);
  await shot(a, "banner-phone");
  await a.unrouteAll({ behavior: "wait" });
  await a.setViewportSize({ width: 1280, height: 900 });
  complete("Reload banner sticks under the header and the pinned toolbar while scrolled");

  stage = "a person in the browser is labeled by name";
  b = await signIn();
  const presenceId = await create(a, "Browser presence", "Writer two puts a caret here.");
  await openPage(a, presenceId, "Writer two");
  await openPage(b, presenceId, "Writer two");
  const name = (await a.evaluate(async () => (await fetch("/api/auth/session")).json())).identity
    .displayName;
  assert.ok(name, "the local account has a display name");
  await caretAt(b, { type: "Paragraph", offset: 6 });
  await b.keyboard.press("ArrowRight");
  const caret = a.locator(".peer-caret").first();
  await expect(caret).toBeVisible({ timeout: 20000 });
  await expect(caret.locator("> span")).toHaveText(name);
  await expect(caret.locator("> span")).not.toContainText("Browser");
  await caret.scrollIntoViewIfNeeded();
  await shot(a, "browser-presence-label");
  await b.context().close();
  b = null;
  complete(`Browser presence shows "${name}" without a driver label`);

  stage = "leaving a final code block";
  const codeId = await create(a, "Code exit", "Intro\n\n```js\nlet x = 1\n```");
  const before = await read(a, codeId);
  await openPage(a, codeId, "let x = 1");
  assert.deepEqual(await blockTypes(a), ["Paragraph", "CodeBlock", "Paragraph"]);
  await expect(a.locator(".page-block wg-content > p").last()).toBeVisible();
  // Opening the Page wrote nothing: the trailing line is the editor's.
  assert.deepEqual((await read(a, codeId)).heads, before.heads);
  await caretAt(a, { type: "CodeBlock", side: "end" });
  await a.keyboard.press("ArrowDown");
  await a.keyboard.insertText("After the code.");
  await expect
    .poll(async () => markdownOf(await read(a, codeId)), { timeout: 20000 })
    .toBe("Intro\n\n```js\nlet x = 1\n```\n\nAfter the code.");
  assert.deepEqual(await blockTypes(a), ["Paragraph", "CodeBlock", "Paragraph"]);
  await shot(a, "code-exit-arrow-down");
  // Mod-Enter from the middle of a final code block.
  const shortcutId = await create(a, "Code exit shortcut", "```py\nprint(1)\nprint(2)\n```");
  await openPage(a, shortcutId, "print(2)");
  await caretAt(a, { type: "CodeBlock", offset: 3 });
  await a.keyboard.press("ControlOrMeta+Enter");
  await a.keyboard.insertText("Left with Mod-Enter.");
  await expect
    .poll(async () => markdownOf(await read(a, shortcutId)), { timeout: 20000 })
    .toBe("```py\nprint(1)\nprint(2)\n```\n\nLeft with Mod-Enter.");
  // The block-type menu offers code blocks.
  await caretAt(a, { type: "Paragraph", offset: 2 });
  await a.keyboard.press("Alt+F10");
  const style = a.locator("#page-formatting select[aria-label='Text style']");
  await expect(style.locator("option", { hasText: "Code block" })).toHaveCount(1);
  // Common controls first, insert actions at the far end, Comment last.
  const order = await a
    .locator("#page-formatting .rich-toolbar.is-pinned")
    .evaluate((bar) =>
      [...bar.querySelectorAll("button,select")].map((control) =>
        control.getAttribute("aria-label"),
      ),
    );
  assert.deepEqual(
    order,
    [
      "Undo",
      "Redo",
      "Text style",
      "Bold",
      "Italic",
      "Link",
      "Inline code",
      "Highlight",
      "Bulleted list",
      "Numbered list",
      "Task list",
      "Insert table",
      "Insert image",
      "Comment on selection",
    ],
    JSON.stringify(order),
  );
  await a.locator("#page-formatting .rich-toolbar.is-pinned").screenshot({
    path: `${output}/toolbar-order.png`,
  });
  report.screenshots.push(`${output}/toolbar-order.png`);
  await a.keyboard.press("Alt+F10");
  complete(
    "ArrowDown and Mod-Enter leave a final code block; opening writes nothing; toolbar order",
  );

  stage = "task-list checkbox indent";
  const tasksId = await create(
    a,
    "Checkbox indent",
    "Prose edge\n\n- bullet one\n- bullet two\n\n- [ ] task one\n- [x] task two",
  );
  await openPage(a, tasksId, "task two");
  const indent = await content(a)
    .first()
    .evaluate((root) => {
      const rect = (element) => element.getBoundingClientRect();
      const prose = rect(root.querySelector(":scope > p"));
      const bullets = root.querySelector("ul:not([data-task-list])");
      const tasks = root.querySelector("ul[data-task-list]");
      const box = rect(tasks.querySelector("input[type=checkbox]"));
      const text = rect(tasks.querySelector(".wordgard-task-content p"));
      const em = parseFloat(getComputedStyle(tasks).fontSize);
      return {
        em,
        bulletPadding: parseFloat(getComputedStyle(bullets).paddingInlineStart),
        taskPadding: parseFloat(getComputedStyle(tasks).paddingInlineStart),
        boxInset: box.left - prose.left,
        gap: text.left - box.right,
        bulletText: rect(bullets.querySelector("li p")).left - prose.left,
        taskText: text.left - prose.left,
      };
    });
  // A bullet's disc starts about 0.45em in; the checkbox starts there too.
  assert.ok(Math.abs(indent.boxInset - 0.45 * indent.em) <= 1.5, JSON.stringify(indent));
  assert.ok(indent.gap >= 6, JSON.stringify(indent));
  assert.ok(indent.taskPadding > indent.bulletPadding, JSON.stringify(indent));
  report.indent = indent;
  await content(a)
    .first()
    .screenshot({ path: `${output}/checkbox-indent.png` });
  report.screenshots.push(`${output}/checkbox-indent.png`);
  complete("Task-list checkboxes start at the bullet indent");

  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = { stage, message: String(error?.message ?? error).slice(0, 2000) };
  if (a) await a.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (a)
    for (const pageId of fixtures)
      try {
        const current = await read(a, pageId);
        await tool(a, "delete_page", {
          page_id: pageId,
          base_heads: current.heads,
          idempotency_key: crypto.randomUUID(),
        });
        await purgeTrashedFixture(
          (operation, args) => tool(a, operation, args),
          pageId,
          () => ({ idempotency_key: crypto.randomUUID() }),
        );
      } catch (error) {
        report.errors.push(`cleanup ${pageId}: ${String(error?.message ?? error).slice(0, 200)}`);
      }
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}
