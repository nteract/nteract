import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

/**
 * Sift's data worker under Kilo Desktop's real renderer policy: the custom
 * `harness://` scheme, KD's two CSP strings, and revision-pinned ranged reads
 * over IPC. Each test launches the built app (`dist/`) with its own flags.
 */

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = path.join(appDir, ".cache");
const SMALL = path.join(cacheDir, "small.parquet");
const BIG = path.join(cacheDir, "big.parquet");
const BIG_ROWS = 98_304;
const MiB = 1024 * 1024;

const UV = ["/opt/homebrew/bin/uv", "uv"].find(
  (candidate) => spawnSync(candidate, ["--version"]).status === 0,
);

test.beforeAll(() => {
  if (existsSync(SMALL) && existsSync(BIG)) return;
  test.skip(!UV, "uv is not installed; the e2e generates its Parquet fixtures with uv + pyarrow");
  const result = spawnSync(
    UV!,
    [
      "run",
      "--no-project",
      "--with",
      "pyarrow",
      "python",
      "e2e/fixtures/make-parquet.py",
      cacheDir,
    ],
    { cwd: appDir, stdio: "inherit" },
  );
  expect(result.status, "fixture generation").toBe(0);
});

type Harness = {
  app: ElectronApplication;
  page: Page;
  /** Renderer and worker console lines, as `type: text`. */
  console: string[];
  pageErrors: string[];
};

let current: Harness | null = null;

async function launch(file: string, flags: Record<string, string | number> = {}): Promise<Harness> {
  const args = [appDir, file, ...Object.entries(flags).map(([k, v]) => `--${k}=${v}`)];
  const app = await electron.launch({ args });
  const consoleLines: string[] = [];
  const pageErrors: string[] = [];
  const attach = (page: Page) => {
    page.on("console", (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) => pageErrors.push(error.message));
  };
  app.on("window", attach);
  const page = await app.firstWindow();
  attach(page);
  await page.waitForFunction(() => (window as any).__harness !== undefined);
  current = { app, page, console: consoleLines, pageErrors };
  return current;
}

test.afterEach(async () => {
  await current?.app.close();
  current = null;
});

/** A snapshot of the renderer's `window.__harness`, read in the test process. */
async function harnessState<T>(page: Page, read: (h: Record<string, any>) => T): Promise<T> {
  return read(await page.evaluate(() => (window as any).__harness));
}

async function milestones(page: Page): Promise<{ phase: string; [key: string]: unknown }[]> {
  return harnessState(page, (h) => h.milestones);
}

async function waitForMilestone(page: Page, phase: string, timeout = 30_000) {
  await expect
    .poll(async () => (await milestones(page)).map((m) => m.phase), { timeout })
    .toContain(phase);
}

// Released pooled rows are hidden, not cleared, so only shown rows count.
async function settled(page: Page) {
  await expect(page.locator(".sift-table-container")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".sift-row:visible .sift-cell-skeleton")).toHaveCount(0);
}

const CSP_NOISE = /Content.Security.Policy|worker-src|Refused/i;

async function expectNoCspComplaints(h: Harness) {
  const complaints = h.console.filter(
    (line) => /^(error|warning):/.test(line) && CSP_NOISE.test(line),
  );
  expect(complaints).toEqual([]);
  expect(h.pageErrors).toEqual([]);
  expect(await harnessState(h.page, (s) => s.cspViolations)).toEqual([]);
  expect(await harnessState(h.page, (s) => s.workerErrors)).toEqual([]);
}

async function expectWorkerTableMounts(h: Harness, origin: string) {
  const { page } = h;
  await expect(page.getByTestId("origin")).toHaveText(origin);
  await page.waitForSelector(".sift-table-container");
  await expect(page.locator(".sift-stat-rows")).toHaveAttribute("data-value", "4 rows", {
    timeout: 30_000,
  });
  await waitForMilestone(page, "engine-mounted");
  await settled(page);
  await expect(page.locator(".sift-row").first().locator(".sift-cell").first()).toHaveText("1");
  await expect(page.getByTestId("worker-state")).toHaveText("spawned");
  const phases = (await milestones(page)).map((m) => m.phase);
  expect(phases).toContain("wasm-ready");
  expect(phases).toContain("streaming-complete");
  // The scheme serves the binary with the exact type streaming compilation needs.
  const wasmType = await page.evaluate(async () => {
    const response = await fetch((window as any).__harness.wasmUrl);
    return response.headers.get("content-type");
  });
  expect(wasmType).toBe("application/wasm");
}

