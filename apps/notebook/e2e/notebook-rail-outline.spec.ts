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
    await waitForCellCount(page, 5);

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

  test("scrolls to a nested heading inside a markdown cell through the iframe bridge", async ({
    page,
  }) => {
    const notebookId = crypto.randomUUID();
    await openNotebookRoom(page, notebookId);
    await waitForKernelStatus(page, "idle", 120_000);

    mcp = await McpPeer.start();
    await mcp.connectNotebook(notebookId);
    await mcp.createCell(
      [
        "# Parent section",
        "",
        ...Array.from({ length: 48 }, (_, index) => `Filler paragraph ${index + 1}.`),
        "",
        "## Deep child",
        "",
        "The outline should land here, not only at the cell top.",
      ].join("\n\n"),
      "markdown",
    );
    await waitForCellCount(page, 1);

    const childHeading = page
      .frameLocator('iframe[data-slot="isolated-frame"][name^="md-"]')
      .getByRole("heading", { name: "Deep child" });
    await expect(childHeading).toBeAttached();
    const beforeClickY = (await childHeading.boundingBox())?.y ?? Infinity;

    await page.getByLabel("Outline").click();
    await page.getByRole("link", { name: "Deep child" }).click();

    await expect
      .poll(async () => page.evaluate(() => window.location.hash))
      .not.toContain("-heading-");

    await expect
      .poll(async () => (await childHeading.boundingBox())?.y ?? Infinity)
      .toBeLessThan(beforeClickY - 400);
    const viewportHeight = page.viewportSize()?.height ?? 720;
    await expect
      .poll(async () => (await childHeading.boundingBox())?.y ?? Infinity)
      .toBeLessThan(viewportHeight - 32);
  });
});
