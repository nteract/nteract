import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForNotebookReady } from "./helpers";

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/basic-permissions.ipynb",
);

function copyFixture(mode: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nteract-permissions-"));
  const notebookPath = path.join(dir, "permissions.ipynb");
  fs.copyFileSync(fixturePath, notebookPath);
  fs.chmodSync(notebookPath, mode);
  return { dir, notebookPath };
}

function cleanupFixture(dir: string) {
  try {
    for (const entry of fs.readdirSync(dir)) {
      fs.chmodSync(path.join(dir, entry), 0o600);
    }
  } catch {
    // Best effort: the assertion failure should stay focused on notebook behavior.
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

test.describe("local file permissions", () => {
  test.skip(process.platform === "win32", "chmod-based file permission checks are POSIX-only");
  test.skip(process.getuid?.() === 0, "root bypasses POSIX file permission checks");

  test("opens a read-only ipynb through viewer capabilities", async ({ page }) => {
    const { dir, notebookPath } = copyFixture(0o444);
    try {
      await waitForNotebookReady(
        page,
        `/?path=${encodeURIComponent(notebookPath)}&environment_mode=notebook`,
      );

      const shell = page.locator('[data-slot="notebook-document-shell"]');
      await expect(shell).toHaveAttribute("data-access-level", "viewer");
      await expect(shell).toHaveAttribute("data-access-source", "local");
      await expect(shell).toHaveAttribute("data-can-edit", "false");
      await expect(shell).toHaveAttribute("data-can-edit-structure", "false");

      await expect(page.getByTestId("add-code-cell-button")).toHaveCount(0);
      await expect(page.getByTestId("add-markdown-cell-button")).toHaveCount(0);
      await expect(page.getByTestId("run-all-button")).toHaveCount(0);
      await expect(page.getByTestId("restart-kernel-button")).toHaveCount(0);

      await expect(page.locator('[data-cell-type="markdown"]')).toContainText("Read-only fixture");
      await expect(page.locator('[data-cell-type="code"] .cm-content')).toHaveAttribute(
        "contenteditable",
        "false",
      );
    } finally {
      cleanupFixture(dir);
    }
  });

  test("reports an inaccessible ipynb without showing writable controls", async ({ page }) => {
    const { dir, notebookPath } = copyFixture(0o000);
    try {
      await page.goto(`/?path=${encodeURIComponent(notebookPath)}&environment_mode=notebook`);
      await expect(page.getByTestId("notebook-toolbar")).toBeVisible({ timeout: 30_000 });

      const shell = page.locator('[data-slot="notebook-document-shell"]');
      await expect(shell).toHaveAttribute("data-access-level", "viewer");
      await expect(shell).toHaveAttribute("data-access-source", "local");
      await expect(shell).toHaveAttribute("data-can-edit", "false");
      await expect(page.getByText("Notebook load failed")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("add-code-cell-button")).toHaveCount(0);
      await expect(page.getByTestId("run-all-button")).toHaveCount(0);
    } finally {
      cleanupFixture(dir);
    }
  });
});
