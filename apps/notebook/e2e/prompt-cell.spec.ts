import { expect, test } from "@playwright/test";
import {
  ensureCodeCell,
  openNotebookRoom,
  setCellSource,
  waitForCellCount,
  waitForNotebookSessionReady,
} from "./helpers";

test.describe("prompt cells", () => {
  test("adds a prompt cell and keeps its mode and context flags across reloads", async ({
    page,
  }) => {
    await openNotebookRoom(page, crypto.randomUUID());
    const code = await ensureCodeCell(page);
    await setCellSource(code, "x = 1");

    const adder = page.locator('[data-slot="cell-adder"]').last();
    await adder.hover();
    await adder.getByTitle("Add prompt cell").click();
    await waitForCellCount(page, 2);

    const prompt = page.locator('[data-cell-type="ai"]');
    await expect(prompt).toHaveCount(1);
    await expect(prompt.getByRole("button", { name: "Explore" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await prompt.getByRole("button", { name: "Full" }).click();
    await code.hover();
    await code.getByTestId("cell-context-toggle").click();

    await expect(prompt.getByRole("button", { name: "Full" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(code.getByTestId("cell-context-toggle")).toHaveAttribute(
      "data-context-excluded",
      "true",
    );

    await page.reload();
    await waitForNotebookSessionReady(page);

    await expect(
      page.locator('[data-cell-type="ai"]').getByRole("button", { name: "Full" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.locator('[data-cell-type="code"]').first().getByTestId("cell-context-toggle"),
    ).toHaveAttribute("data-context-excluded", "true");
  });

  test("the context icon on a heading excludes its whole section", async ({ page }) => {
    await openNotebookRoom(page, crypto.randomUUID());
    const code = await ensureCodeCell(page);
    await setCellSource(code, "y = 2");

    const firstAdder = page.locator('[data-slot="cell-adder"]').first();
    await firstAdder.hover();
    await firstAdder.getByTitle("Add markdown cell").click();
    await waitForCellCount(page, 2);
    const heading = page.locator('[data-cell-type="markdown"]').first();
    await setCellSource(heading, "## Setup");

    await heading.hover();
    await heading.getByTestId("cell-context-toggle").click();

    await expect(heading.getByTestId("cell-context-toggle")).toHaveAttribute(
      "data-context-excluded",
      "true",
    );
    await expect(code.getByTestId("cell-context-toggle")).toHaveAttribute(
      "data-context-excluded",
      "true",
    );
  });
});
