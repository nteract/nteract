import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { build, preview } from "vite-plus";

export async function testPackageBrowser({
  scratch,
  packageRoot,
  wasm,
  tableFromArrays,
  tableToIPC,
}) {
  const output = resolve(packageRoot, "test-results/package-browser");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await mkdir(join(scratch, "public"), { recursive: true });
  // One table, two on-disk formats. CSV goes through @nteract/sift-csv, which
  // has its own packed-consumer test.
  const ipc = tableToIPC(
    tableFromArrays({
      name: ["Gamma", "Alpha", "Beta"],
      value: [3, 1, null],
      active: [true, false, true],
    }),
    "stream",
  );
  await writeFile(join(scratch, "public/fixture.arrow"), ipc);
  await writeFile(join(scratch, "public/fixture.parquet"), wasm.write_parquet_ipc(ipc));
  await writeFile(
    join(scratch, "index.html"),
    `<!doctype html>
    <html lang="en" data-theme="light"><head><meta charset="utf-8"><title>Packed Sift smoke test</title></head>
    <body><main><h1>Sift · standalone package</h1>
    <p>Complete synthetic file · three rows · local assets</p>
    <nav><button id="arrow">Arrow</button><button id="parquet">Parquet</button>
    <label><input id="dark" type="checkbox"> Dark theme</label></nav>
    <div id="status" role="status">Loading</div><div id="table"></div></main>
    <script type="module" src="/consumer.js"></script></body></html>`,
  );
  await writeFile(
    join(scratch, "consumer.js"),
    `
    import { createElement, StrictMode } from 'react';
    import { createRoot } from 'react-dom/client';
    import { SiftTable, loadTableFile, setWasmUrl } from '@nteract/sift';
    import '@nteract/sift/style.css';
    import wasmUrl from '@nteract/sift/sift.wasm?url';
    import './host.css';
    // The second case leaves initialization to the packaged wasm-bindgen
    // glue, exercising production rewriting of its relative binary URL.
    if (new URLSearchParams(location.search).get('wasm') !== 'default') setWasmUrl(wasmUrl);
    const root = createRoot(document.querySelector('#table'));
    let epoch = 0;
    function show(format) {
      const request = ++epoch;
      document.querySelector('#status').textContent = 'Loading ' + format;
      window.siftState = null;
      const file = format === 'Arrow' ? '/fixture.arrow' : '/fixture.parquet';
      const input = { source: { kind: 'loader', load: async () => loadTableFile(
        new Uint8Array(await (await fetch(file)).arrayBuffer())) } };
      root.render(createElement(StrictMode, null, createElement(SiftTable, {
        ...input, key: request,
        onChange: state => { window.siftState = state; },
        onLoadMilestone: milestone => {
          if (request === epoch && ['complete', 'engine-mounted'].includes(milestone.phase)) {
            document.querySelector('#status').textContent = format + ' · 3 rows';
          }
        },
      })));
    }
    document.querySelector('#arrow').onclick = () => show('Arrow');
    document.querySelector('#parquet').onclick = () => show('Parquet');
    document.querySelector('#dark').onchange = event => {
      document.documentElement.dataset.theme = event.target.checked ? 'dark' : 'light';
    };
    show('Arrow');
  `,
  );
  await writeFile(
    join(scratch, "host.css"),
    `
    /* The host owns its page colors; Sift's tokens live on .sift-root only. */
    :root { --host-bg: #fff; --host-ink: #111; --host-muted: #666; }
    [data-theme="dark"] { --host-bg: #111; --host-ink: #eee; --host-muted: #999; }
    body { margin: 0; padding: 24px; background: var(--host-bg); color: var(--host-ink); font: 14px system-ui; }
    main { max-width: 1000px; margin: auto; }
    h1 { font-size: 22px; font-weight: 650; margin: 0 0 6px; }
    p { color: var(--host-muted); margin: 0 0 18px; }
    nav { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
    button { border: 1px solid var(--sift-rule); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
    #status { margin: 0 0 10px; color: var(--sift-muted); }
    #table { height: 430px; }
  `,
  );
  // A dev server can resolve missing production assets through source paths.
  // Build the isolated, packed consumer, then serve only its static output.
  await build({ configFile: false, root: scratch, logLevel: "warn" });
  const assets = [];
  for (const name of await readdir(join(scratch, "dist/assets"))) {
    const bytes = await readFile(join(scratch, "dist/assets", name));
    assets.push({ name, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  const packagedWasm = await readFile(
    join(scratch, "node_modules/@nteract/sift/lib/wasm/sift_wasm_bg.wasm"),
  );
  const wasmAssets = assets.filter((asset) => asset.name.endsWith(".wasm"));
  assert.equal(wasmAssets.length, 1, "Both URL paths must use one emitted WASM asset");
  assert.equal(wasmAssets[0].sha256, sha256(packagedWasm), "Emit the exact packaged binary");
  const server = await preview({
    configFile: false,
    root: scratch,
    logLevel: "error",
    preview: {
      host: "127.0.0.1",
      port: 0,
      strictPort: true,
    },
  });
  let browser;
  const requests = [];
  const errors = [];
  try {
    const address = server.httpServer.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    for (const mode of ["explicit", "default"]) {
      // Separate contexts reset both the WASM singleton and browser caches.
      const context = await browser.newContext({ viewport: { width: 1100, height: 680 } });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      page.on("pageerror", (error) => errors.push(`${mode}: ${error.message}`));
      page.on("response", (response) => {
        if (new URL(response.url()).origin !== origin) return;
        requests.push({
          mode,
          path: new URL(response.url()).pathname,
          status: response.status(),
          contentType: response.headers()["content-type"] ?? "",
        });
      });
      await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin || ["data:", "blob:"].includes(url.protocol))
          return route.continue();
        errors.push(`${mode}: Unexpected external request: ${url}`);
        return route.abort();
      });
      try {
        await page.goto(`${origin}/?wasm=${mode}`);
        const firstName = page.locator('.sift-row[aria-rowindex="2"] .sift-cell').first();
        await expect(firstName).toHaveText("Gamma");
        const valueHeader = page.locator('.sift-th[data-col="1"]');
        await valueHeader.focus();
        await page.keyboard.press("Enter");
        await expect(firstName).toHaveText("Alpha");
        await page.locator('.sift-th[data-col="2"] .sift-bool-true').click();
        await page.waitForFunction(() => window.siftState?.filteredCount === 2);
        await expect(firstName).toHaveText("Gamma");
        await page.screenshot({ path: join(output, `${mode}-arrow-light.png`), fullPage: true });
        const light = await page
          .locator(".sift-table-container")
          .evaluate((element) => getComputedStyle(element).backgroundColor);
        await page.locator("#dark").check();
        await page.locator("#parquet").click();
        await expect(page.locator("#status")).toHaveText("Parquet · 3 rows");
        await expect(firstName).toHaveText("Gamma");
        await valueHeader.locator(".sift-th-top").click();
        await expect(firstName).toHaveText("Alpha");
        await page.locator('.sift-th[data-col="2"] .sift-bool-true').click();
        await page.waitForFunction(() => window.siftState?.filteredCount === 2);
        await expect(firstName).toHaveText("Gamma");
        const dark = await page
          .locator(".sift-table-container")
          .evaluate((element) => getComputedStyle(element).backgroundColor);
        assert.notEqual(light, dark, "Explicit host dark mode must reach Sift");
        await page.screenshot({ path: join(output, `${mode}-parquet-dark.png`), fullPage: true });
        // Reopen the original file after disposing a binary store.
        await page.locator("#arrow").click();
        await expect(page.locator("#status")).toHaveText("Arrow · 3 rows");
        await expect(firstName).toHaveText("Gamma");
        assert(
          requests.some(
            (request) =>
              request.mode === mode &&
              request.path.endsWith(".wasm") &&
              request.status === 200 &&
              request.contentType.includes("application/wasm"),
          ),
          `${mode}: Browser must fetch the production WASM asset`,
        );
      } catch (error) {
        await page.screenshot({ path: join(output, `${mode}-failure.png`), fullPage: true });
        throw error;
      } finally {
        await context.close();
      }
    }
    assert(!requests.some((request) => request.status >= 400), "Production assets must load");
    assert.deepEqual(errors, [], "No runtime errors or external data requests");
    console.log(`Packed production browser smoke passed. Screenshots: ${output}`);
  } finally {
    await browser?.close();
    await new Promise((done, reject) =>
      server.httpServer.close((error) => (error ? reject(error) : done())),
    );
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
