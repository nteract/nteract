import { expect, test } from "@playwright/test";
import {
  ensureCodeCell,
  executeCell,
  setCellSource,
  waitForKernelStatus,
  waitForNotebookReady,
  waitForOutputContaining,
} from "./helpers";

test.describe("noisy output interrupt", () => {
  test("interrupts a stdout flood and keeps the kernel usable", async ({ page }) => {
    await waitForNotebookReady(page);
    await waitForKernelStatus(page, "idle", 120_000);

    const cell = await ensureCodeCell(page);
    await setCellSource(
      cell,
      [
        "import sys",
        "import time",
        "",
        "for ii in range(10_000):",
        "    print(f'noisy-e2e-line-{ii}')",
        "    sys.stdout.flush()",
        "    time.sleep(0.001)",
        "",
        "print('noisy-e2e-finished')",
      ].join("\n"),
    );

    await executeCell(cell);
    await waitForOutputContaining(cell, "noisy-e2e-line-25", 60_000);

    await page.getByTestId("interrupt-kernel-button").click();
    await waitForKernelStatus(page, "idle", 60_000);

    await setCellSource(cell, "print('after noisy interrupt e2e')");
    await executeCell(cell);

    const output = await waitForOutputContaining(cell, "after noisy interrupt e2e", 60_000);
    await expect(output).toContainText("after noisy interrupt e2e");
  });
});
