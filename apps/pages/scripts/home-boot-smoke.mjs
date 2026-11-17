// When the library and a Page load the editor, on a real local host. The
// library at / draws its rows from app.js and its static chunks alone: the
// editor chunk and Automerge's WASM are requested only after the first row is
// in the document, within the idle wait (viewer/editor-start.mjs), at once
// when a pointer enters a row, and a click on a row before either still opens
// the Page. A direct Page load preloads the WASM from theme.js in <head>,
// downloaded once. Each load is a fresh browser context, so nothing comes
// from the HTTP cache. Records request start times in report.json.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { IDLE_TIMEOUT_MS } from "../viewer/editor-start.mjs";

const origin = process.env.PAGES_ORIGIN || "http://localhost:9894";
assert.equal(new URL(origin).hostname, "localhost");
const output = process.env.PAGES_SCREENSHOTS || "/tmp/pages-home-boot";
await mkdir(output, { recursive: true });
const report = { completed: [], errors: [], timings: {} };
const complete = (name) => {
  report.completed.push(name);
  console.log(`[Home boot E2E] ${name}`);
};
const browser = await chromium.launch({ headless: true });
const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 844 };
const ROWS = ".index-row-link, .index-card-link";

async function signIn(email) {
  const context = await browser.newContext({ viewport: WIDE });
  const page = await context.newPage();
  const begin = await context.request.get(`${origin}/api/auth/login`, { maxRedirects: 0 });
  assert.equal(begin.status(), 302);
  const authorize = new URL(begin.headers().location);
  authorize.searchParams.set("login_hint", email);
  await page.goto(authorize.href, { waitUntil: "domcontentloaded", timeout: 60000 });
  await expect(page.getByRole("button", { name: /, switch page$/ })).toBeVisible({
    timeout: 60000,
  });
  return page;
}

/** A signed-in tab with an empty HTTP cache. `holdIdle` keeps the idle
 * start from running, so only intent or an open can start the editor. */