test("1. module worker loads under the app-origin CSP (no worker-src)", async () => {
  const h = await launch(SMALL, { worker: 1 });
  await expectWorkerTableMounts(h, "harness://app");
  await expectNoCspComplaints(h);
});

test("2. a blob: worker is refused under the app-origin CSP", async () => {
  const h = await launch(SMALL, { worker: 1 });
  await waitForMilestone(h.page, "engine-mounted");
  // Chromium does not throw from the constructor: it blocks the script load,
  // reports a `worker-src` violation (falling back to `script-src`), and
  // fires `error` on the Worker.
  const outcome = await h.page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        let worker: Worker;
        try {
          worker = new Worker(
            URL.createObjectURL(new Blob(["postMessage('ran')"], { type: "text/javascript" })),
          );
        } catch (error) {
          resolve(`threw ${(error as DOMException).name}`);
          return;
        }
        worker.onmessage = () => resolve("ran");
        worker.onerror = () => resolve("error event");
        setTimeout(() => resolve("timeout"), 5_000);
      }),
  );
  expect(["error event", "threw SecurityError"]).toContain(outcome);
  expect(await harnessState(h.page, (s) => s.cspViolations)).toEqual(["worker-src blob"]);
  expect(h.console).toContainEqual(
    expect.stringMatching(
      /^error: Creating a worker from 'blob:harness:\/\/app\/.*' violates .*"script-src 'self' 'wasm-unsafe-eval'"/,
    ),
  );
  await h.app.close();

  // The same refusal through Sift's factory: a blob shim that imports the
  // real worker bundle. The constructor returns, the worker never runs, and
  // Sift reports a dead worker in its error state, not "Worker factory threw".
  const blob = await launch(SMALL, { worker: 1, spawn: "blob" });
  await expect(blob.page.locator('[role="alert"]')).toContainText(
    "Sift worker terminated: Sift worker crashed",
    { timeout: 30_000 },
  );
  await expect(blob.page.getByTestId("worker-state")).toHaveText("terminated");
  expect(await harnessState(blob.page, (s) => s.cspViolations)).toEqual(["worker-src blob"]);
  expect(blob.pageErrors).toEqual([]);
});

test("3. embedded origin: module worker loads and blob: workers are allowed", async () => {
  const h = await launch(SMALL, { worker: 1, origin: "embedded" });
  await expectWorkerTableMounts(h, "harness://embedded");
  await expectNoCspComplaints(h);
  const echoed = await h.page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const url = URL.createObjectURL(
          new Blob(["postMessage('blob worker ok')"], { type: "text/javascript" }),
        );
        const worker = new Worker(url);
        worker.onmessage = (event) => {
          worker.terminate();
          resolve(String(event.data));
        };
        worker.onerror = (event) => reject(new Error(event.message || "blob worker error"));
      }),
  );
  expect(echoed).toBe("blob worker ok");
  await h.app.close();

  // Sift through a blob shim that imports the worker bundle: allowed here.
  const blob = await launch(SMALL, { worker: 1, origin: "embedded", spawn: "blob" });
  await expectWorkerTableMounts(blob, "harness://embedded");
  await expectNoCspComplaints(blob);
});

type AnchorSample = {
  frames: number;
  /** `aria-rowindex` of the row under the header's bottom edge, per frame. */
  topRows: number[];
  scrollTops: number[];
  /** Frame on which `phase` first appeared in the milestones; -1 if never. */
  sawPhaseAt: number;
};

/**
 * Scroll to `fromEnd` px above the bottom, then sample every frame until a
 * final `streaming-complete` (or 30 s): the top visible row, `scrollTop`, and
 * when `phase` first appears.
 */
