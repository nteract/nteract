import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ensureCodeCell,
  executeCell,
  openNotebookRoom,
  setCellSource,
  waitForCodeCellContaining,
  waitForKernelStatus,
} from "./helpers";
import { McpPeer } from "./mcp-peer";

test.describe("widget state across notebook windows", () => {
  test.describe.configure({ timeout: 300_000 });

  let mcp: McpPeer | null = null;

  test.afterEach(async () => {
    await mcp?.close();
    mcp = null;
  });

  test("keeps an IntSlider display in sync when another window drags it", async ({
    context,
    page,
  }) => {
    const notebookId = crypto.randomUUID();
    const peerPage = await context.newPage();
    const widgetLogs: string[] = [];
    collectWidgetDiagnostics(page, "primary", widgetLogs);
    collectWidgetDiagnostics(peerPage, "peer", widgetLogs);

    await openNotebookRoom(page, notebookId);
    await waitForKernelStatus(page, "idle", 120_000);

    mcp = await McpPeer.start();
    await mcp.connectNotebook(notebookId);
    await mcp.manageDependencies(["ipywidgets>=8,<9"]);
    await waitForKernelStatus(page, "idle", 120_000);

    await openNotebookRoom(peerPage, notebookId);
    await waitForKernelStatus(peerPage, "idle", 120_000);

    const primaryCell = await ensureCodeCell(page);
    await setCellSource(
      primaryCell,
      [
        "from IPython.display import display",
        "import ipywidgets as widgets",
        "",
        'slider = widgets.IntSlider(value=7, description="probe")',
        "display(slider)",
      ].join("\n"),
    );

    await executeCell(primaryCell);
    await waitForKernelStatus(page, "idle", 120_000);

    const peerCell = await waitForCodeCellContaining(peerPage, "widgets.IntSlider", 60_000);
    const primarySlider = widgetSlider(primaryCell);
    const peerSlider = widgetSlider(peerCell);

    await expect(primarySlider).toBeVisible({ timeout: 60_000 });
    await expect(peerSlider).toBeVisible({ timeout: 60_000 });
    await expectNoWidgetLoading(primaryCell);
    await expectNoWidgetLoading(peerCell);
    await expectSliderValue(primarySlider, "7");
    await expectSliderValue(peerSlider, "7");

    await dragSliderToValue(primarySlider, 18);

    await expectSliderValue(primarySlider, "18");
    await expectSliderValue(peerSlider, "18");
    expect(widgetLogs.join("\n")).not.toMatch(/waiting for widget|loading widget/i);
  });
});

function widgetSlider(cell: Locator): Locator {
  return cell
    .frameLocator('[data-slot="isolated-frame"]')
    .locator('[data-widget-type="IntSlider"]')
    .getByRole("slider")
    .first();
}

async function expectSliderValue(slider: Locator, value: string): Promise<void> {
  await expect(slider).toHaveAttribute("aria-valuenow", value, { timeout: 60_000 });
}

async function expectNoWidgetLoading(cell: Locator): Promise<void> {
  const body = cell.frameLocator('[data-slot="isolated-frame"]').locator("body");
  await expect
    .poll(async () => ((await body.count()) > 0 ? await body.innerText() : ""), {
      timeout: 60_000,
    })
    .not.toMatch(/waiting for widget|loading widget/i);
}

async function dragSliderToValue(slider: Locator, targetValue: number): Promise<void> {
  const [min, max] = await Promise.all([
    slider.getAttribute("aria-valuemin").then((value) => Number(value ?? 0)),
    slider.getAttribute("aria-valuemax").then((value) => Number(value ?? 100)),
  ]);

  const sliderRoot = slider.locator(
    "xpath=ancestor::*[@data-orientation='horizontal' and contains(@class, 'touch-none')][1]",
  );
  const box = await sliderRoot.boundingBox();
  if (!box) {
    throw new Error("IntSlider did not expose a slider root bounding box for drag");
  }

  const clamped = Math.min(max, Math.max(min, targetValue));
  const ratio = max === min ? 0 : (clamped - min) / (max - min);
  const thumbBox = await slider.boundingBox();
  if (!thumbBox) {
    throw new Error("IntSlider did not expose a thumb bounding box for drag");
  }

  const page = slider.page();
  await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * ratio, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
}

function collectWidgetDiagnostics(page: Page, label: string, logs: string[]): void {
  page.on("console", (message) => {
    const text = message.text();
    if (
      /waiting for widget|loading widget|WidgetView|widget|comm|isolated-frame|isolated-renderer/i.test(
        text,
      )
    ) {
      logs.push(`[${label}:${message.type()}] ${text}`);
    }
  });
  page.on("pageerror", (error) => {
    logs.push(`[${label}:pageerror] ${error.message}`);
  });
}
