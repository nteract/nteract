import { expect, test, type FrameLocator, type Locator, type Page } from "@playwright/test";
import {
  executeCell,
  getCellSource,
  openNotebookRoom,
  setCellSource,
  waitForCellCount,
  waitForCodeCellContaining,
  waitForKernelStatus,
} from "./helpers";
import {
  MARKDOWN_CELL_PARITY_SOURCE,
  MARKDOWN_OUTPUT_PARITY_CODE,
} from "./fixtures/markdown-parity";
import { McpPeer } from "./mcp-peer";

let mcp: McpPeer | null = null;

test.describe("markdown parity", () => {
  test.afterEach(async () => {
    await mcp?.close();
    mcp = null;
  });

  test("renders rich markdown, math, raw HTML, task lists, selection, and outline anchors", async ({
    page,
  }) => {
    const markdownCell = await createParityMarkdownCell(page, MARKDOWN_CELL_PARITY_SOURCE);
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

  test("renders selectable markdown outputs without changing output routing semantics", async ({
    page,
  }) => {
    const codeCell = await createParityCodeCell(page, MARKDOWN_OUTPUT_PARITY_CODE);
    await executeCell(codeCell);

    const outputMarkdown = renderedMarkdownSurface(codeCell);
    const outputBody = outputMarkdown.locator("body");

    await expect(
      outputMarkdown.getByRole("heading", { name: "Markdown output parity" }),
    ).toBeVisible({
      timeout: 60_000,
    });
    await expect(outputBody).toContainText("Selectable output paragraph");
    await expect(outputMarkdown.getByRole("table")).toContainText("markdown");
    await expect
      .poll(() => outputMarkdown.locator(".katex").count(), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);

    const selectionText = await selectRenderedText(
      page,
      outputMarkdown.locator("p", { hasText: "Selectable output paragraph" }),
    );
    expect(selectionText).toContain("Selectable output");
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

async function createParityCodeCell(page: Page, source: string): Promise<Locator> {
  const notebookId = crypto.randomUUID();
  await openNotebookRoom(page, notebookId);
  await waitForKernelStatus(page, "idle", 120_000);

  mcp = await McpPeer.start();
  await mcp.connectNotebook(notebookId);
  await mcp.createCell(source, "code");

  return await waitForCodeCellContaining(page, "Markdown output parity");
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

async function selectRenderedText(_page: Page, locator: Locator): Promise<string> {
  await locator.scrollIntoViewIfNeeded();
  await locator.selectText({ force: true });
  return locator.evaluate(() => window.getSelection()?.toString() ?? "");
}
