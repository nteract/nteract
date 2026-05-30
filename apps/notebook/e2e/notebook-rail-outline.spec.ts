import { expect, test } from "@playwright/test";
import {
  openNotebookRoom,
  waitForCellCount,
  waitForCodeCellContaining,
  waitForKernelStatus,
} from "./helpers";
import { McpPeer } from "./mcp-peer";

test.describe("notebook rail outline", () => {
  let mcp: McpPeer | null = null;

  test.afterEach(async () => {
    await mcp?.close();
    mcp = null;
  });

  test("renders nested headings and keeps code cells in their markdown section", async ({
    page,
  }) => {
    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);
    await waitForKernelStatus(page, "idle", 120_000);

    mcp = await McpPeer.start();
    await mcp.connectNotebook(notebookId);
    await mcp.createCell("# Load data\n\nRead raw CSV files.", "markdown");
    await mcp.createCell('print("extract")', "code");
    await mcp.createCell("## Clean columns\n\nTighten types and null handling.", "markdown");
    await mcp.createCell("### Validate ranges\n\nCheck outliers before model fitting.", "markdown");
    await mcp.createCell('print("validate")', "code");
    await waitForCellCount(page, 6);

    await expect(page.getByTestId("notebook-rail")).toHaveAttribute("data-collapsed", "true");
    await page.getByLabel("Outline").click();

    const validateHeading = page.getByRole("link", { name: "Validate ranges" });
    await expect(validateHeading).toBeVisible();
    await expect(page.locator('li[data-outline-level="2"] li[data-outline-level="3"]')).toHaveCount(
      1,
    );

    const validateCell = await waitForCodeCellContaining(page, 'print("validate")');
    await validateCell.scrollIntoViewIfNeeded();
    await validateCell.locator('.cm-content[contenteditable="true"]').click();

    await expect(validateHeading).toHaveAttribute("aria-current", "location");
  });
});
