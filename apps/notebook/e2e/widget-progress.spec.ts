import { expect, test, type Locator } from "@playwright/test";
import {
  ensureCodeCell,
  executeCell,
  openNotebookRoom,
  setCellSource,
  waitForCellCount,
  waitForKernelStatus,
  waitForOutputContaining,
} from "./helpers";
import { McpPeer } from "./mcp-peer";

test.describe("widget progress output", () => {
  test.describe.configure({ timeout: 240_000 });

  let mcp: McpPeer | null = null;

  test.afterEach(async () => {
    await mcp?.close();
    mcp = null;
  });

  test("renders and updates a FloatProgress widget in the browser", async ({ page }) => {
    const isolatedLogs: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (
        text.includes("[isolated-frame]") ||
        text.includes("[isolated-renderer]") ||
        text.includes("[WidgetView]") ||
        text.includes("[OutputArea]")
      ) {
        isolatedLogs.push(`[${message.type()}] ${text}`);
      }
    });

    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);
    await waitForKernelStatus(page, "idle", 120_000);

    mcp = await McpPeer.start();
    await mcp.connectNotebook(notebookId);
    await mcp.manageDependencies(["ipywidgets>=8,<9"]);
    await waitForKernelStatus(page, "idle", 120_000);

    const progressCell = await ensureCodeCell(page);
    await setCellSource(
      progressCell,
      [
        "from IPython.display import display",
        "import ipywidgets as widgets",
        "",
        "progress = widgets.FloatProgress(",
        "    value=100.0,",
        "    min=0.0,",
        "    max=100.0,",
        "    description='Resolving data files',",
        "    bar_style='success',",
        ")",
        "display(progress)",
      ].join("\n"),
    );

    await executeCell(progressCell);
    await waitForKernelStatus(page, "idle", 120_000);

    const progressCellId = await progressCell.getAttribute("data-cell-id");
    if (!progressCellId) throw new Error("Progress cell is missing data-cell-id");

    const progressCellById = page.locator(`[data-cell-id="${progressCellId}"]`);
    const progressFrame = progressCellById.frameLocator('[data-slot="isolated-frame"]');
    const progressWidget = progressFrame.locator('[data-widget-type="FloatProgress"]').first();
    await expect(progressWidget).toBeVisible({ timeout: 60_000 });
    await expect(progressWidget).toContainText("Resolving data files");

    const progressbar = progressWidget.getByRole("progressbar");
    await expect(progressbar).toBeVisible();
    await expect(progressbar).toHaveAttribute("aria-valuemin", "0");
    await expect(progressbar).toHaveAttribute("aria-valuemax", "100");
    await expect(progressbar).toHaveAttribute("aria-valuenow", "100");
    await expect(progressWidget.locator('[data-slot="progress-indicator"]')).toBeVisible();

    const frameText = await progressFrame.locator("body").innerText();
    expect(frameText).not.toContain("Loading widget");

    await page.getByTestId("add-code-cell-button").click();
    await waitForCellCount(page, 2);

    const updateCell = page.locator(
      `[data-cell-type="code"]:not([data-cell-id="${progressCellId}"])`,
    );
    await setCellSource(
      updateCell,
      ["progress.value = 42.5", "print(f'progress-widget-now-{progress.value}')"].join("\n"),
    );

    await executeCell(updateCell);
    await waitForOutputContaining(updateCell, "progress-widget-now-42.5", 60_000);
    await waitForKernelStatus(page, "idle", 120_000);

    await expectProgressValue(progressbar, "42.5");

    const logs = isolatedLogs.join("\n");
    expect(logs).not.toContain("rendered-empty-after-paint");
    expect(logs).not.toContain("renderer-error");
    expect(logs).not.toContain("Loading widget");
  });
});

async function expectProgressValue(progressbar: Locator, value: string): Promise<void> {
  await expect(progressbar).toHaveAttribute("aria-valuenow", value, { timeout: 60_000 });
}
