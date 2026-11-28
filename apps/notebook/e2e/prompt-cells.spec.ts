import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCellSource, openNotebookRoom, setCellSource, waitForKernelStatus } from "./helpers";

/**
 * Prompt cells end to end: a prompt cell runs through the prompt agent, a
 * streaming placeholder appears below it and becomes ordinary answer cells.
 *
 * The daemon reads `prompt_cells` and `prompt_agent_command` from its
 * settings.json, which the spec writes and restores: `NTERACT_PROMPT_E2E_SETTINGS_JSON`
 * or the nightly config file. The real-CLI case is opt-in (`NTERACT_PROMPT_E2E_REAL_CLAUDE=1`).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.resolve(here, "../../../crates/runtimed/tests/fixtures/fake-claude.sh");
const SETTINGS_PATH =
  process.env.NTERACT_PROMPT_E2E_SETTINGS_JSON ??
  path.join(os.homedir(), ".config", "nteract-nightly", "settings.json");
const REAL_CLAUDE = ["1", "true", "yes"].includes(
  String(process.env.NTERACT_PROMPT_E2E_REAL_CLAUDE ?? "").toLowerCase(),
);

let originalSettings: string | null = null;

function writePromptSettings(agentCommand: string) {
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(originalSettings ?? "{}") as Record<string, unknown>;
  } catch {
    current = {};
  }
  const next = { ...current, prompt_cells: true, prompt_agent_command: agentCommand };
  fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`);
}

/** Prompt cells render as `data-cell-type="ai"` (a raw cell carrying `nteract.prompt`). */
function promptCells(page: Page): Locator {
  return page.locator('[data-slot="cell-container"][data-cell-type="ai"]');
}

/** Cell wrapper (label row + cell) of every answer cell, in document order. */
function answerCells(page: Page): Locator {
  return page
    .locator("[data-cell-command-focus]")
    .filter({ has: page.locator('[data-slot="prompt-answer-label"]') });
}

/** The browser dev host keeps its settings in memory, so the UI flag is seeded here. */
async function seedBrowserPromptFlag(page: Page) {
  await page.addInitScript(() => {
    (
      globalThis as { __NTERACT_BROWSER_HOST_SETTINGS__?: unknown }
    ).__NTERACT_BROWSER_HOST_SETTINGS__ = { prompt_cells: true };
  });
}

async function addPromptCellViaRibbon(page: Page) {
  // The terminal ribbon below the last cell holds the Prompt button once the
  // setting has synced. Its buttons are in the DOM but hidden until hover, so
  // use an attribute locator (getByRole skips them).
  const button = page.locator('button[aria-label="Add prompt cell"]').last();
  await expect(button).toBeAttached({ timeout: 60_000 });
  // Open the ribbon with a real pointer move: it reveals on hover.
  await page.locator("[data-cell-type]").last().hover();
  const box = await button.boundingBox();
  if (!box) throw new Error("Prompt button has no layout box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await button.click();
  await expect(promptCells(page)).toHaveCount(1, { timeout: 15_000 });
}

/** Writes the settings, opens a fresh notebook and adds a prompt cell with `text`. */
async function setupPromptNotebook(page: Page, agentCommand: string, text: string) {
  writePromptSettings(agentCommand);
  await seedBrowserPromptFlag(page);
  await openNotebookRoom(page, crypto.randomUUID());
  await waitForKernelStatus(page, "idle", 120_000);
  await addPromptCellViaRibbon(page);
  const prompt = promptCells(page).first();
  const header = prompt.locator('[data-slot="prompt-cell-header"]');
  await expect(header).toHaveAttribute("data-prompt-status", "idle");
  await setCellSource(prompt, text);
  return { prompt, header };
}

/** Ids of the answer cells, in visual order. */
async function answers(page: Page): Promise<string[]> {
  return (await answerInfos(page)).map((c) => c.id);
}

interface AnswerInfo {
  id: string;
  type: string | null;
  text: string;
  labelled: boolean;
}

/**
 * Answer cells in visual (top to bottom) order. NotebookView keeps the DOM order
 * stable and positions cells with CSS, so DOM order is not document order.
 */
async function answerInfos(page: Page): Promise<AnswerInfo[]> {
  const infos = await answerCells(page).evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const cell = node.querySelector("[data-cell-type]");
        const editor = cell?.querySelector(".cm-content");
        return {
          top: node.getBoundingClientRect().top,
          id: node.getAttribute("data-cell-command-focus") ?? "",
          type: cell?.getAttribute("data-cell-type") ?? null,
          text:
            (editor as HTMLElement | null)?.innerText ??
            (cell as HTMLElement | null)?.innerText ??
            "",
          labelled: /answer to/.test(
            (node.querySelector('[data-slot="prompt-answer-label"]') as HTMLElement | null)
              ?.innerText ?? "",
          ),
        };
      })
      .sort((x, y) => x.top - y.top),
  );
  return infos.map(({ top: _top, ...rest }) => rest);
}

