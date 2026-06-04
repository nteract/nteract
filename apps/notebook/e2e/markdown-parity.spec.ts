import { expect, test, type FrameLocator, type Locator, type Page } from "@playwright/test";
import {
  getCellSource,
  openNotebookRoom,
  setCellSource,
  waitForCellCount,
  waitForKernelStatus,
} from "./helpers";
import { McpPeer } from "./mcp-peer";

const PARITY_MARKDOWN = [
  "# Markdown parity heading",
  "",
  "Selectable paragraph for copy behavior with **strong text**, *emphasis*, and `inline code`.",
  "",
  "> A quote should keep the document voice without becoming editor chrome.",
  "",
  "- [x] completed task",
  "- [ ] open task",
  "",
  "| package | role |",
  "| --- | --- |",
  "| pandas | dataframes |",
  "| polars | expressions |",
  "",
  "Inline math $E = mc^2$ should typeset, and display math should too:",
  "",
  "$$",
  "a^2 + b^2 = c^2",
  "$$",
  "",
  '<button id="markdown-parity-raw-html">raw html stays isolated</button>',
  "",
  "```python",
  "print('highlighted code block')",
  "```",
  "",
  "## Deep parity section",
  "",
  "The outline should be able to land inside rendered markdown.",
].join("\n");

let mcp: McpPeer | null = null;

test.describe("markdown parity", () => {
  test.afterEach(async () => {
    await mcp?.close();
    mcp = null;
  });

  test("renders rich markdown, math, raw HTML, task lists, selection, and outline anchors", async ({
    page,
  }) => {
    const markdownCell = await createParityMarkdownCell(page, PARITY_MARKDOWN);
    const renderedMarkdown = renderedMarkdownSurface(markdownCell);
    const renderedBody = renderedMarkdown.locator("body");

    await expect(
      renderedMarkdown.getByRole("heading", { name: "Markdown parity heading" }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(renderedBody).toContainText("Selectable paragraph for copy behavior");
    await expect(renderedMarkdown.getByText("strong text")).toBeVisible();
    await expect(renderedMarkdown.getByText("inline code")).toBeVisible();
    await expect(renderedMarkdown.getByRole("table")).toContainText("pandas");
    await expect
      .poll(() => renderedMarkdown.locator(".katex").count(), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);

    const taskCheckboxes = renderedMarkdown.locator('input[type="checkbox"]');
    await expect(taskCheckboxes).toHaveCount(2);
    await expect(taskCheckboxes.nth(0)).toBeChecked();
    await expect(taskCheckboxes.nth(1)).not.toBeChecked();

    // The parity contract is safety, not iframe usage: raw HTML from markdown
    // must not become live DOM in the parent notebook surface.
    await expect(markdownCell.locator("#markdown-parity-raw-html")).toHaveCount(0);

    await expect(renderedMarkdown.locator("pre")).toContainText("highlighted code block");

    await activateRenderedMarkdown(markdownCell);
    const selectionText = await selectRenderedText(
      page,
      renderedMarkdown.locator("p", { hasText: "Selectable paragraph for copy behavior" }),
    );
    expect(selectionText).toContain("Selectable paragraph");

    await page.getByLabel("Outline").click();
    await page.getByRole("link", { name: "Deep parity section" }).click();

    const deepHeading = renderedMarkdown.getByRole("heading", { name: "Deep parity section" });
    await expect
      .poll(async () => (await deepHeading.boundingBox())?.y ?? Infinity)
      .toBeLessThan((page.viewportSize()?.height ?? 720) - 32);
  });

  test("round-trips rendered markdown through double-click edit and render", async ({ page }) => {
    const markdownCell = await createParityMarkdownCell(
      page,
      "# Editable parity heading\n\nOriginal rendered text.",
    );
    const renderedMarkdown = renderedMarkdownSurface(markdownCell);
    await expect(
      renderedMarkdown.getByRole("heading", { name: "Editable parity heading" }),
    ).toBeVisible({ timeout: 60_000 });

    await doubleClickRenderedMarkdown(markdownCell);
    const editor = markdownCell.locator('.cm-content[contenteditable="true"]');
    await expect(editor).toBeVisible({ timeout: 10_000 });

    await setCellSource(
      markdownCell,
      "# Editable parity heading\n\nUpdated rendered text after edit.",
    );
    await expect.poll(() => getCellSource(markdownCell)).toContain("Updated rendered text");

    await editor.press("Control+Enter");
    await expect(editor).toBeHidden({ timeout: 10_000 });
    await expect(renderedMarkdown.locator("body")).toContainText(
      "Updated rendered text after edit.",
      {
        timeout: 60_000,
      },
    );
    await expect(renderedMarkdown.locator("body")).not.toContainText("Original rendered text.");
  });
});

async function createParityMarkdownCell(page: Page, source: string): Promise<Locator> {
  const notebookId = crypto.randomUUID();
  await openNotebookRoom(page, notebookId);
  await waitForKernelStatus(page, "idle", 120_000);

  mcp = await McpPeer.start();
  await mcp.connectNotebook(notebookId);
  await mcp.createCell(source, "markdown");
  await waitForCellCount(page, 2);

  const markdownCell = page.locator('[data-cell-type="markdown"]').first();
  await expect(markdownCell).toBeVisible();
  return markdownCell;
}

function renderedMarkdownSurface(markdownCell: Locator): FrameLocator {
  // Current markdown rendering lives in an isolated frame. Keep the dependency
  // at this boundary so projected/main-DOM markdown can swap this helper
  // without rewriting the conformance assertions above.
  return markdownCell.frameLocator('[data-slot="isolated-frame"]');
}

async function activateRenderedMarkdown(markdownCell: Locator): Promise<void> {
  await markdownCell.getByLabel("Markdown cell content").focus();
}

async function doubleClickRenderedMarkdown(markdownCell: Locator): Promise<void> {
  const preview = markdownCell.getByLabel("Markdown cell content");
  await preview.dblclick({ position: { x: 80, y: 48 } });
}

async function selectRenderedText(page: Page, locator: Locator): Promise<string> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("Cannot select markdown text without a visible bounding box");

  const textRange = await locator.evaluate((element) => {
    const document = element.ownerDocument;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const textNode = walker.nextNode();
    if (!textNode?.textContent) return null;

    const end = Math.min(textNode.textContent.length, 32);
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, end);

    const elementRect = element.getBoundingClientRect();
    const rect = range.getBoundingClientRect();
    range.detach();

    return {
      startX: rect.left - elementRect.left,
      endX: rect.right - elementRect.left,
      y: rect.top - elementRect.top + rect.height / 2,
    };
  });
  if (!textRange) throw new Error("Cannot select markdown text without a text node");

  await page.mouse.move(box.x + textRange.startX, box.y + textRange.y);
  await page.mouse.down();
  await page.mouse.move(box.x + textRange.endX, box.y + textRange.y, { steps: 8 });
  await page.mouse.up();

  return locator.evaluate(() => window.getSelection()?.toString() ?? "");
}
