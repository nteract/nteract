// When the library and a Page load the editor, on a real local host
// (viewer/wasm-preload.mjs editorBoot). Home (/) starts the editor at boot,
// with theme.js preloading Automerge's WASM at fetchpriority="low" beside
// app.js. /pages lists from the shell alone: neither the editor chunk nor the
// WASM loads until a Page opens, and a click on a row opens it. A direct Page
// load preloads the WASM from theme.js at the default priority. Each WASM
// downloads once. Each load is a fresh browser context, so nothing comes from
// the HTTP cache. Records request start times in report.json.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

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

/** A signed-in tab with an empty HTTP cache. */
async function fresh(storageState, viewport) {
  const context = await browser.newContext({ storageState, viewport });
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
/** app.js's resource entry. */
const appEntry = (page) =>
  page.evaluate(
    () =>
      performance
        .getEntriesByType("resource")
        .find((entry) => /\/app-[A-Z2-7]{8}\.js$/.test(entry.name))
        ?.toJSON() ?? null,
  );
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
  // The editor chunk is the largest of app.js's dynamic imports (the other is
  // the card image shrink pass); the WASM is the hashed URL app.js names.
  const { editorChunk, wasm } = await owner.evaluate(async () => {
    const html = await (await fetch("/")).text();
    const app = html.match(/src="(\/app-[A-Z2-7]{8}\.js)"/)[1];
    const source = await (await fetch(app)).text();
    const imports = [...source.matchAll(/import\("\.\/(chunks\/[A-Z2-7]{8}\.js)"\)/g)].map(
      (match) => `/${match[1]}`,
    );
    const sizes = await Promise.all(
      imports.map(async (url) => (await (await fetch(url)).text()).length),
    );
    return {
      editorChunk: imports.length ? imports[sizes.indexOf(Math.max(...sizes))] : null,
      wasm: source.match(/\/automerge-[A-Z2-7]{8}\.wasm/)?.[0] ?? null,
    };
  });
  assert.ok(editorChunk, "app.js imports the editor dynamically");
  assert.ok(wasm, "app.js names the hashed WASM");

  for (const [name, viewport] of [
    ["wide", WIDE],
    ["narrow", NARROW],
  ]) {
    const page = await fresh(storageState, viewport);
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(ROWS).first()).toBeVisible({ timeout: 30000 });
    const editorStart = await firstStart(page, editorChunk);
    await firstStart(page, wasm);
    const found = await entries(page, wasm);
    assert.equal(found.length, 1, "the WASM downloads once: the editor reuses the preload");
    assert.equal(found[0].initiatorType, "link", "theme.js preloaded it");
    assert.equal(await preloadPriority(page), "low", "Home asks for the WASM at low priority");
    const app = await appEntry(page);
    assert.ok(found[0].startTime <= app.responseEnd, "the WASM starts before app.js finishes");
    report.timings[`home_${name}`] = {
      app_response_end: round(app.responseEnd),
      editor_chunk_start: round(editorStart),
      wasm_start: round(found[0].startTime),
    };
    await page.screenshot({ path: path.join(output, `home-${name}.png`) });
    await page.context().close();
  }
  complete("/ starts the editor at boot, with the WASM preloaded at low priority beside app.js");

  {
    const page = await fresh(storageState, NARROW);
    await page.goto(`${origin}/pages`, { waitUntil: "domcontentloaded" });
    const row = page.locator(".index-row-link").first();
    await expect(row).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(1000);
    assert.deepEqual(await entries(page, editorChunk), [], "no editor before an open");
    assert.deepEqual(await entries(page, wasm), [], "no WASM before an open");
    await row.click();
    await expect(page).toHaveURL(/\/p\//, { timeout: 30000 });
    await expect(page.locator("wg-content").first()).toBeVisible({ timeout: 30000 });
    assert.ok((await entries(page, editorChunk)).length > 0);
    assert.equal((await entries(page, wasm)).length, 1, "the open downloads the WASM once");
    await page.context().close();
  }
  complete("/pages loads neither the editor nor the WASM until a row opens a Page");

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
    assert.equal(await preloadPriority(page), null, "a Page keeps the default priority");
    const app = await appEntry(page);
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
