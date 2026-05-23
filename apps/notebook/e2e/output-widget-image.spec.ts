import { expect, test, type Locator } from "@playwright/test";
import {
  ensureCodeCell,
  executeCell,
  openNotebookRoom,
  setCellSource,
  waitForKernelStatus,
} from "./helpers";
import { McpPeer } from "./mcp-peer";

test.describe("OutputWidget image outputs", () => {
  let mcp: McpPeer | null = null;

  test.afterEach(async () => {
    await mcp?.close();
    mcp = null;
  });

  test("renders and updates image/png emitted by interact", async ({ page }) => {
    test.setTimeout(180_000);

    const isolatedLogs: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (
        text.includes("[isolated-frame]") ||
        text.includes("[isolated-renderer]") ||
        text.includes("[OutputWidget]") ||
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

    const cell = await ensureCodeCell(page);
    await setCellSource(
      cell,
      [
        "from IPython.display import Image, display",
        "import ipywidgets as widgets",
        "import struct",
        "import zlib",
        "",
        "def make_png(value):",
        "    value = int(value)",
        "    width = 64 + value * 8",
        "    height = 64",
        "    r = 40 + value * 80",
        "    g = 70 + value * 35",
        "    b = 210 - value * 60",
        "    seed = 12345 + value",
        "    rows = []",
        "    for _y in range(height):",
        "        row = bytearray([0])",
        "        for _x in range(width):",
        "            seed = (1103515245 * seed + 12345) & 0x7fffffff",
        "            row.extend([(seed >> 16) & 255, ((seed >> 8) + g) & 255, (seed + b) & 255])",
        "        rows.append(bytes(row))",
        "    raw = b''.join(rows)",
        "",
        "    def chunk(kind, data):",
        "        crc = zlib.crc32(kind + data) & 0xFFFFFFFF",
        "        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', crc)",
        "",
        "    return (",
        "        b'\\x89PNG\\r\\n\\x1a\\n'",
        "        + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))",
        "        + chunk(b'IDAT', zlib.compress(raw))",
        "        + chunk(b'IEND', b'')",
        "    )",
        "",
        "@widgets.interact(x=widgets.IntSlider(value=0, min=0, max=2, step=1, description='x'))",
        "def show_plot(x):",
        "    display(Image(data=make_png(x), format='png'))",
      ].join("\n"),
    );

    await executeCell(cell);
    await waitForKernelStatus(page, "idle", 120_000);

    const widgetFrame = cell.frameLocator('[data-slot="isolated-frame"]');
    const outputImages = widgetFrame.locator('[data-widget-type="Output"] img');
    await expect(outputImages).toHaveCount(1, { timeout: 60_000 });
    await expect.poll(() => loadedImageWidth(outputImages.first()), { timeout: 60_000 }).toBe(64);
    await expect
      .poll(() => imageSrc(outputImages.first()), { timeout: 60_000 })
      .toMatch(/^http:\/\/127\.0\.0\.1:\d+\/blob\/[a-f0-9]+$/);

    const slider = widgetFrame.getByRole("slider").first();
    await expect(slider).toBeVisible({ timeout: 60_000 });
    await slider.click();
    await slider.press("ArrowRight");

    await expect(slider).toHaveAttribute("aria-valuenow", "1", { timeout: 30_000 });
    await expect.poll(() => loadedImageWidth(outputImages.first()), { timeout: 60_000 }).toBe(72);
    await expect
      .poll(() => imageSrc(outputImages.first()), { timeout: 60_000 })
      .toMatch(/^http:\/\/127\.0\.0\.1:\d+\/blob\/[a-f0-9]+$/);
    await expect(outputImages).toHaveCount(1);

    const logs = isolatedLogs.join("\n");
    expect(logs).not.toContain("rendered-empty-after-paint");
    expect(logs).not.toContain("renderer-error");
    expect(logs).not.toContain("[OutputWidget] Error rendering");
  });
});

async function loadedImageWidth(image: Locator): Promise<number> {
  return await image.evaluate((element) => {
    const img = element as HTMLImageElement;
    return img.complete && img.naturalWidth > 0 ? img.naturalWidth : 0;
  });
}

async function imageSrc(image: Locator): Promise<string> {
  return await image.evaluate((element) => {
    const img = element as HTMLImageElement;
    return img.currentSrc || img.src;
  });
}
