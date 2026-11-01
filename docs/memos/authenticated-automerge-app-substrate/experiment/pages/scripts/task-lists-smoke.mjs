// Real local OIDC, two independent browser contexts, and disposable Page fixtures.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { purgeTrashedFixture } from "./purge-fixture.mjs";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9895";
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-task-lists-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const report = { origin, completed: [], errors, fixtures: [] };
let stage = "boot",
  a,
  b;
const content = (page) => page.locator("wg-content");
const tasks = (page) => content(page).locator(".wordgard-task-item");
const checkbox = (page, text) => tasks(page).filter({ hasText: text }).getByRole("checkbox");
const saved = (page) =>
  expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 20000 });
// A collapsed caret hides contextual formatting. Alt+F10 pins the full dock
// (Undo, lists, table options) and moves focus into it on the next frame; the
// editor selection stays. Wait for that focus so it cannot land mid-interaction.
async function showFormatting(page) {
  await page.keyboard.press("Alt+F10");
  await expect(page.locator("#page-formatting .rich-toolbar.is-pinned")).toBeVisible();
  await expect(page.locator("#page-formatting .rich-toolbar :focus")).toHaveCount(1);
}
const checkpoint = (name) => {
  report.completed.push(name);
  console.log("PASS " + name);
};
const markdown = (page) => page.blocks.map((block) => block.markdown).join("\n\n");
// Keep the exact token, key and payload for a fixture retry, including its driver.
// No retry authority is silently regenerated after an uncertain mutation.
const requestsByPage = new WeakMap();
async function call(page, operation, args = {}) {
  if (args.idempotency_key && !args.retry_token) {
    let requests = requestsByPage.get(page);
    if (!requests) requestsByPage.set(page, (requests = new Map()));
    const requestKey = JSON.stringify([operation, args.idempotency_key]);
    const fingerprint = JSON.stringify(args);
    let request = requests.get(requestKey);
    if (!request) {
      const catalog = ["create_page", "delete_page", "purge_page"].includes(operation);
      const authority = await rawCall(
        page,
        catalog ? "list_pages" : "read_page",
        catalog ? {} : { page_id: args.page_id },
      );
      assert.equal(typeof authority.retry_token, "string");
      assert.match(authority.retry_key_prefix, /^v1_[a-f0-9]{64}_$/);
      request = {
        fingerprint,
        args: structuredClone({
          ...args,
          retry_token: authority.retry_token,
          idempotency_key: authority.retry_key_prefix + args.idempotency_key,
        }),
      };
      requests.set(requestKey, request);
    }
    assert.equal(request.fingerprint, fingerprint, "fixture retry preserves its original payload");
    args = request.args;
  }
  return rawCall(page, operation, args);
}
async function rawCall(page, operation, args) {
  return page.evaluate(
    async ({ operation, args }) => {
      const response = await fetch("/api/tools", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pages-Driver": "Wordgard browser fixture",
        },
        body: JSON.stringify({ operation, arguments: args }),
      });
      const body = await response.json();
      if (!response.ok) throw Error(JSON.stringify(body));
      return body;
    },
    { operation, args },
  );
}
async function selectText(page, text, collapse = false, block = 0) {
  const editor = content(page).nth(block);
  await editor.focus();
  await editor.evaluate(
    (el, { text, collapse }) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return node.parentElement.closest(
            ".peer-caret,.wordgard-widget,.wordgard-diagram-actions,select,button",
          )
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        },
      });
      const nodes = [];
      let joined = "",
        node;
      while ((node = walker.nextNode())) {
        nodes.push({ node, start: joined.length });
        joined += node.textContent;
      }
      const start = joined.indexOf(text);
      if (start < 0) throw Error("Missing selection text: " + text + "; found " + joined);
      const at = (offset, startBoundary = false) => {
        const entry = nodes.find(
          ({ node, start }) =>
            offset >= start &&
            (startBoundary
              ? offset < start + node.textContent.length
              : offset <= start + node.textContent.length),
        );
        if (!entry) throw Error("Missing selection offset " + offset);
        return [entry.node, offset - entry.start];
      };
      const range = document.createRange();
      // At adjacent text-node boundaries, start in the following node so a
      // paragraph separator is not accidentally included in the passage.
      range.setStart(...at(start, true));
      range.setEnd(...at(start + text.length));
      if (collapse) range.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    },
    { text, collapse },
  );
  await expect
    .poll(() => page.evaluate(() => getSelection().toString()))
    .toBe(collapse ? "" : text);
  // Let the editor observe the browser's asynchronous selectionchange event.
  await page.waitForTimeout(50);
}
async function create(source, title) {
  const result = await call(a, "create_page", {
    title,
    markdown: source,
    idempotency_key: crypto.randomUUID(),
  });
  report.fixtures.push(result.page_id);
  for (const page of [a, b]) {
    await page.goto(origin + "/p/" + result.page_id);
    await expect(content(page).first()).toBeVisible();
    await saved(page);
  }
  return result;
}
try {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  [a, b] = await Promise.all(contexts.map((context) => context.newPage()));
  for (const page of [a, b]) {
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    await page.goto(origin + "/api/auth/login");
    await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible();
  }

  stage = "Markdown import renders native checked and unchecked tasks in two peers";
  const imported = await create(
    "A plan we can work through together.\n\n- [ ] Write the plan\n- [ ] Review with a colleague\n- [x] Share the draft\n\nKeep this note as prose.",
    "A shared checklist",
  );
  for (const page of [a, b]) {
    await expect(tasks(page)).toHaveCount(3);
    await expect(checkbox(page, "Write the plan")).not.toBeChecked();
    await expect(checkbox(page, "Share the draft")).toBeChecked();
  }
  checkpoint(stage);

  stage = "click and keyboard Space sync checked state, and checkbox keeps keyboard focus";
  await checkbox(a, "Write the plan").click();
  for (const page of [a, b]) await expect(checkbox(page, "Write the plan")).toBeChecked();
  await expect(checkbox(a, "Write the plan")).toBeFocused();
  await a.keyboard.press("Space");
  for (const page of [a, b]) await expect(checkbox(page, "Write the plan")).not.toBeChecked();
  await expect(checkbox(a, "Write the plan")).toBeFocused();
  await saved(a);
  checkpoint(stage);

  stage = "simultaneous checkbox and prose edits converge, and undo retains peer text";
  await selectText(b, "Write the plan", true);
  await Promise.all([checkbox(a, "Write the plan").click(), b.keyboard.insertText(" together")]);
  for (const page of [a, b]) {
    await expect(checkbox(page, "Write the plan together")).toBeChecked();
    await expect(content(page)).toContainText("Write the plan together");
  }
  await showFormatting(a);
  await a.getByRole("button", { name: "Undo", exact: true }).click();
  for (const page of [a, b]) {
    await expect(checkbox(page, "Write the plan together")).not.toBeChecked();
    await expect(content(page)).toContainText("Write the plan together");
  }
  await saved(a);
  checkpoint(stage);

  stage = "toolbar converts prose to tasks and back with accurate pressed state";
  await selectText(a, "Keep this note as prose.");
  await showFormatting(a);
  const taskButton = a.getByRole("button", { name: "Task list", exact: true });
  await expect(taskButton).toHaveAttribute("aria-pressed", "false");
  await taskButton.click();
  await expect(taskButton).toHaveAttribute("aria-pressed", "true");
  for (const page of [a, b])
    await expect(checkbox(page, "Keep this note as prose.")).not.toBeChecked();
  await taskButton.click();
  for (const page of [a, b]) await expect(tasks(page)).toHaveCount(3);
  await expect(taskButton).toHaveAttribute("aria-pressed", "false");
  checkpoint(stage);

  stage = "Enter after checked task starts unchecked; empty Enter exits the checklist";
  await selectText(a, "Share the draft", true);
  await a.keyboard.press("Enter");
  for (const page of [a, b]) await expect(tasks(page)).toHaveCount(4);
  await expect(tasks(a).nth(3).getByRole("checkbox")).not.toBeChecked();
  await a.keyboard.press("Enter");
  for (const page of [a, b]) await expect(tasks(page)).toHaveCount(3);
  await a.keyboard.insertText("We are ready for the next step.");
  for (const page of [a, b])
    await expect(content(page)).toContainText("We are ready for the next step.");
  await expect(tasks(a).filter({ hasText: "We are ready" })).toHaveCount(0);
  await saved(a);
  checkpoint(stage);

  stage = "agent Markdown projection and reload retain task states";
  let current = await call(a, "read_page", { page_id: imported.page_id });
  assert.match(markdown(current), /- \[ \] Write the plan together/);
  assert.match(markdown(current), /- \[x\] Share the draft/);
  await a.reload();
  await saved(a);
  await expect(checkbox(a, "Write the plan together")).not.toBeChecked();
  await expect(checkbox(a, "Share the draft")).toBeChecked();
  await a.screenshot({ path: output + "/task-lists-desktop.png", fullPage: true });
  checkpoint(stage);

  stage = "mobile touch targets and layout at 390px";
  const mobileContext = await browser.newContext({
    storageState: await contexts[0].storageState(),
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mobile = await mobileContext.newPage();
  mobile.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await mobile.goto(origin + "/p/" + imported.page_id);
  await saved(mobile);
  await checkbox(mobile, "Review with a colleague").tap();
  for (const page of [a, b, mobile])
    await expect(checkbox(page, "Review with a colleague")).toBeChecked();
  const geometry = await mobile
    .locator(".wordgard-task-control")
    .first()
    .evaluate((label) => {
      const r = label.getBoundingClientRect();
      return {
        width: r.width,
        height: r.height,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
  assert.ok(geometry.width >= 44 && geometry.height >= 44, JSON.stringify(geometry));
  assert.equal(geometry.overflow, false);

  // The compact mobile bar: shown while the editor has focus, pinned to the
  // bottom of the visual viewport, formatting without losing editor focus,
  // and no floating selection toolbar alongside it.
  const bar = mobile.locator(".mobile-bar");
  await expect(bar).toHaveCount(0);
  const prose = mobile.locator(".page-block wg-content").first();
  await prose
    .locator("p")
    .first()
    .click({ position: { x: 24, y: 10 } });
  await expect(bar).toBeVisible();
  const placement = await bar.evaluate((element) => {
    const r = element.getBoundingClientRect();
    return { bottom: Math.round(r.bottom), height: innerHeight, width: Math.round(r.width) };
  });
  assert.equal(placement.bottom, placement.height, JSON.stringify(placement));
  assert.equal(placement.width, 390, JSON.stringify(placement));
  await prose
    .locator("p")
    .first()
    .evaluate((paragraph) => {
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, Math.min(4, node.textContent.length));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
  await expect(mobile.locator(".rich-toolbar.is-contextual:not([hidden])")).toHaveCount(0);
  const bold = bar.getByRole("button", { name: "Bold", exact: true });
  await bold.tap();
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  assert.ok(
    await prose.evaluate((element) => element.contains(document.activeElement)),
    "the editor keeps focus, so the keyboard stays up",
  );
  await bold.tap();
  await bar.getByRole("button", { name: "More formatting" }).tap();
  await expect(mobile.getByRole("menuitem", { name: "Highlight" })).toBeVisible();
  await mobile.getByRole("menuitem", { name: "Highlight" }).tap();
  await expect(prose.locator('mark[data-highlight="yellow"]')).toHaveCount(1);
  await mobile.screenshot({ path: output + "/mobile-bar.png" });

  // With a tall keyboard the ⋯ menu stays below the header and scrolls.
  // Emulation has no software keyboard, so set the visible height the
  // viewport tracker would publish for one.
  await mobile.evaluate(() => document.documentElement.style.setProperty("--vv-height", "360px"));
  await bar.getByRole("button", { name: "More formatting" }).tap();
  const menu = mobile.getByRole("menu", { name: "More formatting" });
  await expect(menu).toBeVisible();
  const fit = await menu.evaluate((element) => {
    const header = document.querySelector(".app-header").getBoundingClientRect();
    return {
      top: Math.round(element.getBoundingClientRect().top),
      headerBottom: Math.round(header.bottom),
      scrolls: element.scrollHeight > element.clientHeight,
    };
  });
  assert.ok(fit.top >= fit.headerBottom, JSON.stringify(fit));
  assert.ok(fit.scrolls, JSON.stringify(fit));

  // Focus leaving the editor and the bar without a pointer (here, code moving
  // it to the title) closes the menu and drops the bar.
  await mobile.getByRole("textbox", { name: "Page title" }).evaluate((title) => title.focus());
  await expect(menu).toHaveCount(0);
  await expect(bar).toHaveCount(0);
  await mobile.evaluate(() => document.documentElement.style.removeProperty("--vv-height"));
  // On a phone the header status is a dot with its label for screen readers.
  const phoneStatus = mobile.locator(".document-status [role=status]");
  await expect(phoneStatus).toHaveClass(/save-status--dot/);
  await expect(phoneStatus.locator(".save-status-label")).toHaveCount(0);
  await expect(phoneStatus.locator(".sr-only")).not.toHaveText("");
  // A full-page screenshot resets Chromium's touch emulation, so it comes last.
  await mobile.screenshot({ path: output + "/task-lists-mobile.png", fullPage: true });
  await mobileContext.close();
  checkpoint(stage);

  stage = "read-only task controls are disabled and create no changes (frontend fixture)";
  const readerContext = await browser.newContext({
    storageState: await contexts[0].storageState(),
  });
  const reader = await readerContext.newPage();
  reader.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await reader.route(/\/api\/(auth\/session|connect)(\?|$)/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), canWrite: false } });
  });
  await reader.goto(origin + "/p/" + imported.page_id);
  await expect(content(reader)).toHaveAttribute("contenteditable", "false");
  // Readers get no formatting dock, so no list controls at all.
  await expect(reader.getByRole("button", { name: "Task list", exact: true })).toHaveCount(0);
  for (const input of await reader.getByRole("checkbox").all()) await expect(input).toBeDisabled();
  const before = await call(a, "read_page", { page_id: imported.page_id });
  await content(reader).click();
  await reader.keyboard.type("Must not change a task");
  assert.deepEqual((await call(a, "read_page", { page_id: imported.page_id })).heads, before.heads);
  await reader.screenshot({ path: output + "/task-lists-read-only.png", fullPage: true });
  await readerContext.close();
  checkpoint(stage);

  stage = "typed dash and star task shortcuts create real checkboxes";
  const typed = await create("", "Typed checklist");
  await content(a).click();
  await a.keyboard.type("- [ ] First task", { delay: 15 });
  for (const page of [a, b]) await expect(checkbox(page, "First task")).not.toBeChecked();
  await a.keyboard.press("Enter");
  await a.keyboard.press("Enter");
  await a.keyboard.type("* [x] Finished task", { delay: 15 });
  for (const page of [a, b]) await expect(checkbox(page, "Finished task")).toBeChecked();
  await saved(a);
  current = await call(a, "read_page", { page_id: typed.page_id });
  assert.match(markdown(current), /- \[ \] First task/);
  assert.match(markdown(current), /- \[x\] Finished task/);
  checkpoint(stage);

  for (const page of [a, b]) await expect(page.locator(".app > .error")).toHaveCount(0);
  assert.deepEqual(errors, [], "no unhandled page errors");
  for (const page_id of report.fixtures) {
    const value = await call(a, "read_page", { page_id });
    await call(a, "delete_page", {
      page_id,
      base_heads: value.heads,
      idempotency_key: crypto.randomUUID(),
    });
    await purgeTrashedFixture(
      (operation, args) => call(a, operation, args),
      page_id,
      () => ({
        idempotency_key: crypto.randomUUID(),
      }),
    );
  }
  report.cleaned = true;
  report.result = "pass";
} catch (error) {
  report.result = "fail";
  report.stage = stage;
  report.failure = String(error.stack ?? error);
  for (const [name, page] of [
    ["a", a],
    ["b", b],
  ])
    if (page) {
      await page
        .screenshot({ path: output + "/failure-" + name + ".png", fullPage: true })
        .catch(() => {});
      await writeFile(output + "/failure-" + name + ".html", await page.content()).catch(() => {});
    }
  console.error("FAIL " + stage + "\n" + report.failure);
  process.exitCode = 1;
} finally {
  await writeFile(output + "/report.json", JSON.stringify(report, null, 2) + "\n");
  await browser.close();
}
