import fs from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

// Wall-clock time (ms) at which each test's video effectively began recording,
// keyed by testId. Playwright starts recording at context creation and offers no
// pause/resume, so we capture navigation start here and later write the elapsed
// time to a sidecar file so show-video.mjs can trim the boring load prefix.
const recordingStarts = new Map<string, number>();

function markRecordingStart() {
  recordingStarts.set(test.info().testId, Date.now());
}

/**
 * Low-level primitive: record "the trimmed clip starts *now*." Writes the offset
 * (seconds, relative to navigation start) to `video-trim.txt` in the test's
 * output dir, next to `video.webm`; show-video.mjs seeks past it before the 2x
 * speed-up. Called again later, the latest offset wins.
 *
 * Prefer a named `mark*Ready` helper below: each waits for a specific readiness
 * signal *before* stamping the clip start, so the mark's meaning is verified
 * rather than implied by whatever happened to be awaited on the lines above it.
 * Reach for this raw primitive only for a surface that has no named helper yet.
 */
export async function markClipStart(): Promise<void> {
  const info = test.info();
  const start = recordingStarts.get(info.testId);
  if (start == null) return;
  // Small safety margin so we never cut into the first interaction.
  const offsetSeconds = Math.max(0, (Date.now() - start) / 1000 - 0.25);
  await fs.promises.mkdir(info.outputDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(info.outputDir, "video-trim.txt"),
    offsetSeconds.toFixed(3),
    "utf8",
  );
}

/**
 * Clip starts once the notebook doc is synced and the runtime session is ready —
 * cells render and the toolbar is live, but the kernel may still be launching.
 * Use for flows that edit the document without executing (add/reorder/delete
 * cells, markdown). Asserts `data-notebook-synced` + `data-session-ready`.
 */
export async function markCellsReady(page: Page, timeout = 120_000): Promise<void> {
  await expect(page.locator("[data-notebook-synced]")).toHaveAttribute(
    "data-notebook-synced",
    "true",
    { timeout },
  );
  await expect(page.locator("[data-session-ready]")).toHaveAttribute("data-session-ready", "true", {
    timeout,
  });
  await markClipStart();
}

/**
 * Clip starts once the kernel is idle (launched and ready to execute). Use for
 * flows that run cells. Asserts `data-kernel-status="idle"`.
 */
export async function markKernelReady(page: Page, timeout = 120_000): Promise<void> {
  await waitForKernelStatus(page, "idle", timeout);
  await markClipStart();
}

/**
 * Clip starts once the comments/Discussions panel is mounted and its composer is
 * ready. Use for comment/@ana flows. Requires `enable_comments: true`. Opens the
 * rail if it isn't already open, then asserts the composer textbox is visible.
 */
export async function markCommentsReady(page: Page, timeout = 30_000): Promise<void> {
  const panel = page.getByTestId("notebook-comments-panel");
  if ((await panel.count()) === 0) {
    await page.getByRole("button", { name: "Discussions" }).click();
  }
  await expect(panel.getByRole("textbox", { name: /add a comment/i })).toBeVisible({ timeout });
  await markClipStart();
}

// Monotonic counter per test so unlabeled screenshots still sort in call order.
const screenshotSeq = new Map<string, number>();

/**
 * Capture a full-page screenshot at the current moment for agent inspection.
 *
 * The video (video.webm) records the whole flow for humans; these PNGs are the
 * artifact an agent can actually Read. Drop a `screenshot("label")` call at each
 * point of interest in the flow:
 *
 *   await doA();
 *   await screenshot(page, "01-at-A");
 *   await doB();
 *   await screenshot(page, "02-at-B");
 *
 * Files land in the test's output dir (gitignored test-results/<test>/) as
 * `frame-<label>.png`, so they never collide across worktrees and never commit.
 * The label is sanitized; if omitted, an auto-incrementing index is used.
 * Returns the absolute path so callers can log it.
 */
