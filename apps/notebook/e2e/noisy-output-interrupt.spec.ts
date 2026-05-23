import { expect, test } from "@playwright/test";
import {
  ensureCodeCell,
  executeCell,
  openNotebookRoom,
  setCellSource,
  waitForCellSourceContaining,
  waitForKernelStatus,
  waitForOutputContaining,
} from "./helpers";
import { McpPeer } from "./mcp-peer";

test.describe("noisy output interrupt", () => {
  let mcp: McpPeer | null = null;

  test.setTimeout(180_000);

  test.afterEach(async () => {
    await mcp?.close();
    mcp = null;
  });

  test("interrupts a stdout flood and keeps the kernel usable from an MCP peer", async ({
    page,
  }) => {
    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);
    await waitForKernelStatus(page, "idle", 120_000);

    mcp = await McpPeer.start();
    await mcp.connectNotebook(notebookId);

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
    // Long stream output is intentionally collapsed after the flood is underway.
    // Wait for the collapsed-output sentinel so this keeps exercising the noisy path.
    const floodOutput = await waitForOutputContaining(cell, "lines hidden", 60_000);
    await expect(floodOutput.getByRole("button", { name: "Show full log" })).toBeVisible();

    await page.getByTestId("interrupt-kernel-button").click();
    await waitForKernelStatus(page, "idle", 60_000);

    const cellId = await cell.getAttribute("data-cell-id");
    if (cellId === null) throw new Error("Interrupted cell is missing data-cell-id");

    await mcp.setCell(cellId, "print('after noisy interrupt from MCP peer')");
    await waitForCellSourceContaining(cell, "after noisy interrupt from MCP peer");
    await executeCell(cell);

    const output = await waitForOutputContaining(
      cell,
      "after noisy interrupt from MCP peer",
      60_000,
    );
    await expect(output).toContainText("after noisy interrupt from MCP peer");
  });
});
