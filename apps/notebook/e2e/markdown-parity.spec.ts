import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ensureMarkdownCell,
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
    const renderedMarkdown = await renderedMarkdownSurface(markdownCell, "Markdown parity heading");

    await expect(
      renderedMarkdown.getByRole("heading", { name: "Markdown parity heading" }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(renderedMarkdown).toContainText("Selectable paragraph for copy behavior");
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
    await expect(
      renderedMarkdown.getByRole("button", { name: "raw html stays isolated" }),
    ).toBeVisible();

    await expect(renderedMarkdown.locator("pre")).toContainText("highlighted code block");

    await activateRenderedMarkdown(markdownCell);
    const copyText = await copyRenderedText(
      page,
      renderedMarkdown.locator("p", { hasText: "Selectable paragraph for copy behavior" }),
    );
    expect(copyText.selection).toContain("Selectable paragraph");
    expect(copyText.clipboard).toContain("Selectable paragraph");

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

    const outputMarkdown = await renderedMarkdownSurface(codeCell, "Markdown output parity");

    await expect(
      outputMarkdown.getByRole("heading", { name: "Markdown output parity" }),
    ).toBeVisible({
      timeout: 60_000,
    });
    await expect(outputMarkdown).toContainText("Selectable output paragraph");
    await expect(outputMarkdown.getByRole("table")).toContainText("markdown");
    await expect
      .poll(() => outputMarkdown.locator(".katex").count(), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);

    const copyText = await copyRenderedText(
      page,
      outputMarkdown.locator("p", { hasText: "Selectable output paragraph" }),
    );
    expect(copyText.selection).toContain("Selectable output");
    expect(copyText.clipboard).toContain("Selectable output");
  });

  test("round-trips rendered markdown through double-click edit and render", async ({ page }) => {
    const markdownCell = await createParityMarkdownCell(
      page,
      "# Editable parity heading\n\nOriginal rendered text.",
    );
    const renderedMarkdown = await renderedMarkdownSurface(markdownCell, "Editable parity heading");
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
    await expect(renderedMarkdown).toContainText("Updated rendered text after edit.", {
      timeout: 60_000,
    });
    await expect(renderedMarkdown).not.toContainText("Original rendered text.");

    await doubleClickRenderedMarkdown(markdownCell);
    await expect(editor).toBeVisible({ timeout: 10_000 });

    await setCellSource(
      markdownCell,
      "# Editable parity heading\n\nSecond rendered text after another edit.",
    );
    await expect.poll(() => getCellSource(markdownCell)).toContain("Second rendered text");

    await editor.press("Control+Enter");
    await expect(editor).toBeHidden({ timeout: 10_000 });
    await expect(renderedMarkdown).toContainText("Second rendered text after another edit.", {
      timeout: 60_000,
    });
    await expect(renderedMarkdown).not.toContainText("Updated rendered text after edit.");
  });

  test("renders a newly inserted markdown cell after editing through the UI", async ({ page }) => {
    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);

    const markdownCell = await ensureMarkdownCell(page);
    const editor = markdownCell.locator('.cm-content[contenteditable="true"]');
    await expect(editor).toBeVisible({ timeout: 10_000 });

    await setCellSource(
      markdownCell,
      "# Inserted markdown parity\n\nhello from the inserted markdown cell",
    );
    await expect.poll(() => getCellSource(markdownCell)).toContain("hello from the inserted");

    await editor.press("Control+Enter");
    await expect(editor).toBeHidden({ timeout: 10_000 });

    const renderedMarkdown = await renderedMarkdownSurface(
      markdownCell,
      "Inserted markdown parity",
    );
    await expect(renderedMarkdown).toContainText("hello from the inserted markdown cell", {
      timeout: 60_000,
    });
    await expect(renderedMarkdown).not.toContainText("Enter markdown");
  });

  test("reconciles remote markdown source updates while rendered", async ({ page }) => {
    const { cell: markdownCell, cellId } = await createParityMarkdownCellWithId(
      page,
      "# Remote markdown parity\n\nOriginal remote text.",
    );
    const renderedMarkdown = await renderedMarkdownSurface(markdownCell, "Remote markdown parity");

    await expect(renderedMarkdown).toContainText("Original remote text.", { timeout: 60_000 });

    await mcp!.setCell(cellId, "# Remote markdown parity\n\nUpdated by the MCP peer.");

    await expect
      .poll(() => getCellSource(markdownCell), { timeout: 30_000 })
      .toContain("Updated by the MCP peer");
    await expect(renderedMarkdown).toContainText("Updated by the MCP peer.", { timeout: 60_000 });
    await expect(renderedMarkdown).not.toContainText("Original remote text.");
  });
});

async function createParityMarkdownCell(page: Page, source: string): Promise<Locator> {
  return (await createParityMarkdownCellWithId(page, source)).cell;
}

async function createParityMarkdownCellWithId(
  page: Page,
  source: string,
): Promise<{ cell: Locator; cellId: string }> {
  const notebookId = crypto.randomUUID();
  await openNotebookRoom(page, notebookId);

  mcp = await McpPeer.start();
  await mcp.connectNotebook(notebookId);
  const cellId = await mcp.createCell(source, "markdown");
  await waitForCellCount(page, 2);

  const markdownCell = page.locator('[data-cell-type="markdown"]').first();
  await expect(markdownCell).toBeVisible();
  return { cell: markdownCell, cellId };
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

async function renderedMarkdownSurface(
  markdownCell: Locator,
  headingName: string,
): Promise<Locator> {
  // Keep the host-vs-iframe dependency at this boundary. Projected markdown
  // renders in the host DOM; unsafe fallback and legacy markdown render inside
  // the isolated frame.
  const projected = markdownCell.locator('[data-slot="projected-markdown-output"]');
  const isolatedBody = markdownCell.frameLocator('[data-slot="isolated-frame"]').locator("body");

  await expect
    .poll(
      async () => {
        if (await projected.getByRole("heading", { name: headingName }).isVisible()) {
          return "projected";
        }
        if (await isolatedBody.getByRole("heading", { name: headingName }).isVisible()) {
          return "isolated";
        }
        return "none";
      },
      { timeout: 60_000 },
    )
    .not.toBe("none");

  if (await projected.getByRole("heading", { name: headingName }).isVisible()) {
    return projected;
  }
  return isolatedBody;
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
  return await locator.evaluate((element) => {
    const document = element.ownerDocument;
    const window = document.defaultView;
    const range = document.createRange();
    range.selectNodeContents(element);

    const selection = window?.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    window?.focus();

    return selection?.toString() ?? "";
  });
}

async function copyRenderedText(
  page: Page,
  locator: Locator,
): Promise<{ clipboard: string; selection: string }> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  const selection = await selectRenderedText(page, locator);
  const copiedFromSelection = await locator
    .evaluate((element) => element.ownerDocument.execCommand("copy"))
    .catch(() => false);
  if (!copiedFromSelection) {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
  }

  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5_000 })
    .not.toBe("");
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());

  return { clipboard, selection };
}