async function fresh(storageState, viewport, { holdIdle = false } = {}) {
  const context = await browser.newContext({ storageState, viewport });
  await context.addInitScript(
    ({ rows, holdIdle }) => {
      // When the first row joins the document, on the resource timeline.
      window.__firstRow = null;
      new MutationObserver((_, observer) => {
        if (!document.querySelector(rows)) return;
        window.__firstRow = performance.now();
        observer.disconnect();
      }).observe(document, { childList: true, subtree: true });
      if (holdIdle) {
        window.requestIdleCallback = () => 0;
        window.cancelIdleCallback = () => {};
      }
    },
    { rows: ROWS, holdIdle },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  return page;
}

/** Resource entries whose URL path is `pathname`. */
const entries = (page, pathname) =>
  page.evaluate(
    (pathname) =>
      performance
        .getEntriesByType("resource")
        .filter((entry) => new URL(entry.name).pathname === pathname)
        .map(({ startTime, responseEnd, initiatorType }) => ({
          startTime,
          responseEnd,
          initiatorType,
        })),
    pathname,
  );
const firstStart = async (page, pathname, timeout = 10_000) => {
  let found = [];
  await expect
    .poll(async () => (found = await entries(page, pathname)).length, { timeout })
    .toBeGreaterThan(0);
  return Math.min(...found.map((entry) => entry.startTime));
};
const round = (value) => Math.round(value * 10) / 10;
const preloadPriority = (page) =>
  page.evaluate(
    () =>
      document.head
        .querySelector('link[rel="preload"][as="fetch"]')
        ?.getAttribute("fetchpriority") ?? null,
  );

let owner;
const pages = [];
try {
  owner = await signIn("dev@localhost");
  for (const title of ["Roadmap", "Launch notes", "Weekly review"]) {
    const created = await owner.evaluate(async (title) => {
      const response = await fetch("/api/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "create_page",
          arguments: { title, markdown: `Notes for ${title}.`, nonce: crypto.randomUUID() },
        }),
      });
      return { status: response.status, body: await response.json() };
    }, title);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    pages.push(created.body.page_id);
  }
  const storageState = await owner.context().storageState();
  // The editor chunk is app.js's one dynamic import; the WASM is the URL
  // app.js preloads when the editor starts.
  const { editorChunk, wasm } = await owner.evaluate(async () => {
    const html = await (await fetch("/")).text();
    const app = html.match(/src="(\/app-[A-Z2-7]{8}\.js)"/)[1];
    const source = await (await fetch(app)).text();
    const imports = [...source.matchAll(/import\("\.\/(chunks\/[A-Z2-7]{8}\.js)"\)/g)];
    return {
      editorChunk: imports.length === 1 ? `/${imports[0][1]}` : null,
      wasm: source.match(/\/automerge-[A-Z2-7]{8}\.wasm/)?.[0] ?? null,
    };
  });
  assert.ok(editorChunk, "app.js has one dynamic import, the editor");
  assert.ok(wasm, "app.js names the hashed WASM");

  for (const [name, viewport] of [
    ["wide", WIDE],
    ["narrow", NARROW],
  ]) {
    const page = await fresh(storageState, viewport);
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(ROWS).first()).toBeVisible({ timeout: 30000 });
    const firstRow = await page.evaluate(() => window.__firstRow);
    assert.ok(firstRow !== null);
    const editorStart = await firstStart(page, editorChunk, IDLE_TIMEOUT_MS + 5000);
    const wasmStart = await firstStart(page, wasm, IDLE_TIMEOUT_MS + 5000);
    assert.ok(
      editorStart >= firstRow,
      `${name}: editor at ${editorStart}, first row at ${firstRow}`,
    );
    assert.ok(wasmStart >= firstRow, `${name}: WASM at ${wasmStart}, first row at ${firstRow}`);
    // The idle wait, plus room for a loaded test machine.
    assert.ok(editorStart - firstRow <= IDLE_TIMEOUT_MS + 1000, `${name}: editor waited too long`);
    assert.ok(wasmStart - firstRow <= IDLE_TIMEOUT_MS + 1000, `${name}: WASM waited too long`);
    assert.equal((await entries(page, wasm)).length, 1, "the WASM downloads once");
    // Ahead of need, the WASM yields to the library's own requests, and the
    // chunk's fetch still reuses the low-priority preload.
    assert.equal(await preloadPriority(page), "low");
    report.timings[`home_${name}`] = {
      first_row: round(firstRow),
      editor_chunk_start: round(editorStart),
      wasm_start: round(wasmStart),
    };
    await page.screenshot({ path: path.join(output, `home-${name}.png`) });
    await page.context().close();
  }
  complete(
    "/ draws its first rows before it asks for the editor or the WASM, then starts both when idle",
  );

  {
    const page = await fresh(storageState, WIDE, { holdIdle: true });
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    const row = page.locator(".index-row-link").first();
    await expect(row).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(500);
    assert.deepEqual(await entries(page, editorChunk), [], "no editor before intent");
    assert.deepEqual(await entries(page, wasm), [], "no WASM before intent");
    const hovered = await page.evaluate(() => performance.now());
    await row.hover();
    const editorStart = await firstStart(page, editorChunk);
    const wasmStart = await firstStart(page, wasm);
    assert.equal(await preloadPriority(page), null, "intent keeps the default priority");
    assert.ok(editorStart >= hovered && editorStart - hovered < 1000, `editor at ${editorStart}`);
    assert.ok(wasmStart >= hovered && wasmStart - hovered < 1000, `WASM at ${wasmStart}`);
    report.timings.home_hover = {
      hovered: round(hovered),
      editor_chunk_start: round(editorStart),
      wasm_start: round(wasmStart),
    };
    await page.context().close();
  }
  complete("Hovering a row asks for the editor and the WASM at once");

  {
    const page = await fresh(storageState, NARROW, { holdIdle: true });
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    const row = page.locator(".index-row-link").first();
    await expect(row).toBeVisible({ timeout: 30000 });
    assert.deepEqual(await entries(page, editorChunk), []);
    // A click with no pointer or focus before it: no intent, no idle start.
    await row.evaluate((link) => link.click());
    await expect(page).toHaveURL(/\/p\//, { timeout: 30000 });
    await expect(page.locator("wg-content").first()).toBeVisible({ timeout: 30000 });
    assert.ok((await entries(page, editorChunk)).length > 0);
    await page.context().close();
  }
  complete("A click on a row before the idle start or any intent opens the Page");

  for (const [name, viewport] of [
    ["wide", WIDE],
    ["narrow", NARROW],
  ]) {
    const page = await fresh(storageState, viewport);
    await page.goto(`${origin}/p/${pages[0]}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("wg-content").first()).toContainText("Notes for Roadmap", {
      timeout: 30000,
    });
    const found = await entries(page, wasm);
    assert.equal(found.length, 1, "the WASM downloads once: the editor reuses the preload");
    assert.equal(found[0].initiatorType, "link", "theme.js preloaded it");
    const app = await page.evaluate(
      () =>
        performance
          .getEntriesByType("resource")
          .find((entry) => /\/app-[A-Z2-7]{8}\.js$/.test(entry.name))
          ?.toJSON() ?? null,
    );
    const theme = await page.evaluate(
      () =>
        performance
          .getEntriesByType("resource")
          .find((entry) => /\/theme-[A-Z2-7]{8}\.js$/.test(entry.name))
          ?.toJSON() ?? null,
    );
    assert.ok(app && theme);
    // The WASM starts beside app.js, not after it.
    assert.ok(found[0].startTime <= app.responseEnd, "the WASM starts before app.js finishes");
    report.timings[`page_${name}`] = {
      theme_response_end: round(theme.responseEnd),
      app_start: round(app.startTime),
      app_response_end: round(app.responseEnd),
      wasm_start: round(found[0].startTime),
      wasm_response_end: round(found[0].responseEnd),
    };
    await page.context().close();
  }
  complete("A direct Page load preloads the WASM from <head>, downloaded once");
} catch (error) {
  report.failure = error.stack ?? String(error);
  report.errors.push(error.message);
  if (owner) await owner.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  report.cleaned = true;
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.timings, null, 2));
}