function sampleAnchorWhileStreaming(page: Page, phase: string, fromEnd: number) {
  return page.evaluate(
    ({ phase, fromEnd }) =>
      new Promise<AnchorSample>((resolve) => {
        const viewport = document.querySelector<HTMLElement>(".sift-viewport")!;
        const h = (window as any).__harness;
        const header = document.querySelector<HTMLElement>(".sift-header")!.offsetHeight;
        viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight - fromEnd;
        const start = performance.now();
        const sample: AnchorSample = { frames: 0, topRows: [], scrollTops: [], sawPhaseAt: -1 };
        const tick = () => {
          sample.frames++;
          if (sample.sawPhaseAt < 0 && h.milestones.some((m: any) => m.phase === phase)) {
            sample.sawPhaseAt = sample.frames;
          }
          const vp = viewport.getBoundingClientRect();
          const visible = [...document.querySelectorAll<HTMLElement>(".sift-row")].filter((row) => {
            if (row.style.display === "none") return false;
            const r = row.getBoundingClientRect();
            return r.bottom > vp.top + header && r.top < vp.bottom;
          });
          if (visible.length > 0) {
            const top = visible.reduce((best, row) =>
              row.getBoundingClientRect().top < best.getBoundingClientRect().top ? row : best,
            );
            sample.topRows.push(Number(top.getAttribute("aria-rowindex")));
            sample.scrollTops.push(Math.round(viewport.scrollTop));
          }
          const done = h.milestones.some(
            (m: any) => m.phase === "streaming-complete" && m.resumable !== true,
          );
          if (!done && performance.now() - start < 30_000) requestAnimationFrame(tick);
          else resolve(sample);
        };
        requestAnimationFrame(tick);
      }),
    { phase, fromEnd },
  );
}

const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

test("4. autoLoad scroll: pauses at 64 MiB, resumes near the end without a scroll jump", async () => {
  // The worker loads to the hard budget and ignores autoLoad, so the pause and
  // resume run on the main-thread loader over the same ranged IPC source.
  const h = await launch(BIG, { worker: 0, autoLoad: "scroll" });
  const { page } = h;
  await page.waitForSelector(".sift-table-container");
  const paused = page.locator(".sift-preview-hint", { hasText: "Showing first" });
  await expect(paused).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".sift-load-more")).toHaveText("Load more");
  const pause = (await milestones(page)).find(
    (m) => m.phase === "streaming-complete" && m.resumable === true,
  );
  expect(pause, "a resumable streaming-complete milestone").toBeTruthy();
  const firstStop = Number(pause!.rowCount);
  expect(firstStop).toBeGreaterThan(0);
  expect(firstStop).toBeLessThan(BIG_ROWS);
  expect(pause!.totalRowCount).toBe(BIG_ROWS);
  await expect(paused).toContainText(
    `Showing first ${firstStop.toLocaleString("en-US")} of ${BIG_ROWS.toLocaleString("en-US")} rows`,
  );
  expect(Number(await page.getByTestId("loaded-count").textContent())).toBe(firstStop);
  // Resident data (no worker): no placeholders, no aria-busy.
  await expect(page.locator(".sift-row").first().locator(".sift-cell").first()).toHaveText("1");

  // Scroll to the last loaded rows; the resumed row groups append below.
  const resident = await sampleAnchorWhileStreaming(page, "streaming-resumed", 200);
  expect(resident.sawPhaseAt, "streaming-resumed after scrolling near the end").toBeGreaterThan(0);
  expect(resident.topRows.length).toBeGreaterThan(0);
  expect(spread(resident.scrollTops), "scrollTop during resumed appends").toBe(0);
  await expect(page.getByTestId("loaded-count")).toHaveText(String(BIG_ROWS), { timeout: 30_000 });
  await expect(page.locator(".sift-stat-rows")).toHaveAttribute("data-value", "98,304 rows");
  await expect(paused).toHaveCount(0);
  expect(h.pageErrors).toEqual([]);
  // Resident appends hold scrollTop but not the anchor row: the row-height
  // estimate for unmeasured rows above moves with each append. Recorded, not
  // asserted; the anchor contract is the windowed one, checked below.
  test.info().annotations.push({
    type: "resident anchor drift (rows)",
    description: String(spread(resident.topRows)),
  });
  await h.app.close();

  // The same scroll while the worker (windowed) streams: the anchor row holds.
  const w = await launch(BIG, { worker: 1, autoLoad: "off", readDelayMs: 40 });
  await expect
    .poll(
      async () => (await milestones(w.page)).filter((m) => m.phase === "chunk-appended").length,
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(20);
  const windowed = await sampleAnchorWhileStreaming(w.page, "chunk-appended", 200);
  expect(windowed.topRows.length).toBeGreaterThan(30);
  // The row at the top of the viewport stays put (±1 for a partially shown row).
  expect(spread(windowed.topRows), "anchor row during worker appends").toBeLessThanOrEqual(1);
  await expect(w.page.getByTestId("loaded-count")).toHaveText(String(BIG_ROWS), {
    timeout: 30_000,
  });
  expect(w.pageErrors).toEqual([]);
});

