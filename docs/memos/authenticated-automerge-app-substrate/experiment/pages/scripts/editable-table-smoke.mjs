// Real local OIDC and two browser contexts; all documents are disposable local fixtures.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { purgeTrashedFixture } from "./purge-fixture.mjs";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9895";
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-editable-tables-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const report = { origin, completed: [], errors, fixtures: [] };
let stage = "boot",
  a,
  b;
const source = `| Name | Status | Notes |
| :--- | :---: | ---: |
| Pages | **Ready** | Shared writing |
| Notebook | Testing | [Guide](/llms.txt) and \`code\` |`;
const content = (page) => page.locator("wg-content");
const table = (page) => content(page).locator("table").first();
const rows = (page) => table(page).locator("tr");
const cell = (page, row, column) => rows(page).nth(row).locator("th,td").nth(column);
const saved = (page) =>
  expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 20000 });
function checkpoint() {
  report.completed.push(stage);
  console.log("PASS " + stage);
}
async function call(page, operation, args) {
  return page.evaluate(
    async ({ operation, args }) => {
      const response = await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Pages-Driver": "Editable table fixture" },
        body: JSON.stringify({ operation, arguments: args }),
      });
      const body = await response.json();
      if (!response.ok) throw Error(JSON.stringify(body));
      return body;
    },
    { operation, args },
  );
}
async function selectCell(page, row, column, collapse = false) {
  await content(page).first().focus();
  const target = cell(page, row, column);
  await target.scrollIntoViewIfNeeded();
  const text = await target.innerText();
  await target.evaluate((element, collapse) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    if (collapse) range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, collapse);
  await expect
    .poll(() => page.evaluate(() => getSelection().toString()))
    .toBe(collapse ? "" : text);
  // Browser selectionchange is asynchronous; Wordgard must see it before input.
  await page.waitForTimeout(50);
}
async function action(page, name) {
  await page.getByRole("button", { name: "Table options", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}
async function create(markdown, title) {
  const fixture = await call(a, "create_page", {
    title,
    markdown,
    idempotency_key: crypto.randomUUID(),
  });
  report.fixtures.push(fixture.page_id);
  for (const page of [a, b]) {
    await page.goto(origin + "/p/" + fixture.page_id);
    await expect(content(page).first()).toBeVisible();
    await saved(page);
  }
  return fixture;
}
async function shape(page, rowCount, columnCount) {
  await expect(rows(page)).toHaveCount(rowCount);
  for (let row = 0; row < rowCount; row++) {
    await expect(rows(page).nth(row).locator("th,td")).toHaveCount(columnCount);
    await expect(
      rows(page)
        .nth(row)
        .locator(
          row === 0
            ? '[role="columnheader"][data-table-header="true"]'
            : '[role="cell"][data-table-header="false"]',
        ),
    ).toHaveCount(columnCount);
  }
}
try {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  [a, b] = await Promise.all(contexts.map((context) => context.newPage()));
  for (const page of [a, b]) {
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    await page.goto(origin + "/api/auth/login");
    await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible();
    assert.equal(
      await page.evaluate(async () => (await (await fetch("/api/auth/session")).json()).editor),
      "wordgard",
    );
  }

  stage = "Markdown imports as editable native cells in both peers";
  const fixture = await create(source, "Pages, together");
  for (const page of [a, b]) {
    await shape(page, 3, 3);
    await expect(cell(page, 1, 1).locator("strong")).toHaveText("Ready");
    await expect(cell(page, 2, 2).locator("a")).toHaveText("Guide");
    await expect(cell(page, 2, 2).locator("code")).toHaveText("code");
    await expect(table(page).locator('[contenteditable="false"]')).toHaveCount(0);
    await expect(page.locator(".preserved-table")).toHaveCount(0);
    for (const row of [0, 1, 2]) {
      assert.equal(
        await cell(page, row, 1).evaluate((el) => getComputedStyle(el).textAlign),
        "center",
      );
      assert.equal(
        await cell(page, row, 2).evaluate((el) => getComputedStyle(el).textAlign),
        "right",
      );
    }
  }
  checkpoint();

  stage = "two peers edit different cells and format shared text";
  await selectCell(a, 1, 0);
  await selectCell(b, 2, 1);
  await Promise.all([a.keyboard.insertText("Pages A"), b.keyboard.insertText("Reviewed B")]);
  for (const page of [a, b]) {
    await expect(cell(page, 1, 0)).toHaveText("Pages A");
    await expect(cell(page, 2, 1)).toHaveText("Reviewed B");
  }
  await selectCell(a, 1, 0);
  await a.keyboard.press("ControlOrMeta+b");
  await expect(cell(b, 1, 0).locator("strong")).toHaveText("Pages A");
  await saved(a);
  await saved(b);
  checkpoint();

  stage = "comment on selected cell text retains the correct passage";
  await selectCell(a, 1, 0);
  await a.getByRole("button", { name: "Comment on selection", exact: true }).click();
  await expect(a.locator(".composer-context")).toHaveText("Pages A");
  await a
    .getByRole("textbox", { name: "Comment on selection", exact: true })
    .fill("Discuss this cell together.");
  await a.getByRole("button", { name: "Send", exact: true }).first().click();
  await expect(b.locator(".comment-passage")).toHaveText("Pages A");
  await b.getByRole("button", { name: "Comments", exact: true }).click();
  await expect(b.locator(".thread .message")).toContainText("Discuss this cell together.");
  await expect(b.locator(".thread .quote")).toHaveText("Pages A");
  await b.locator(".thread .quote").click();
  await expect(b.locator(".comment-passage-active")).toHaveText("Pages A");
  for (const page of [a, b])
    await page.getByRole("button", { name: "Close comments", exact: true }).click();
  checkpoint();

  stage = "insert a column, edit it, and delete it across peers";
  await selectCell(a, 1, 0, true);
  await action(a, "Insert column right");
  for (const page of [a, b]) await shape(page, 3, 4);
  await selectCell(a, 1, 1, true);
  await a.keyboard.insertText("Collaborate");
  await expect(cell(b, 1, 1)).toHaveText("Collaborate");
  await selectCell(a, 1, 1, true);
  await action(a, "Delete column");
  for (const page of [a, b]) {
    await shape(page, 3, 3);
    await expect(cell(page, 1, 0)).toHaveText("Pages A");
    await expect(cell(page, 1, 1)).toHaveText("Ready");
    await expect(table(page)).not.toContainText("Collaborate");
  }
  checkpoint();

  stage = "first-row insertion and undo retain header and body content";
  await selectCell(a, 0, 0, true);
  await action(a, "Insert row above");
  for (const page of [a, b]) await shape(page, 4, 3);
  await a.getByRole("button", { name: "Undo", exact: true }).click();
  for (const page of [a, b]) {
    await shape(page, 3, 3);
    await expect(cell(page, 0, 0)).toHaveText("Name");
    await expect(cell(page, 1, 0)).toHaveText("Pages A");
  }
  checkpoint();

  stage = "deleting the first row promotes presentation without changing retained cells";
  await selectCell(a, 0, 0, true);
  await action(a, "Delete row");
  for (const page of [a, b]) {
    await shape(page, 2, 3);
    await expect(cell(page, 0, 0).locator("strong")).toHaveText("Pages A");
    await expect(cell(page, 1, 0)).toHaveText("Notebook");
  }
  await a.getByRole("button", { name: "Undo", exact: true }).click();
  for (const page of [a, b]) {
    await shape(page, 3, 3);
    await expect(cell(page, 0, 0)).toHaveText("Name");
    await expect(cell(page, 1, 0).locator("strong")).toHaveText("Pages A");
  }
  checkpoint();

  stage = "insert, edit, and delete a body row";
  await selectCell(a, 1, 0, true);
  await action(a, "Insert row below");
  for (const page of [a, b]) await shape(page, 4, 3);
  await selectCell(a, 2, 0, true);
  await a.keyboard.insertText("New row");
  await expect(cell(b, 2, 0)).toHaveText("New row");
  await action(a, "Delete row");
  for (const page of [a, b]) {
    await shape(page, 3, 3);
    await expect(cell(page, 2, 0)).toHaveText("Notebook");
  }
  checkpoint();

  stage = "agent patch edits native cell text without replacing other cells";
  await saved(a);
  let current = await call(a, "read_page", { page_id: fixture.page_id });
  const tableBlock = current.blocks.find((block) => block.markdown.includes("Pages A"));
  assert.ok(tableBlock, "read_page exports the table Markdown");
  assert.match(tableBlock.markdown, /\*\*Pages A\*\*/);
  assert.match(tableBlock.markdown, /Reviewed B/);
  await call(a, "patch_page", {
    page_id: fixture.page_id,
    base_heads: current.heads,
    idempotency_key: crypto.randomUUID(),
    operations: [
      {
        op: "patch_block_markdown",
        block_id: tableBlock.id,
        replacements: [{ old: "Reviewed B", new: "Agent reviewed" }],
      },
    ],
  });
  for (const page of [a, b]) {
    await expect(cell(page, 2, 1)).toHaveText("Agent reviewed");
    await expect(cell(page, 1, 0).locator("strong")).toHaveText("Pages A");
  }
  checkpoint();

  stage = "Tab from the final cell creates an editable row";
  await selectCell(a, 2, 2, true);
  await a.keyboard.press("Tab");
  for (const page of [a, b]) await shape(page, 4, 3);
  await a.keyboard.insertText("Tab-created row");
  await expect(cell(b, 3, 0)).toHaveText("Tab-created row");
  await saved(a);
  checkpoint();

  stage = "multiline cell content exports and synchronizes";
  await selectCell(a, 3, 1, true);
  await a.keyboard.insertText(
    "A shared view stays readable as people and agents refine the document together.",
  );
  await a.keyboard.press("Shift+Enter");
  await a.keyboard.insertText("A second line stays in the same cell.");
  await expect(cell(b, 3, 1)).toContainText("A second line stays in the same cell.");
  await expect(cell(b, 3, 1).locator("br")).toHaveCount(1);
  await saved(a);
  current = await call(a, "read_page", { page_id: fixture.page_id });
  assert.match(
    current.blocks.find((block) => block.id === tableBlock.id).markdown,
    /together\.<br>A second line/,
  );
  checkpoint();

  stage = "reload and narrow viewport retain native tables";
  await a.reload();
  await shape(a, 4, 3);
  await expect(cell(a, 1, 0).locator("strong")).toHaveText("Pages A");
  await expect(cell(a, 2, 1)).toHaveText("Agent reviewed");
  await expect(cell(a, 3, 0)).toHaveText("Tab-created row");
  await expect(cell(a, 3, 1).locator("br")).toHaveCount(1);
  await expect(cell(a, 3, 1)).toContainText("A second line stays in the same cell.");
  await a.setViewportSize({ width: 1280, height: 900 });
  await selectCell(a, 1, 0, true);
  await a.getByRole("button", { name: "Table options", exact: true }).click();
  await expect(a.getByRole("menu", { name: "Table options", exact: true })).toBeVisible();
  await expect(a.getByRole("menuitem", { name: "Insert row above", exact: true })).toBeFocused();
  await saved(a);
  await a.screenshot({ path: output + "/editable-table-menu.png", fullPage: true });
  await a.keyboard.press("Escape");
  await expect(a.getByRole("menu", { name: "Table options", exact: true })).toHaveCount(0);
  await a.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await a.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    "table does not overflow the mobile page",
  );
  await a.screenshot({ path: output + "/editable-table-mobile.png", fullPage: true });
  checkpoint();

  stage = "read-only table controls and typing (frontend fixture, not authorization proof)";
  const readerContext = await browser.newContext({
    storageState: await contexts[0].storageState(),
  });
  const reader = await readerContext.newPage();
  reader.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await reader.route(/\/api\/(auth\/session|connect)(\?|$)/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, canWrite: false } });
  });
  await reader.goto(origin + "/p/" + fixture.page_id);
  await expect(content(reader).first()).toHaveAttribute("contenteditable", "false");
  await shape(reader, 4, 3);
  await expect(
    reader
      .getByRole("button", { name: /^(Table options|Insert table)$/ })
      .and(reader.locator(":enabled")),
  ).toHaveCount(0);
  const before = await call(a, "read_page", { page_id: fixture.page_id });
  await cell(reader, 1, 0).click();
  await reader.keyboard.type("must not edit");
  await expect(table(reader)).not.toContainText("must not edit");
  const after = await call(a, "read_page", { page_id: fixture.page_id });
  assert.deepEqual(after.heads, before.heads);
  await readerContext.close();
  checkpoint();

  stage = "insert a table through the toolbar";
  await a.setViewportSize({ width: 1280, height: 900 });
  current = await call(a, "read_page", { page_id: fixture.page_id });
  await call(a, "edit_page", {
    page_id: fixture.page_id,
    base_heads: current.heads,
    idempotency_key: crypto.randomUUID(),
    operations: [
      { op: "replace_block_markdown", block_id: tableBlock.id, markdown: "A place to write." },
    ],
  });
  for (const page of [a, b]) {
    await expect(table(page)).toHaveCount(0);
    await expect(content(page).first()).toHaveText("A place to write.");
  }
  await content(a).first().click();
  await a.keyboard.press("ControlOrMeta+End");
  await a.keyboard.press("Enter");
  await a.getByRole("button", { name: "Insert table", exact: true }).click();
  await a.getByLabel("Columns", { exact: true }).fill("");
  await expect(a.getByLabel("Columns", { exact: true })).toHaveValue("");
  await a.getByLabel("Columns", { exact: true }).fill("3");
  await a.keyboard.press("Tab");
  await expect(a.getByRole("dialog", { name: "Insert table", exact: true })).toBeVisible();
  await expect(a.getByLabel("Rows", { exact: true })).toBeFocused();
  await a.getByLabel("Rows", { exact: true }).fill("");
  await expect(a.getByLabel("Rows", { exact: true })).toHaveValue("");
  await a.getByLabel("Rows", { exact: true }).fill("2");
  await a.getByRole("button", { name: "Insert table", exact: true }).last().click();
  for (const page of [a, b]) await shape(page, 2, 3);
  await selectCell(a, 0, 0, true);
  await a.keyboard.insertText("First heading");
  await expect(cell(b, 0, 0)).toHaveText("First heading");
  await saved(a);
  checkpoint();

  stage = "HTML table paste retains cell alignment through sync and reload";
  await selectCell(a, 1, 0, true);
  await content(a)
    .first()
    .evaluate((element) => {
      const data = new DataTransfer();
      data.setData(
        "text/html",
        '<table><tbody><tr><td style="text-align: right">Pasted right</td><td style="text-align: center">Pasted center</td></tr></tbody></table>',
      );
      data.setData("text/plain", "Pasted right\tPasted center");
      // Exercise the actual paste handler without touching the host clipboard.
      const range = getSelection().getRangeAt(0);
      element.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "insertFromPaste",
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
          targetRanges: [
            new StaticRange({
              startContainer: range.startContainer,
              startOffset: range.startOffset,
              endContainer: range.endContainer,
              endOffset: range.endOffset,
            }),
          ],
        }),
      );
    });
  for (const page of [a, b]) {
    await shape(page, 2, 3);
    await expect(cell(page, 1, 0)).toHaveText("Pasted right");
    await expect(cell(page, 1, 1)).toHaveText("Pasted center");
    assert.equal(await cell(page, 1, 0).evaluate((el) => getComputedStyle(el).textAlign), "right");
    assert.equal(await cell(page, 1, 1).evaluate((el) => getComputedStyle(el).textAlign), "center");
  }
  await saved(a);
  await a.reload();
  await expect(cell(a, 1, 0)).toHaveText("Pasted right");
  assert.equal(await cell(a, 1, 0).evaluate((el) => getComputedStyle(el).textAlign), "right");
  checkpoint();

  for (const page of [a, b]) await expect(page.locator(".app > .error")).toHaveCount(0);
  assert.deepEqual(errors, [], "no unhandled browser errors");
  report.result = "pass";
} catch (error) {
  report.result = "fail";
  report.stage = stage;
  report.failure = String(error.stack ?? error);
  report.focus =
    a &&
    (await a
      .evaluate(() => ({
        tag: document.activeElement?.tagName,
        label: document.activeElement?.getAttribute("aria-label"),
        text: document.activeElement?.textContent?.slice(0, 120),
      }))
      .catch(() => null));
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
  // Delete only this run's scratch pages, including on failure. Screenshots and
  // the report retain diagnostics without exhausting the local account quota.
  report.cleanedUp = true;
  for (const page_id of report.fixtures) {
    try {
      const current = await call(a, "read_page", { page_id });
      await call(a, "delete_page", {
        page_id,
        base_heads: current.heads,
        idempotency_key: crypto.randomUUID(),
      });
      await purgeTrashedFixture(
        (operation, args) => call(a, operation, args),
        page_id,
        () => ({
          idempotency_key: crypto.randomUUID(),
        }),
      );
    } catch (error) {
      report.cleanedUp = false;
      report.cleanupError = String(error);
      process.exitCode = 1;
    }
  }
  await writeFile(output + "/report.json", JSON.stringify(report, null, 2) + "\n");
  await browser.close();
}
