import { expect, test, type Locator } from "@playwright/test";
import {
  ensureCodeCell,
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
    await expect(frame.locator("body")).toContainText("stream before", { timeout: 60_000 });
    await expect(frame.locator("body")).toContainText(/2 DOM rows|a#1|b#3/i, {
      timeout: 60_000,
    });
    await expect.poll(() => isolatedRootHeight(cell), { timeout: 30_000 }).toBeGreaterThan(20);

    expect(isolatedLogs.join("\n")).not.toContain("rendered-empty-after-paint");
    expect(isolatedLogs.join("\n")).not.toContain("renderer-error");
  });
});

async function isolatedRootHeight(cell: Locator): Promise<number> {
  const root = cell.frameLocator('[data-slot="isolated-frame"]').locator("#root");
  return await root.evaluate((element) => element.getBoundingClientRect().height);
}
