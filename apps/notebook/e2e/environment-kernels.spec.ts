import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  executeCell,
  openNotebookPath,
  setCellSource,
  waitForKernelStatus,
  waitForOutputContaining,
  waitForOutputMatching,
} from "./helpers";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const auditFixtureRoot = path.join(repoRoot, "crates", "notebook", "fixtures", "audit-test");

function fixturePath(...segments: string[]) {
  return path.join(auditFixtureRoot, ...segments);
}

function copyFixtureNotebook(...segments: string[]) {
  const source = fixturePath(...segments);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nteract-browser-fixture-"));
  const notebookPath = path.join(dir, path.basename(source));
  fs.copyFileSync(source, notebookPath);
  return { dir, notebookPath };
}

function copyFixtureProject(projectName: string, notebookName: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nteract-${projectName}-`));
  fs.cpSync(fixturePath(projectName), dir, { recursive: true });
  return { dir, notebookPath: path.join(dir, notebookName) };
}

test.describe("browser runtime fixture coverage", () => {
  test.describe.configure({ timeout: 360_000 });

  test("runs a saved Python notebook through the UV-managed runtime", async ({ page }) => {
    const { dir, notebookPath } = copyFixtureNotebook("1-vanilla.ipynb");
    try {
      await openNotebookPath(page, notebookPath, {
        environmentMode: "notebook",
      });
      await waitForKernelStatus(page, "idle", 300_000);

      const depsToggle = page.getByTestId("deps-toggle");
      await expect(depsToggle).toHaveAttribute("data-runtime", "python");
      await expect(depsToggle).toHaveAttribute("data-env-manager", "uv", {
        timeout: 30_000,
      });

      const cell = page.locator('[data-cell-type="code"]').first();
      await setCellSource(cell, "import sys; print('browser-python-ok:' + sys.executable)");
      await executeCell(cell);

      const output = await waitForOutputContaining(cell, "browser-python-ok:", 60_000);
      await expect(output).toContainText(/python/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detects and executes a Deno kernelspec notebook", async ({ page }) => {
    const { dir, notebookPath } = copyFixtureNotebook("10-deno.ipynb");
    try {
      await openNotebookPath(page, notebookPath);
      await waitForKernelStatus(page, "idle", 300_000);

      await expect(page.getByTestId("deps-toggle")).toHaveAttribute("data-runtime", "deno");

      const cell = page.locator('[data-cell-type="code"]').first();
      await setCellSource(cell, 'console.log("browser-deno-ok");');
      await executeCell(cell);

      await waitForOutputContaining(cell, "browser-deno-ok", 60_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses pyproject.toml dependencies for a saved Python notebook", async ({ page }) => {
    const { dir, notebookPath } = copyFixtureProject("pyproject-project", "5-pyproject.ipynb");
    try {
      await openNotebookPath(page, notebookPath, {
        environmentMode: "auto",
      });
      await waitForKernelStatus(page, "idle", 300_000);

      await expect(page.getByTestId("deps-toggle")).toHaveAttribute("data-env-manager", "uv", {
        timeout: 30_000,
      });

      const cell = page.locator('[data-cell-type="code"]').first();
      await setCellSource(cell, "import httpx; print('browser-httpx-ok', httpx.__version__)");
      await executeCell(cell);

      await waitForOutputMatching(cell, /browser-httpx-ok\s+\d+\.\d+/, 120_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