async function assertThreeAnswerCells(page: Page, timeout: number) {
  await expect
    .poll(
      async () => {
        const cells = await answerInfos(page);
        return cells.map((c) => c.type);
      },
      { timeout },
    )
    .toEqual(["markdown", "code", "markdown"]);
  await expect
    .poll(async () => (await answerInfos(page)).map((c) => c.text.trim()), { timeout: 15_000 })
    .toEqual([
      expect.stringContaining("Here is code:"),
      "print(42)",
      expect.stringContaining("Done."),
    ]);
  expect((await answerInfos(page)).every((c) => c.labelled)).toBe(true);
  // Nothing streaming is left behind.
  await expect(page.getByTestId("prompt-answer-stream")).toHaveCount(0);
}

test.describe("prompt cells", () => {
  test.beforeAll(() => {
    try {
      originalSettings = fs.readFileSync(SETTINGS_PATH, "utf8");
    } catch {
      originalSettings = null;
    }
  });

  test.afterAll(() => {
    if (originalSettings === null) {
      fs.rmSync(SETTINGS_PATH, { force: true });
    } else {
      fs.writeFileSync(SETTINGS_PATH, originalSettings);
    }
  });

  test("runs a prompt through the fake agent and replaces answers on re-run", async ({ page }) => {
    const { prompt, header } = await setupPromptNotebook(
      page,
      FAKE_CLAUDE,
      "Write a tiny python snippet that prints 42.",
    );
    // The fake agent answers within a few hundred ms, so the waiting/running
    // header states are too short-lived to assert on. Shift+Enter runs the
    // prompt and keeps the cursor in it (no jump into the answer below).
    await prompt.locator(".cm-content").click();
    await page.keyboard.press("Shift+Enter");
    await expect(prompt.locator(".cm-editor.cm-focused")).toHaveCount(1);

    await assertThreeAnswerCells(page, 60_000);
    await expect(header).toHaveAttribute("data-prompt-status", "idle", { timeout: 30_000 });
    await expect(prompt.getByTestId("prompt-error")).toHaveCount(0);
    await expect(prompt.getByTestId("prompt-outcome")).toHaveCount(0);
    // The prompt never ran on the kernel: it is still idle and the notebook's
    // code cell has no output.
    await waitForKernelStatus(page, "idle", 10_000);
    await expect(
      page.locator('[data-cell-type="code"] [data-slot="ansi-stream-output"]'),
    ).toHaveCount(0);

    // Re-run: previous answers are deleted and replaced, still three cells.
    const firstAnswerIds = await answers(page);
    await prompt.getByTestId("execute-button").click();
    await expect
      .poll(
        async () => {
          const ids = await answers(page);
          return ids.length === 3 && ids.every((id) => !firstAnswerIds.includes(id));
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    await assertThreeAnswerCells(page, 30_000);
    await expect(header).toHaveAttribute("data-prompt-status", "idle", { timeout: 30_000 });
    await expect(prompt.getByTestId("prompt-error")).toHaveCount(0);
    await expect(promptCells(page)).toHaveCount(1);
  });

  test("answers with the real claude CLI", async ({ page }) => {
    test.skip(
      !REAL_CLAUDE,
      "set NTERACT_PROMPT_E2E_REAL_CLAUDE=1 to run against the real claude CLI",
    );
    test.setTimeout(5 * 60_000);
    const { prompt, header } = await setupPromptNotebook(
      page,
      "claude",
      "Write a code cell that prints 42.",
    );
    await prompt.getByTestId("execute-button").click();
    await expect(header).toHaveAttribute("data-prompt-status", "idle", { timeout: 180_000 });

    await expect(prompt.getByTestId("prompt-error")).toHaveCount(0);
    expect(await answerCells(page).count()).toBeGreaterThanOrEqual(1);
    await expect(page.getByTestId("prompt-answer-stream")).toHaveCount(0);
    // At least one answer cell is a code cell that prints 42.
    const codeAnswers = answerCells(page).locator('[data-cell-type="code"]');
    await expect(codeAnswers.first()).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => getCellSource(codeAnswers.first())).toContain("42");
    await expect(
      answerCells(page).first().locator('[data-slot="prompt-answer-label"]'),
    ).toContainText("answer to");
  });
});
