import { expect, test, type FrameLocator, type Locator, type Page } from "@playwright/test";
import {
  ensureCodeCell,
  executeCell,
  openNotebookRoom,
  setCellSource,
  waitForCellCount,
  waitForCodeCellContaining,
  waitForCellSourceContaining,
  waitForKernelStatus,
  waitForOutputContaining,
} from "./helpers";
import { McpPeer } from "./mcp-peer";

test.describe("jupyter-scatter lasso selection", () => {
  let mcp: McpPeer | null = null;

  test.afterEach(async () => {
    await mcp?.close();
    mcp = null;
  });

  test("round-trips a lasso selection through binary widget comm buffers", async ({ page }) => {
    test.setTimeout(240_000);

    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);
    await waitForKernelStatus(page, "idle", 120_000);

    mcp = await McpPeer.start();
    await mcp.connectNotebook(notebookId);
    await mcp.manageDependencies(["jupyter-scatter>=1.0,<1.1"]);
    await waitForKernelStatus(page, "idle", 180_000);

    const scatterCell = await ensureCodeCell(page);
    await setCellSource(
      scatterCell,
      [
        "import pandas as pd",
        "import numpy as np",
        "import jscatter",
        "",
        "rng = np.random.default_rng(42)",
        "df = pd.DataFrame({",
        "    'mass': rng.random(1000),",
        "    'speed': rng.random(1000),",
        "    'pval': rng.random(1000),",
        "    'group': rng.integers(0, 4, 1000).astype(str),",
        "})",
        "jpl = jscatter.plot(",
        "    data=df,",
        "    x='mass',",
        "    y='speed',",
        "    lasso_initiator=False,",
        "    lasso_on_long_press=False,",
        "    lasso_min_dist=1,",
        "    lasso_type='rectangle',",
        "    mouse_mode='lasso',",
        ")",
        "jpl",
      ].join("\n"),
    );

    await executeCell(scatterCell);
    await waitForKernelStatus(page, "idle", 120_000);

    const widgetFrame = scatterCell.frameLocator("iframe");
    const plotSurface = widgetFrame.locator("canvas").first();
    await expect(plotSurface).toBeVisible({ timeout: 120_000 });

    await selectLassoTool(widgetFrame);
    await dragLassoAroundCenter(page, plotSurface);
    await page.waitForTimeout(3_000);
    await expect
      .poll(() => getFrontendSelectionCount(page), { timeout: 30_000 })
      .toBeGreaterThan(0);

    const selectionCellId = await mcp.createCell("# jscatter selection probe");
    await waitForCellCount(page, 2);
    const selectionCell = await waitForCodeCellContaining(page, "jscatter selection probe");
    await waitForBackendSelectionCount(page, mcp, selectionCellId, selectionCell);

    await expect
      .poll(() => getFrontendSelectionCount(page), { timeout: 30_000 })
      .toBeGreaterThan(0);
  });
});

async function selectLassoTool(widgetFrame: FrameLocator) {
  const namedButton = widgetFrame.getByRole("button", { name: /activate lasso selection/i });
  if ((await namedButton.count()) > 0) {
    await namedButton.click();
    return;
  }

  const titleButton = widgetFrame
    .locator(
      "button[title*='lasso' i], button[aria-label*='lasso' i], [role='button'][title*='lasso' i], [role='button'][aria-label*='lasso' i]",
    )
    .first();
  if ((await titleButton.count()) > 0) {
    await titleButton.click();
    return;
  }

  throw new Error(
    "Could not find lasso tool: tried role=button[name=lasso] and " +
      "[title|aria-label*=lasso]. jscatter toolbar may have changed; " +
      "update selectLassoTool fallbacks.",
  );
}

async function dragLassoAroundCenter(page: Page, canvas: Locator) {
  const box = await canvas.boundingBox();
  if (!box) throw new Error("jscatter canvas is missing a layout box");

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const points = [
    [cx - 180, cy - 120],
    [cx + 180, cy + 120],
  ] as const;

  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) {
    await page.mouse.move(x, y, { steps: 10 });
  }
  await page.mouse.up();
  await page.waitForTimeout(750);
}

function parseSelectionCount(text: string | null, marker: string): number {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text?.match(new RegExp(`${escapedMarker}\\s+(\\d+)`));
  return match ? Number(match[1]) : 0;
}

async function waitForBackendSelectionCount(
  page: Page,
  mcp: McpPeer,
  selectionCellId: string,
  selectionCell: Locator,
) {
  const deadline = Date.now() + 120_000;
  let attempt = 0;
  let lastCount = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    const marker = `jscatter-selection-count-${attempt}-${crypto.randomUUID()}`;
    await mcp.setCell(selectionCellId, `print('${marker}', len(jpl.selection))`);
    await waitForCellSourceContaining(selectionCell, marker, 30_000);

    await executeCell(selectionCell);
    await waitForKernelStatus(page, "idle", 60_000);
    const output = await waitForOutputContaining(selectionCell, marker, 60_000);
    lastCount = parseSelectionCount(await output.textContent(), marker);
    if (lastCount > 0) return;

    await page.waitForTimeout(1_000);
  }

  expect(lastCount).toBeGreaterThan(0);
}

async function getFrontendSelectionCount(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const testApi = (
      window as unknown as {
        __nteractWidgetTest?: { selectionCountForComm(commId: string | null): number | null };
      }
    ).__nteractWidgetTest;
    return testApi?.selectionCountForComm(null) ?? 0;
  });
}