export async function screenshot(page: Page, label?: string): Promise<string> {
  if (process.env.CI) return "";

  const info = test.info();
  const seq = (screenshotSeq.get(info.testId) ?? 0) + 1;
  screenshotSeq.set(info.testId, seq);
  const index = String(seq).padStart(2, "0");
  const safeLabel = label ? label.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") : "";
  const name = safeLabel ? `frame-${safeLabel}.png` : `frame-${index}.png`;
  await fs.promises.mkdir(info.outputDir, { recursive: true });
  const filePath = path.join(info.outputDir, name);
  await page.screenshot({ path: filePath, fullPage: false });
  await info.attach(safeLabel || `frame-${index}`, { path: filePath, contentType: "image/png" });
  return filePath;
}

export interface ExecutionPerformanceMark {
  name: string;
  t: number;
  traceId: string | null;
  cellId?: string;
  executionId?: string;
  outputId?: string;
  detail?: Record<string, unknown>;
}

export interface ExecutionPerformanceTrace {
  traceId: string;
  cellId: string;
  startedAt: number;
  marks: ExecutionPerformanceMark[];
}

export interface ExecutionPerformanceSnapshot {
  enabled: boolean;
  marks: ExecutionPerformanceMark[];
  traces: ExecutionPerformanceTrace[];
}

export async function waitForNotebookReady(page: Page, path = "/") {
  markRecordingStart();
  await page.goto(path);
  await expect(page.getByTestId("notebook-toolbar")).toBeVisible({ timeout: 30_000 });
  // NotebookView marks sync complete once loading has finished without a load
  // error. Zero-cell notebooks are valid once the host has initialized them.
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

export async function enableExecutionPerformanceTracing(page: Page) {
  await page.addInitScript(() => {
    (
      window as unknown as { __NTERACT_EXECUTION_PERF_ENABLED?: boolean }
    ).__NTERACT_EXECUTION_PERF_ENABLED = true;
  });
}

export async function resetExecutionPerformanceTracing(page: Page) {
  await page.evaluate(() => {
    const api = (
      window as unknown as {
        __nteractExecutionPerf?: {
          enable: () => void;
          reset: () => void;
        };
      }
    ).__nteractExecutionPerf;
    api?.enable();
    api?.reset();
  });
}

export async function markExecutionPerformance(
  page: Page,
  name: string,
  detail?: Record<string, unknown>,
) {
  await page.evaluate(
    ({ markName, markDetail }) => {
      (
        window as unknown as {
          __nteractExecutionPerf?: {
            mark: (name: string, detail?: Record<string, unknown>) => void;
          };
        }
      ).__nteractExecutionPerf?.mark(markName, markDetail);
    },
    { markName: name, markDetail: detail },
  );
}

export async function getExecutionPerformanceSnapshot(
  page: Page,
): Promise<ExecutionPerformanceSnapshot> {
  return await page.evaluate(() => {
    const api = (
      window as unknown as {
        __nteractExecutionPerf?: {
          snapshot: () => ExecutionPerformanceSnapshot;
        };
      }
    ).__nteractExecutionPerf;
    if (!api) {
      return { enabled: false, marks: [], traces: [] };
    }
    return api.snapshot();
  });
}

export async function waitForOutputContaining(cell: Locator, text: string, timeout = 60_000) {
  const output = cell.locator('[data-slot="ansi-stream-output"]').filter({ hasText: text }).first();
  await expect(output).toContainText(text, { timeout });
  return output;
}

export async function waitForOutputMatching(cell: Locator, matcher: RegExp, timeout = 60_000) {
  const output = cell.locator('[data-slot="ansi-stream-output"]');
  await expect
    .poll(
      async () => ((await output.count()) > 0 ? (await output.allInnerTexts()).join("\n") : ""),
      {
        timeout,
      },
    )
    .toMatch(matcher);
  return output;
}
