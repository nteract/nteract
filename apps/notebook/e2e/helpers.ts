import { expect, type Locator, type Page } from "@playwright/test";

export async function waitForNotebookReady(page: Page, path = "/") {
  await page.goto(path);
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

export async function openNotebookRoom(page: Page, notebookId: string) {
  const params = new URLSearchParams({
    notebook_id: notebookId,
    environment_mode: "notebook",
  });
  await waitForNotebookReady(page, `/?${params.toString()}`);
}

export async function openNotebookPath(
  page: Page,
  notebookPath: string,
  options: { environmentMode?: "auto" | "project" | "notebook"; runtime?: string } = {},
) {
  const params = new URLSearchParams({ path: notebookPath });
  if (options.environmentMode) params.set("environment_mode", options.environmentMode);
  if (options.runtime) params.set("runtime", options.runtime);
  await waitForNotebookReady(page, `/?${params.toString()}`);
}

export async function waitForKernelStatus(page: Page, status: string, timeout = 60_000) {
  await expect(page.getByTestId("kernel-status")).toHaveAttribute("data-kernel-status", status, {
    timeout,
  });
}

export async function waitForCellCount(page: Page, count: number, timeout = 30_000) {
  await expect(page.locator("[data-cell-type]")).toHaveCount(count, { timeout });
}

export async function ensureCodeCell(page: Page): Promise<Locator> {
  const existing = page.locator('[data-cell-type="code"]').first();
  if ((await existing.count()) > 0) return existing;

  await page.getByTestId("add-code-cell-button").click();
  await expect(existing).toBeVisible({ timeout: 10_000 });
  return existing;
}

export async function ensureMarkdownCell(page: Page): Promise<Locator> {
  const existing = page.locator('[data-cell-type="markdown"]').first();
  if ((await existing.count()) > 0) return existing;

  await page.getByTestId("add-markdown-cell-button").click();
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
          focus: () => void;
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
      selection: { anchor: text.length },
    });
    editor.focus();
  }, source);
}

export async function getCellSource(cell: Locator): Promise<string> {
  return await cell.locator('.cm-content[contenteditable="true"]').evaluate((node) => {
    const content = node as HTMLElement & {
      cmTile?: {
        view?: {
          state: { doc: { toString: () => string } };
        };
      };
    };
    const editor = content.cmTile?.view;
    if (!editor) throw new Error("No CodeMirror view found");
    return editor.state.doc.toString();
  });
}

export async function waitForCellSourceContaining(cell: Locator, text: string, timeout = 30_000) {
  await expect.poll(() => getCellSource(cell), { timeout }).toContain(text);
}

export async function waitForCodeCellContaining(page: Page, text: string, timeout = 30_000) {
  const cells = page.locator('[data-cell-type="code"]');
  const findIndex = async () => {
    const count = await cells.count();
    for (let i = 0; i < count; i += 1) {
      const source = await getCellSource(cells.nth(i));
      if (source.includes(text)) return i;
    }
    return -1;
  };

  await expect.poll(findIndex, { timeout }).not.toBe(-1);
  const index = await findIndex();
  if (index < 0) throw new Error(`No code cell contains: ${text}`);
  return cells.nth(index);
}

export async function executeCell(cell: Locator) {
  await cell.getByTestId("execute-button").click();
}

export async function waitForOutputContaining(cell: Locator, text: string, timeout = 60_000) {
  const output = cell.locator('[data-slot="ansi-stream-output"]');
  await expect(output).toContainText(text, { timeout });
  return output;
}

export async function waitForOutputMatching(cell: Locator, matcher: RegExp, timeout = 60_000) {
  const output = cell.locator('[data-slot="ansi-stream-output"]');
  await expect
    .poll(async () => ((await output.count()) > 0 ? output.innerText() : ""), {
      timeout,
    })
    .toMatch(matcher);
  return output;
}
