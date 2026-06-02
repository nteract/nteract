import { expect, test } from "@playwright/test";
import {
  executeCell,
  openNotebookRoom,
  waitForCellCount,
  waitForCodeCellContaining,
  waitForKernelStatus,
  waitForOutputContaining,
} from "./helpers";
import { McpPeer } from "./mcp-peer";

test.describe("browser execution with MCP peer", () => {
  let mcp: McpPeer | null = null;

  test.afterEach(async () => {
    await mcp?.close();
    mcp = null;
  });

  test("executes an MCP-created cell in the browser and shows output", async ({ page }) => {
    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);
    await waitForKernelStatus(page, "idle", 120_000);

    mcp = await McpPeer.start();
    await mcp.connectNotebook(notebookId);
    await mcp.createCell("print('browser executes MCP-created cell')");

    await waitForCellCount(page, 1);
    const cell = await waitForCodeCellContaining(page, "browser executes MCP-created cell");

    await executeCell(cell);
    const output = await waitForOutputContaining(cell, "browser executes MCP-created cell", 60_000);
    await expect(output).toContainText("browser executes MCP-created cell");
  });
});