test("5. a tiny allocation cap traps the worker and keeps painted rows", async () => {
  const h = await launch(BIG, { worker: 1, cap: 8_000_000 });
  const { page } = h;
  await page.waitForSelector(".sift-table-container");
  await expect(page.locator(".sift-load-failure")).toHaveText(
    /^Stopped loading: row group \d+ exceeded the worker memory limit .* · Showing loaded rows$/,
    { timeout: 60_000 },
  );
  await expect(page.getByTestId("worker-state")).toHaveText("terminated");
  await expect(page.getByTestId("data-failed")).toHaveText("true");
  expect(await harnessState(page, (s) => s.state?.dataFailed)).toBe(true);
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  const loaded = Number(await page.getByTestId("loaded-count").textContent());
  expect(loaded).toBeGreaterThan(0);
  expect(loaded).toBeLessThan(BIG_ROWS);
  await settled(page);
  await expect(page.locator(".sift-row").first().locator(".sift-cell").first()).toHaveText("1");
  const errors = await harnessState(page, (s) => s.errors);
  expect(errors).toEqual([expect.stringMatching(/exceeded the worker memory limit/)]);
  expect(h.pageErrors).toEqual([]);
});

test("6. a file touched mid-load is a ranged-read conflict; loaded rows stay", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sift-harness-"));
  const file = path.join(dir, "touched.parquet");
  copyFileSync(BIG, file);
  try {
    // 40 ms per IPC read keeps the 96 row groups loading for several seconds.
    const h = await launch(file, { worker: 1, autoLoad: "off", readDelayMs: 40 });
    const { page } = h;
    await waitForMilestone(page, "engine-mounted");
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    await expect(page.locator(".sift-load-failure")).toContainText(
      "The file changed on disk while the table was loading.",
      { timeout: 30_000 },
    );
    await expect(page.locator(".sift-load-failure")).toHaveText(/ · Showing loaded rows$/);
    expect(await harnessState(page, (s) => s.stale)).toBe(true);
    // Not a trap: the worker stays up and the loaded rows keep their tools.
    await expect(page.getByTestId("worker-state")).toHaveText("spawned");
    await expect(page.getByTestId("data-failed")).toHaveText("false");
    const loaded = Number(await page.getByTestId("loaded-count").textContent());
    expect(loaded).toBeGreaterThan(0);
    expect(loaded).toBeLessThan(BIG_ROWS);
    await settled(page);
    await expect(page.locator(".sift-row").first().locator(".sift-cell").first()).toHaveText("1");
    expect(h.pageErrors).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Not one of the six checks: measures worker heap against `allocationCap` on
 * the big fixture with a 64 MiB decoded budget. `HARNESS_MEASURE=1` to run.
 */
test("measure: allocationCap headroom at 64 MiB decoded", async () => {
  test.skip(!process.env.HARNESS_MEASURE, "set HARNESS_MEASURE=1 to measure");
  test.setTimeout(600_000);
  const budget = 64 * MiB;
  const rows: string[] = [];
  for (const factor of [4, 3, 2.5, 2.25, 2, 1.5, 1.0]) {
    const cap = Math.round(budget * factor);
    const h = await launch(BIG, { worker: 1, maxDecoded: budget, cap });
    const { page } = h;
    await expect
      .poll(
        async () =>
          (await milestones(page)).some((m) => m.phase === "streaming-complete") ||
          (await page.locator(".sift-load-failure").count()) > 0,
        { timeout: 120_000 },
      )
      .toBe(true);
    const loaded = await page.getByTestId("loaded-count").textContent();
    const peak = await harnessState(page, (s) => s.peakWorkerMemory);
    const failure = await page
      .locator(".sift-load-failure")
      .textContent()
      .catch(() => null);
    rows.push(
      `cap ${factor}x (${cap}): loaded ${loaded}, peak live heap ${peak} (${(peak / budget).toFixed(2)}x budget), ${failure ? `TRAP: ${failure}` : "ok"}`,
    );
    await h.app.close();
    current = null;
  }
  console.log(rows.join("\n"));
  test.info().annotations.push({ type: "headroom", description: rows.join("\n") });
});
