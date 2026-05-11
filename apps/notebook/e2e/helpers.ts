import { expect, type Locator, type Page } from "@playwright/test";

export async function waitForNotebookReady(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("notebook-toolbar")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-notebook-synced]")).toHaveAttribute(
    "data-notebook-synced",
    "true",
    { timeout: 30_000 },
  );
  await expect(page.locator("[data-session-ready]")).toHaveAttribute("data-session-ready", "true", {
    timeout: 120_000,
  });
}

export async function waitForKernelStatus(page: Page, status: string, timeout = 60_000) {
  await expect(page.getByTestId("kernel-status")).toHaveAttribute("data-kernel-status", status, {
    timeout,
  });
}

export async function ensureCodeCell(page: Page): Promise<Locator> {
  const existing = page.locator('[data-cell-type="code"]').first();
  if ((await existing.count()) > 0) return existing;

  await page.getByTestId("add-code-cell-button").click();
  await expect(existing).toBeVisible({ timeout: 10_000 });
  return existing;
}

export async function setCellSource(cell: Locator, source: string) {
  await cell.locator('.cm-content[contenteditable="true"]').evaluate((node, text) => {
    const content = node as HTMLElement & {
      cmTile?: {
        view?: {
          state: { doc: { length: number } };
          dispatch: (transaction: unknown) => void;
        };
      };
    };
    const editor = content.cmTile?.view;
    if (!editor) throw new Error("No CodeMirror view found");
    editor.dispatch({
      changes: {
        from: 0,
        to: editor.state.doc.length,
        insert: text,
      },
    });
  }, source);
}

export async function executeCell(cell: Locator) {
  await cell.getByTestId("execute-button").click();
}

export async function waitForOutputContaining(cell: Locator, text: string, timeout = 60_000) {
  const output = cell.locator('[data-slot="ansi-stream-output"]');
  await expect(output).toContainText(text, { timeout });
  return output;
}
