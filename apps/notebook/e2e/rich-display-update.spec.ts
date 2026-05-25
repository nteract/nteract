import { expect, test, type Locator } from "@playwright/test";
import {
  ensureCodeCell,
  executeCell,
  openNotebookRoom,
  setCellSource,
  waitForCellCount,
  waitForKernelStatus,
} from "./helpers";

test.describe("rich display updates", () => {
  test("updates a Plotly display_id output without remounting the live plot", async ({ page }) => {
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

    const initialCell = await ensureCodeCell(page);
    await setCellSource(
      initialCell,
      [
        "from IPython.display import display",
        "",
        "handle = display(",
        "    {",
        '        "application/vnd.plotly.v1+json": {',
        '            "data": [{"type": "bar", "x": ["A"], "y": [1]}],',
        '            "layout": {"title": {"text": "Plotly first display"}, "height": 320, "width": 480},',
        "        },",
        '        "text/plain": "plotly first display",',
        "    },",
        "    raw=True,",
        '    display_id="plotly-display-update-e2e",',
        ")",
      ].join("\n"),
    );

    await executeCell(initialCell);
    await waitForKernelStatus(page, "idle", 120_000);

    const initialCellId = await initialCell.getAttribute("data-cell-id");
    if (!initialCellId) throw new Error("Initial cell is missing data-cell-id");

    const initialCellById = page.locator(`[data-cell-id="${initialCellId}"]`);
    const outputFrame = initialCellById.frameLocator('[data-slot="isolated-frame"]');
    await expect(outputFrame.locator("body")).toContainText("Plotly first display", {
      timeout: 60_000,
    });

    const plot = outputFrame.locator('[data-slot="plotly-output"].js-plotly-plot');
    await expect(plot).toBeVisible({ timeout: 60_000 });
    await tagPlotNode(plot, "plot-node-survived-display-update");

    await page.getByTestId("add-code-cell-button").click();
    await waitForCellCount(page, 2);

    const updateCell = page.locator(
      `[data-cell-type="code"]:not([data-cell-id="${initialCellId}"])`,
    );
    await setCellSource(
      updateCell,
      [
        "from IPython.display import update_display",
        "",
        "update_display(",
        "    {",
        '        "application/vnd.plotly.v1+json": {',
        '            "data": [{"type": "bar", "x": ["A"], "y": [5]}],',
        '            "layout": {"title": {"text": "Plotly updated display"}, "height": 320, "width": 480},',
        "        },",
        '        "text/plain": "plotly updated display",',
        "    },",
        "    raw=True,",
        '    display_id="plotly-display-update-e2e",',
        ")",
      ].join("\n"),
    );

    await executeCell(updateCell);
    await waitForKernelStatus(page, "idle", 120_000);

    await expect(outputFrame.locator("body")).toContainText("Plotly updated display", {
      timeout: 60_000,
    });
    await expect
      .poll(() => plotNodeTag(plot), { timeout: 30_000 })
      .toBe("plot-node-survived-display-update");
    await expect(initialCellById.locator('[data-slot="isolated-frame"]')).toHaveCount(1);

    const logs = isolatedLogs.join("\n");
    expect(logs).not.toContain("rendered-empty-after-paint");
    expect(logs).not.toContain("renderer-bundle-pending");
    expect(logs).not.toContain("renderer-error");
  });
});

async function tagPlotNode(plot: Locator, tag: string): Promise<void> {
  await plot.evaluate((node, value) => {
    (node as HTMLElement & { __nteractE2eDisplayUpdateTag?: string }).__nteractE2eDisplayUpdateTag =
      value;
  }, tag);
}

async function plotNodeTag(plot: Locator): Promise<string | undefined> {
  return await plot.evaluate(
    (node) =>
      (node as HTMLElement & { __nteractE2eDisplayUpdateTag?: string })
        .__nteractE2eDisplayUpdateTag,
  );
}
