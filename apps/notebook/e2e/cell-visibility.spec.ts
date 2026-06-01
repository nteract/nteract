import { expect, test, type Locator } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openNotebookPath } from "./helpers";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturePath = path.join(
  repoRoot,
  "crates",
  "notebook",
  "fixtures",
  "audit-test",
  "14-cell-visibility.ipynb",
);

function copyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nteract-cell-visibility-"));
  const notebookPath = path.join(dir, "cell-visibility.ipynb");
  fs.copyFileSync(fixturePath, notebookPath);
  return { dir, notebookPath };
}

async function focusCell(cell: Locator) {
  const editor = cell.locator('.cm-content[contenteditable="true"]');
  if ((await editor.count()) > 0) {
    await editor.click();
    return;
  }
  await cell.click();
}

async function clickCellButton(cell: Locator, title: string) {
  await focusCell(cell);
  const button = cell.getByRole("button", { name: title });
  await expect(button).toBeVisible({ timeout: 5_000 });
  await button.click();
}

test.describe("cell visibility toggles", () => {
  test("hides and restores source and outputs from an existing notebook", async ({ page }) => {
    const { dir, notebookPath } = copyFixture();
    try {
      await openNotebookPath(page, notebookPath, { environmentMode: "notebook" });

      const cell = page.locator('[data-cell-type="code"]').first();
      await expect(cell.locator('.cm-content[contenteditable="true"]')).toBeVisible();
      await expect(cell.locator('[data-slot="ansi-stream-output"]')).toContainText(
        "visibility test",
      );

      await clickCellButton(cell, "Hide input");
      const showInputButton = cell.locator('button[title="Show input"]').first();
      await expect(showInputButton).toBeVisible();
      await expect(cell.locator('.cm-content[contenteditable="true"]')).toHaveCount(0);

      await showInputButton.click();
      await expect(cell.locator('.cm-content[contenteditable="true"]')).toBeVisible();

      await clickCellButton(cell, "Hide outputs");
      const outputsBadge = cell.locator('button[title="Show outputs"]').first();
      await expect(outputsBadge).toBeVisible();
      await expect(outputsBadge).toContainText("Output hidden");

      await outputsBadge.click();
      await expect(cell.locator('[data-slot="ansi-stream-output"]')).toContainText(
        "visibility test",
      );

      await clickCellButton(cell, "Hide input");
      await clickCellButton(cell, "Hide outputs");
      const hiddenCell = cell.locator('button[title="Show cell"]').first();
      await expect(hiddenCell).toContainText("Cell hidden");
      await expect(cell.locator('.cm-content[contenteditable="true"]')).toHaveCount(0);
      await expect(cell.locator('[data-slot="ansi-stream-output"]')).toHaveCount(0);

      await hiddenCell.click();
      await expect(cell.locator('.cm-content[contenteditable="true"]')).toBeVisible();
      await expect(cell.locator('[data-slot="ansi-stream-output"]')).toContainText(
        "visibility test",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
