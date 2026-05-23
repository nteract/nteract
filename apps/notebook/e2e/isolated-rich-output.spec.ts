import { expect, test, type Locator } from "@playwright/test";
import {
  ensureCodeCell,
  ensureMarkdownCell,
  executeCell,
  openNotebookRoom,
  setCellSource,
  waitForKernelStatus,
} from "./helpers";

test.describe("isolated rich output rendering", () => {
  test("keeps stream text visible when a pandas dataframe renders in the iframe", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const isolatedLogs: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (
        text.includes("[isolated-frame]") ||
        text.includes("[isolated-renderer]") ||
        text.includes("[OutputArea]")
      ) {
        isolatedLogs.push(`[${message.type()}] ${text}`);
      }
    });

    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);
    await waitForKernelStatus(page, "idle", 120_000);

    const cell = await ensureCodeCell(page);
    await setCellSource(
      cell,
      [
        'print("stream before")',
        "import pandas as pd",
        'pd.DataFrame({"a": [1, 2], "b": [3, 4]}).head()',
      ].join("\n"),
    );

    await executeCell(cell);
    await waitForKernelStatus(page, "idle", 120_000);

    const frame = cell.frameLocator('[data-slot="isolated-frame"]');
    const frameBody = frame.locator("body");
    await expect(frameBody).toContainText("stream before", { timeout: 60_000 });
    await expect
      .poll(async () => normalizeOutputText(await frameBody.innerText()), { timeout: 60_000 })
      .toMatch(/a\s*#\s*1|b\s*#\s*3|a b 0 1 3 1 2 4/i);
    await expect.poll(() => isolatedRootHeight(cell), { timeout: 30_000 }).toBeGreaterThan(20);

    expect(isolatedLogs.join("\n")).not.toContain("rendered-empty-after-paint");
    expect(isolatedLogs.join("\n")).not.toContain("renderer-bundle-pending");
    expect(isolatedLogs.join("\n")).not.toContain("renderer-error");
  });

  test("renders markdown cells and markdown outputs in isolated iframes", async ({ page }) => {
    test.setTimeout(180_000);

    const isolatedLogs: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (
        text.includes("[isolated-frame]") ||
        text.includes("[isolated-renderer]") ||
        text.includes("[iframe-libraries]") ||
        text.includes("[MarkdownCell]") ||
        text.includes("[OutputArea]")
      ) {
        isolatedLogs.push(`[${message.type()}] ${text}`);
      }
    });

    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);
    await waitForKernelStatus(page, "idle", 120_000);

    const markdownCell = await ensureMarkdownCell(page);
    await setCellSource(
      markdownCell,
      "# Rendered Markdown Cell\n\nThis is **bold** markdown.\n\n- cell item",
    );
    const markdownEditor = markdownCell.locator('.cm-content[contenteditable="true"]');
    await markdownEditor.click();
    await markdownEditor.press("Control+Enter");

    const markdownFrame = markdownCell.frameLocator('[data-slot="isolated-frame"]');
    await expect(markdownFrame.locator("body")).toContainText("Rendered Markdown Cell", {
      timeout: 60_000,
    });
    await expect(markdownFrame.locator("body")).toContainText("cell item", {
      timeout: 60_000,
    });
    await expect
      .poll(() => isolatedRootHeight(markdownCell), { timeout: 30_000 })
      .toBeGreaterThan(20);

    const codeCell = await ensureCodeCell(page);
    await setCellSource(
      codeCell,
      [
        "from IPython.display import Markdown, display",
        'display(Markdown("# Markdown Output\\n\\n- output item"))',
      ].join("\n"),
    );
    await executeCell(codeCell);
    await waitForKernelStatus(page, "idle", 120_000);

    const outputFrame = codeCell.frameLocator('[data-slot="isolated-frame"]');
    await expect(outputFrame.locator("body")).toContainText("Markdown Output", {
      timeout: 60_000,
    });
    await expect(outputFrame.locator("body")).toContainText("output item", {
      timeout: 60_000,
    });
    await expect.poll(() => isolatedRootHeight(codeCell), { timeout: 30_000 }).toBeGreaterThan(20);

    const logs = isolatedLogs.join("\n");
    expect(logs).not.toContain("rendered-empty-after-paint");
    expect(logs).not.toContain("renderer-bundle-pending");
    expect(logs).not.toContain("renderer-error");
  });
});

function normalizeOutputText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

async function isolatedRootHeight(cell: Locator): Promise<number> {
  const root = cell.frameLocator('[data-slot="isolated-frame"]').locator("#root");
  return await root.evaluate((element) => element.getBoundingClientRect().height);
}
