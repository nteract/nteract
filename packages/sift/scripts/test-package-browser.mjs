import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite-plus";

export async function testPackageBrowser({
  scratch,
  packageRoot,
  wasm,
  tableFromArrays,
  tableToIPC,
}) {
  const output = resolve(packageRoot, "../../.context/sift-package/browser");
  await mkdir(output, { recursive: true });
  await writeFile(
    join(scratch, "fixture.parquet"),
    wasm.write_parquet_ipc(
      tableToIPC(
        tableFromArrays({
          name: ["Gamma", "Alpha", "Beta"],
          value: [3, 1, null],
          active: [true, false, true],
        }),
      ),
    ),
  );
  await writeFile(
    join(scratch, "index.html"),
    `<!doctype html>
    <html lang="en" data-theme="light"><head><meta charset="utf-8"><title>Packed Sift smoke test</title></head>
    <body><main><h1>Sift · standalone package</h1>
    <p>Complete synthetic file · three rows · local assets</p>
    <nav><button id="csv">CSV</button><button id="parquet">Parquet</button>
    <label><input id="dark" type="checkbox"> Dark theme</label></nav>
    <div id="status" role="status">Loading</div><div id="table"></div></main>
    <script type="module" src="/consumer.js"></script></body></html>`,
  );
  await writeFile(
    join(scratch, "consumer.js"),
    `
    import { createElement, StrictMode } from 'react';
    import { createRoot } from 'react-dom/client';
    import { SiftTable, parseCsv, loadTableFile, setWasmUrl } from '@nteract/sift';
    import '@nteract/sift/style.css';
    import wasmUrl from '@nteract/sift/sift.wasm?url';
    import './host.css';
    setWasmUrl(wasmUrl);
    const root = createRoot(document.querySelector('#table'));
    let epoch = 0;
    function show(format) {
      const request = ++epoch;
      document.querySelector('#status').textContent = 'Loading ' + format;
      window.siftState = null;
      const input = format === 'CSV'
        ? { data: parseCsv('name,value,active\\nGamma,3,true\\nAlpha,1,false\\nBeta,,true') }
        : { source: { kind: 'loader', load: async () => loadTableFile(
            new Uint8Array(await (await fetch('/fixture.parquet')).arrayBuffer())) } };
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
    document.querySelector('#csv').onclick = () => show('CSV');
    document.querySelector('#parquet').onclick = () => show('Parquet');
    document.querySelector('#dark').onchange = event => {
      document.documentElement.dataset.theme = event.target.checked ? 'dark' : 'light';
    };
    show('CSV');
  `,
  );
  await writeFile(
    join(scratch, "host.css"),
    `
    body { margin: 0; padding: 24px; background: var(--sift-bg); color: var(--sift-ink); font: 14px system-ui; }
    main { max-width: 1000px; margin: auto; }
    h1 { font-size: 22px; font-weight: 650; margin: 0 0 6px; }
    p { color: var(--sift-muted); margin: 0 0 18px; }
    nav { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
    button { border: 1px solid var(--sift-rule); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
    #status { margin: 0 0 10px; color: var(--sift-muted); }
    #table { height: 430px; }
  `,
  );
  const server = await createServer({
    configFile: false,
    root: scratch,
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 51947,
      strictPort: true,
      fs: { allow: [scratch, resolve(packageRoot, "../..")] },
    },
  });
  let browser;
  try {
    await server.listen();
    const address = server.httpServer.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 680 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:"))
        return route.continue();
      errors.push(`Unexpected external request: ${url}`);
      return route.abort();
    });
    await page.goto(origin);
    const firstName = page.locator('.sift-row[aria-rowindex="2"] .sift-cell').first();
    await expect(firstName).toHaveText("Gamma");
    const valueHeader = page.locator('.sift-th[data-col="1"]');
    await valueHeader.focus();
    await page.keyboard.press("Enter");
    await expect(firstName).toHaveText("Alpha");
    await page.locator('.sift-th[data-col="2"] .sift-bool-true').click();
    await page.waitForFunction(() => window.siftState?.filteredCount === 2);
    await expect(firstName).toHaveText("Gamma");
    await page.screenshot({ path: join(output, "csv-light.png"), fullPage: true });
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
    await page.screenshot({ path: join(output, "parquet-dark.png"), fullPage: true });
    await page.setViewportSize({ width: 460, height: 720 });
    await expect(firstName).toBeVisible();
    await page.screenshot({ path: join(output, "parquet-dark-narrow.png"), fullPage: true });
    // Reopen the original file after disposing a binary store.
    await page.locator("#csv").click();
    await expect(page.locator("#status")).toHaveText("CSV · 3 rows");
    await expect(firstName).toHaveText("Gamma");
    assert.deepEqual(errors, [], "No runtime errors or external data requests");
    await writeFile(
      join(output, "evidence.json"),
      JSON.stringify(
        {
          package: "@nteract/sift",
          source: "packed artifact outside workspace",
          cases: [
            "CSV keyboard sort and boolean filter",
            "Parquet click sort and boolean filter",
            "light/dark theme",
            "narrow viewport",
            "binary-to-CSV reopen",
            "React StrictMode",
          ],
          lightBackground: light,
          darkBackground: dark,
          runtimeErrors: errors,
        },
        null,
        2,
      ),
    );
    console.log(`Packed browser smoke passed. Screenshots: ${output}`);
  } finally {
    await browser?.close();
    await server.close();
  }
}
