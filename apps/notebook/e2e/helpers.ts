import fs from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page, test, type TestInfo } from "@playwright/test";

// Wall-clock time (ms) at which each test's video effectively began recording,
// keyed by testId. Playwright starts recording at context creation and offers no
// pause/resume, so we capture navigation start here and later write the elapsed
// time to a sidecar file so show-video.mjs can trim the boring load prefix.
const recordingStarts = new Map<string, number>();

// Recording mode (NTERACT_E2E_RECORD=1) turns on the video viewport/zoom in
// playwright.config.ts plus pacing pauses and screenshot capture below, so a
// normal suite run produces no video, no PNGs, and no pacing delay.
const recording = /^(1|true|yes|on)$/i.test(process.env.NTERACT_E2E_RECORD ?? "");

function markRecordingStart() {
  recordingStarts.set(test.info().testId, Date.now());
}

// Counterpart to the 1200x800 recording viewport set in playwright.config.ts:
// zoom the UI 2x so the video frames the same content a compact 600x400 window
// would, at full retina density. Playwright's recorder ignores
// deviceScaleFactor, so CSS zoom is the only way to record above 1x.
async function applyVideoZoom(page: Page) {
  await page.addInitScript(() => {
    const applyZoom = () => {
      document.documentElement.style.setProperty("zoom", "2");
    };
    if (document.documentElement) applyZoom();
    else document.addEventListener("DOMContentLoaded", applyZoom);
  });
}

function slug(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Where show-video.mjs should archive this test's clip, as path segments:
 * spec file, then each describe/test title. Playwright's own output dir flattens
 * all of this into one dash-joined string, which is unreadable when a describe
 * restates the filename ("add-cell-add-cell-..."); nesting keeps the structure
 * and groups a spec's before/after clips in one folder.
 */
function archiveSegments(info: TestInfo) {
  const specFile = path.basename(info.file);
  const spec = specFile.replace(/\.spec\.[jt]s$/, "");
  // titlePath leads with the spec filename (and, per the docs, possibly the
  // project name) before the describe/test titles. Drop those by identity rather
  // than by a fixed count, so we neither keep a duplicate nor eat a real title.
  const titles = info.titlePath.filter((part) => part !== specFile && part !== info.project.name);
  return [spec, ...titles].map(slug).filter(Boolean);
}

/**
 * Low-level primitive: record "the trimmed clip starts *now*." Writes the trim
 * offset (seconds, relative to navigation start) plus the archive path to
 * `video-meta.json` in the test's output dir, next to `video.webm`;
 * show-video.mjs seeks past the offset before the 2x speed-up. Called again
 * later, the latest offset wins. A no-op when not recording.
 *
 * Prefer a named `mark*Ready` helper below: each waits for a specific readiness
 * signal *before* stamping the clip start, so the mark's meaning is verified
 * rather than implied by whatever happened to be awaited on the lines above it.
 * Reach for this raw primitive only for a surface that has no named helper yet.
 */
export async function markClipStart(): Promise<void> {
  if (!recording) return;

  const info = test.info();
  const start = recordingStarts.get(info.testId);
  if (start == null) {
    console.warn(
      "markClipStart: no recording start for this test — navigate via " +
        "openNotebookRoom/openNotebookPath/waitForNotebookReady. Video will not be trimmed.",
    );
    return;
  }
  // Small safety margin so we never cut into the first interaction.
  const trimSeconds = Math.max(0, (Date.now() - start) / 1000 - 0.25);
  await fs.promises.mkdir(info.outputDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(info.outputDir, "video-meta.json"),
    JSON.stringify(
      { trimSeconds: Number(trimSeconds.toFixed(3)), segments: archiveSegments(info) },
      null,
      2,
    ),
    "utf8",
  );
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
 * Sleep only while recording, to pace the video (let a state be readable before
 * the next interaction). A no-op otherwise, so pacing never slows real runs.
 */
export async function pauseForVideo(page: Page, ms = 1_000): Promise<void> {
  if (!recording) return;
  await page.waitForTimeout(ms);
}

// Monotonic counter per test so unlabeled screenshots still sort in call order.
const screenshotSeq = new Map<string, number>();

/**
 * Capture a screenshot at the current moment for agent inspection. Only writes
 * in recording mode (NTERACT_E2E_RECORD=1) — a normal suite run produces no
 * PNGs, so specs can keep their marks without every run littering artifacts.
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
 * Returns the absolute path, or "" when not recording.
 */
export async function screenshot(page: Page, label?: string): Promise<string> {
  if (!recording) return "";

  const info = test.info();
  const seq = (screenshotSeq.get(info.testId) ?? 0) + 1;
  screenshotSeq.set(info.testId, seq);
  const index = String(seq).padStart(2, "0");
  const safeLabel = label ? label.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") : "";
  const name = `frame-${index}${safeLabel ? `-${safeLabel}` : ""}.png`;
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
  if (recording) await applyVideoZoom(page);
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
