import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openNotebookRoom,
  openNotebookPath,
  waitForCellCount,
  waitForCodeCellContaining,
  waitForKernelStatus,
} from "./helpers";
import { McpPeer } from "./mcp-peer";

const outlineFixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/outline-headings.ipynb",
);

function copyOutlineFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nteract-outline-fixture-"));
  const notebookPath = path.join(dir, "outline-headings.ipynb");
  fs.copyFileSync(outlineFixturePath, notebookPath);
  return { dir, notebookPath };
}

function cleanupOutlineFixture(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test.describe("notebook rail outline", () => {
  let mcp: McpPeer | null = null;

  test.afterEach(async () => {
    await mcp?.close();
    mcp = null;
  });

  test("keeps the logo fixed and panel titles level with notebook commands", async ({ page }) => {
    const { dir, notebookPath } = copyOutlineFixture();
    try {
      await page.setViewportSize({ width: 1280, height: 900 });
      await openNotebookPath(page, notebookPath, { environmentMode: "notebook" });
      await waitForCellCount(page, 3);
      const logo = page.getByRole("img", { name: "nteract", exact: true });
      const toolbar = page.getByTestId("notebook-toolbar");
      const initialLogo = await logo.boundingBox();
      expect(initialLogo).not.toBeNull();
      await expect(page.locator('[data-slot="rail-leading-slot"]').getByRole("img")).toBeVisible();
      await expect(toolbar.getByRole("img", { name: "nteract" })).toHaveCount(0);

      for (const panel of ["Outline", "Packages"]) {
        await page.getByRole("button", { name: panel, exact: true }).click();
        await expect(page.getByRole("heading", { name: panel, exact: true })).toBeVisible();
        expect(await logo.boundingBox()).toEqual(initialLogo);
        const headerBox = await page.locator('[data-slot="rail-panel-header"]').boundingBox();
        const toolbarBox = await toolbar.boundingBox();
        expect(headerBox).not.toBeNull();
        expect(toolbarBox).not.toBeNull();
        expect(headerBox!.y).toBe(toolbarBox!.y);
        expect(headerBox!.height).toBe(toolbarBox!.height);
      }

      await page.getByTestId("add-code-cell-button").focus();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(toolbar).toBeHidden();
      await expect(page.getByRole("heading", { name: "Packages", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Packages", exact: true })).toBeFocused();
      await expect(logo).toBeVisible();
      await page.getByRole("button", { name: "Packages", exact: true }).click();
      await expect(toolbar).toBeVisible();

      await page.getByTestId("deps-toggle").click();
      await expect(toolbar).toBeHidden();
      await expect(page.getByRole("button", { name: "Packages", exact: true })).toBeFocused();
    } finally {
      cleanupOutlineFixture(dir);
    }
  });

  test("renders every heading from the outline fixture", async ({ page }) => {
    const { dir, notebookPath } = copyOutlineFixture();
    try {
      await openNotebookPath(page, notebookPath, { environmentMode: "notebook" });
      await waitForCellCount(page, 3);

      await page.getByLabel("Outline").click();
      const outlinePanel = page.getByTestId("notebook-outline-panel");
      for (const heading of [
        "Notebook rail fixture",
        "Data preparation",
        "Normalize records",
        "Review outputs",
        "Visual checks",
      ]) {
        await expect(outlinePanel.getByRole("link", { name: heading, exact: true })).toBeVisible();
      }

      await expect(
        outlinePanel.locator('li[data-outline-level="2"] li[data-outline-level="3"]'),
      ).toHaveCount(2);
    } finally {
      cleanupOutlineFixture(dir);
    }
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

    const outlinePanel = page.getByTestId("notebook-outline-panel");
    const validateHeading = outlinePanel.getByRole("link", {
      name: "Validate ranges",
      exact: true,
    });
    await expect(validateHeading).toBeVisible();
    await expect(page.locator('li[data-outline-level="2"] li[data-outline-level="3"]')).toHaveCount(
      1,
    );

    const validateCell = await waitForCodeCellContaining(page, 'print("validate")');
    await validateCell.scrollIntoViewIfNeeded();
    await validateCell.locator('.cm-content[contenteditable="true"]').click();

    await expect(validateHeading).toHaveAttribute("aria-current", "location");
  });

  test("scrolls to a nested heading inside a projected markdown cell", async ({ page }) => {
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
    await waitForCellCount(page, 2);

    const childHeading = page
      .locator('[data-cell-type="markdown"]')
      .getByRole("heading", { name: "Deep child" });
    await expect(childHeading).toBeAttached();
    const beforeClickY = (await childHeading.boundingBox())?.y ?? Infinity;

    await page.getByLabel("Outline").click();
    await page
      .getByTestId("notebook-outline-panel")
      .getByRole("link", { name: "Deep child", exact: true })
      .click();

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
