// Browser check for the Vega-Lite renderer (viewer/vega-chart.mjs), with no
// Page and no stored shape. Builds scripts/fixtures/chart-fixture.mjs with
// esbuild, serves it from loopback under the viewer's own CSP, and draws a
// stacked horizontal bar chart in Chromium: hover shows Vega's tooltip, the
// theme switches light and dark, Maximize opens the diagram viewer, and a
// phone width keeps the chart inside its frame. Reports the renderer chunk's
// size and writes light and dark screenshots.
//
// Then, in each engine in PAGES_CHART_ENGINES (default chromium, the engine
// the e2e harness installs), it draws scripts/fixtures/chart-hostile-fixture.mjs:
// charts whose spec or data put a CSS url() in every position that reaches a
// style, hovers every mark, and fails on any request off the fixture origin
// from the renderer. The unprotected "raw" layer's requests are recorded as
// the baseline in report.json.
//
//   node scripts/chart-smoke.mjs        # or: node scripts/e2e.mjs chart
//   PAGES_CHART_ENGINES=chromium,firefox,webkit node scripts/chart-smoke.mjs
//
// Output goes to PAGES_E2E_OUTPUT (set by scripts/e2e.mjs) or
// test-results/chart-smoke.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { chromium, expect, firefox, webkit } from "@playwright/test";
import { build } from "esbuild";
import { CHART_WORKER_CSP } from "../shared/chart-worker-csp.mjs";
import { CODE, NETWORK, STORAGE } from "./fixtures/chart-escapes.mjs";
import {
  ECMASCRIPT_GLOBALS,
  HOST_CONSTANTS,
  NEUTERED,
  WORKER_GLOBALS,
} from "../viewer/chart-lockdown.mjs";
import { VIEWER_CSP } from "./viewer-chunks.mjs";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = process.env.PAGES_E2E_OUTPUT ?? path.join(app, "test-results/chart-smoke");
const site = path.join(output, "site");
await mkdir(site, { recursive: true });
const report = { completed: [], errors: [], csp: [], requests: [], hostile: {} };
const ENGINES = { chromium, firefox, webkit };
const engines = (process.env.PAGES_CHART_ENGINES ?? "chromium")
  .split(",")
  .map((name) => name.trim());
for (const name of engines) assert.ok(ENGINES[name], `unknown engine ${name}`);
const complete = (name) => {
  report.completed.push(name);
  console.log(`[Chart E2E] ${name}`);
};

// The chart Worker, built as scripts/build.mjs builds it, and a fixture
// Worker with every check and guard off for the freeze page.
const workerBuild = (entry, outfile) =>
  build({
    entryPoints: [path.join(app, entry)],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    outfile: path.join(site, outfile),
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
  });
await workerBuild("viewer/chart-worker.mjs", "chart-worker.js");
await workerBuild("scripts/fixtures/chart-worker-unguarded.mjs", "unguarded-worker.js");
// The escape Workers: the real chart Worker with code after it that tries
// every way out, and the same attempts with no lockdown. Each is served under
// the chart Worker's CSP, and under /open/ with no CSP at all.
await workerBuild("scripts/fixtures/chart-worker-escape.mjs", "escape-worker.js");
await workerBuild("scripts/fixtures/chart-worker-escape.mjs", "open/escape-worker.js");
await workerBuild("scripts/fixtures/chart-worker-escape-bare.mjs", "escape-bare-worker.js");
await workerBuild("scripts/fixtures/chart-worker-escape-bare.mjs", "open/escape-bare-worker.js");
// The chart Worker with a recorder in front of every host global it reads,
// under the chart Worker's CSP. Its page builds Arrow IPC with code the
// viewer CSP refuses, so the page is served under /open/.
await workerBuild("scripts/fixtures/chart-worker-recorder.mjs", "recorder-worker.js");
// The real chart Worker with a listener that measures text with Vega's own
// metrics, for the measured-against-drawn check.
await workerBuild("scripts/fixtures/chart-worker-metrics.mjs", "metrics-worker.js");
await build({
  entryPoints: { fixture: path.join(app, "scripts/fixtures/chart-recorder-fixture.mjs") },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir: path.join(site, "open/recorder"),
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "error",
});
await writeFile(
  path.join(site, "open/recorder/index.html"),
  `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Chart Worker globals</title></head>
  <body><script type="module" src="/open/recorder/fixture.js"></script></body>
</html>
`,
);
const workerBytes = await readFile(path.join(site, "chart-worker.js"));
report.worker = {
  bytes: workerBytes.byteLength,
  gzip: gzipSync(workerBytes, { level: 9 }).byteLength,
};
const workerDefine = { __PAGES_CHART_WORKER_URL__: '"/chart-worker.js"' };

// The same esbuild settings as the viewer (scripts/viewer-chunks.mjs): ESM,
// split chunks, minified, so the renderer's chunk is the one a Page would load.
const built = await build({
  entryPoints: { fixture: path.join(app, "scripts/fixtures/chart-fixture.mjs") },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  splitting: true,
  outdir: site,
  chunkNames: "chunks/[hash]",
  metafile: true,
  define: { "process.env.NODE_ENV": '"production"', ...workerDefine },
  logLevel: "error",
});
const rendererInput = "viewer/vega-chart.mjs";
const [chunk] = Object.entries(built.metafile.outputs).filter(
  ([file, meta]) => file.includes("/chunks/") && meta.entryPoint?.endsWith(rendererInput),
);
assert.ok(chunk, "the renderer builds as its own chunk");
const chunkBytes = await readFile(path.resolve(chunk[0]));
report.chunk = {
  file: path.relative(output, path.resolve(chunk[0])),
  bytes: chunkBytes.byteLength,
  gzip: gzipSync(chunkBytes, { level: 9 }).byteLength,
};
const entryBytes = await readFile(path.join(site, "fixture.js"));
assert.ok(entryBytes.byteLength < 20_000, "Vega stays out of the page that loads the renderer");
console.log(
  `[Chart E2E] renderer chunk ${(report.chunk.bytes / 1024).toFixed(1)} KiB, ` +
    `${(report.chunk.gzip / 1024).toFixed(1)} KiB gzip; Worker ` +
    `${(report.worker.bytes / 1024).toFixed(1)} KiB, ${(report.worker.gzip / 1024).toFixed(1)} KiB gzip`,
);
// The hostile fixture builds on its own, so its direct Vega imports don't
// change how the renderer's chunk is measured above.
await build({
  entryPoints: { fixture: path.join(app, "scripts/fixtures/chart-hostile-fixture.mjs") },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  splitting: true,
  outdir: path.join(site, "hostile"),
  chunkNames: "chunks/[hash]",
  define: { "process.env.NODE_ENV": '"production"', ...workerDefine },
  logLevel: "error",
});
await build({
  entryPoints: { fixture: path.join(app, "scripts/fixtures/chart-freeze-fixture.mjs") },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  splitting: true,
  outdir: path.join(site, "freeze"),
  chunkNames: "chunks/[hash]",
  define: { "process.env.NODE_ENV": '"production"', ...workerDefine },
  logLevel: "error",
});
await build({
  entryPoints: { fixture: path.join(app, "scripts/fixtures/chart-large-fixture.mjs") },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  splitting: true,
  outdir: path.join(site, "large"),
  chunkNames: "chunks/[hash]",
  define: { "process.env.NODE_ENV": '"production"', ...workerDefine },
  logLevel: "error",
});
await build({
  entryPoints: { fixture: path.join(app, "scripts/fixtures/chart-metrics-fixture.mjs") },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  splitting: true,
  outdir: path.join(site, "metrics"),
  chunkNames: "chunks/[hash]",
  define: { "process.env.NODE_ENV": '"production"', ...workerDefine },
  logLevel: "error",
});
await writeFile(
  path.join(site, "metrics/index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Chart text metrics</title>
    <link rel="stylesheet" href="/metrics/fixture.css" />
  </head>
  <body>
    <main id="charts" style="display: grid; gap: 8px; padding: 8px"></main>
    <script type="module" src="/metrics/fixture.js"></script>
  </body>
</html>
`,
);
await build({
  entryPoints: { fixture: path.join(app, "scripts/fixtures/chart-escape-fixture.mjs") },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir: path.join(site, "breakout"),
  logLevel: "error",
});
await writeFile(
  path.join(site, "breakout/index.html"),
  `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Chart escape fixture</title></head>
  <body><script type="module" src="/breakout/fixture.js"></script></body>
</html>
`,
);
await writeFile(
  path.join(site, "large/index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Large chart fixture</title>
    <link rel="stylesheet" href="/large/fixture.css" />
  </head>
  <body>
    <main id="charts" style="display: grid; grid-template-columns: repeat(2, 480px); gap: 8px; padding: 8px"></main>
    <script type="module" src="/large/fixture.js"></script>
  </body>
</html>
`,
);
await writeFile(
  path.join(site, "freeze/index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Chart freeze fixture</title>
    <link rel="stylesheet" href="/freeze/fixture.css" />
  </head>
  <body>
    <main id="charts" style="display: grid; grid-template-columns: repeat(2, 360px); gap: 8px; padding: 8px"></main>
    <script type="module" src="/freeze/fixture.js"></script>
  </body>
</html>
`,
);
await writeFile(
  path.join(site, "hostile/index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Hostile chart fixture</title>
    <link rel="stylesheet" href="/hostile/fixture.css" />
  </head>
  <body>
    <main id="charts" style="display: grid; grid-template-columns: repeat(3, 300px); gap: 8px; padding: 8px"></main>
    <script type="module" src="/hostile/fixture.js"></script>
  </body>
</html>
`,
);
await writeFile(
  path.join(site, "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Chart fixture</title>
    <link rel="stylesheet" href="/fixture.css" />
  </head>
  <body>
    <main style="box-sizing: border-box; max-width: 760px; margin: 0 auto; padding: 32px 16px">
      <p>A Page paragraph before the chart, in the Page's own type.</p>
      <div id="chart"></div>
    </main>
    <script type="module" src="/fixture.js"></script>
  </body>
</html>
`,
);

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
// Worker scripts carry the chart Worker's own CSP, as the Pages Worker serves
// every /chunks/ script; everything else carries the page's, and /open/ none.
const WORKER_SCRIPTS = new Set([
  "/chart-worker.js",
  "/unguarded-worker.js",
  "/escape-worker.js",
  "/escape-bare-worker.js",
  "/recorder-worker.js",
  "/metrics-worker.js",
]);
// Requests from an escape Worker: none may arrive.
report.escapeRequests = [];
const server = createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname;
  if (name.startsWith("/escape/")) {
    report.escapeRequests.push(name);
    response.writeHead(404).end();
    return;
  }
  const file = path.join(site, name.endsWith("/") ? `${name}index.html` : name);
  try {
    if (!file.startsWith(site)) throw new Error("outside the fixture");
    const body = await readFile(file);
    response.writeHead(200, {
      "Content-Type": types[path.extname(file)] ?? "application/octet-stream",
      // /open/ has no CSP: the escape controls and the recorder page.
      ...(!name.startsWith("/open/") && {
        "Content-Security-Policy": WORKER_SCRIPTS.has(name) ? CHART_WORKER_CSP : VIEWER_CSP,
      }),
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
server.on("upgrade", (request, socket) => {
  report.escapeRequests.push(new URL(request.url, "http://localhost").pathname);
  socket.destroy();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1000, height: 760 } });
const page = await context.newPage();
page.on("pageerror", (error) => report.errors.push(error.message));
page.on("console", (message) => {
  if (/Content Security Policy|Refused to/i.test(message.text())) report.csp.push(message.text());
  else if (message.type() === "error") report.errors.push(`console: ${message.text()}`);
});
page.on("request", (request) => report.requests.push(request.url()));

/**
 * Draw the hostile fixture in `engine`, hover every mark, and fail on any
 * request off the fixture origin from the "mount" or "draw" layer. Requests
 * are aborted, never sent.
 */
async function hostileCheck(engine) {
  const instance =
    engine === "chromium" ? browser : await ENGINES[engine].launch({ headless: true });
  const hostileContext = await instance.newContext({ viewport: { width: 1000, height: 900 } });
  const hostile = await hostileContext.newPage();
  const fetched = [];
  await hostileContext.route(
    (url) => !url.href.startsWith(origin),
    (route) => route.abort(),
  );
  hostile.on("request", (request) => {
    if (!request.url().startsWith(origin)) fetched.push(request.url());
  });
  try {
    await hostile.goto(`${origin}/hostile/`, { waitUntil: "load" });
    await expect(hostile.locator("body[data-fixture=ready]")).toBeAttached({ timeout: 30_000 });
    const sections = hostile.locator("section[data-layer]");
    for (let i = 0, n = await sections.count(); i < n; i++) {
      const section = sections.nth(i);
      await section.scrollIntoViewIfNeeded();
      const points = await section.evaluate((element) =>
        [...element.querySelectorAll("svg, svg path, svg text, svg rect")].map((node) => {
          const box = node.getBoundingClientRect();
          return [box.x + box.width / 2, box.y + box.height / 2];
        }),
      );
      for (const [x, y] of points) await hostile.mouse.move(x, y);
    }
    await hostile.waitForTimeout(1000);
    const outcomes = JSON.parse(await hostile.locator("body").getAttribute("data-outcomes"));
    const leaked = (layer) =>
      [
        ...new Set(
          fetched
            .filter((url) => url.includes(`/${layer}/`))
            .map((url) =>
              url
                .split("/")
                .at(-1)
                .replace(/\.svg.*$/, ""),
            ),
        ),
      ].sort();
    report.hostile[engine] = {
      fetched: { mount: leaked("mount"), draw: leaked("draw"), raw: leaked("raw") },
      outcomes,
      requests: fetched,
    };
    console.log(
      `[Chart E2E] ${engine}: the unprotected renderer fetched for ${leaked("raw").join(", ") || "nothing"}`,
    );
    assert.deepEqual(leaked("mount"), [], `${engine}: mount fetched`);
    assert.deepEqual(leaked("draw"), [], `${engine}: drawChart fetched`);
    assert.deepEqual(
      fetched.filter((url) => !/\/(mount|draw|raw)\//.test(url)),
      [],
      `${engine}: requests from outside the fixture's layers`,
    );
    // Through mount, a url() or a non-keyword cursor in the spec is refused,
    // and so is data() in an expression; a value a field carries into a paint
    // channel draws, cleaned.
    const drawsThroughMount = new Set([
      "fill-data",
      "stroke-data",
      "gradient-data",
      "text-fill-data",
    ]);
    for (const { layer, position, status } of outcomes.filter((o) => o.layer === "mount"))
      assert.equal(
        status,
        drawsThroughMount.has(position) ? "rendered" : "error",
        `${engine}: mount ${position}`,
      );
    complete(
      `${engine}: charts with url() in every style position, in the spec and in the data, draw or refuse and fetch nothing`,
    );
  } catch (error) {
    await hostile
      .screenshot({ path: path.join(output, `failure-hostile-${engine}.png`), fullPage: true })
      .catch(() => {});
    throw error;
  } finally {
    await hostileContext.close();
    if (instance !== browser) await instance.close();
  }
}

/**
 * Open the freeze fixture in `engine`: two charts whose Worker never finishes.
 * Each must end in its error state within the timer and a second, while the
 * page keeps painting and answering, and no Worker may be left running.
 */
async function freezeCheck(engine) {
  const instance =
    engine === "chromium" ? browser : await ENGINES[engine].launch({ headless: true });
  const freezeContext = await instance.newContext({ viewport: { width: 800, height: 600 } });
  const freeze = await freezeContext.newPage();
  const errors = [];
  freeze.on("pageerror", (error) => errors.push(error.message));
  try {
    await freeze.goto(`${origin}/freeze/`, { waitUntil: "load" });
    await expect(freeze.locator("body[data-fixture=ready]")).toBeAttached({ timeout: 30_000 });
    const timeout = await freeze.evaluate(() => window.chartTimeout);
    // While the Workers spin, the page paints and answers.
    await freeze.waitForTimeout(1500);
    const statuses = await freeze
      .locator("figure.pages-chart")
      .evaluateAll((figures) => figures.map((figure) => figure.dataset.chartStatus));
    // The first bar chart drew; the hung charts and the chart behind them wait.
    assert.deepEqual(
      statuses,
      ["rendered", "drawing", "drawing", "drawing"],
      `${engine}: still drawing`,
    );
    const framesBefore = await freeze.evaluate(() => window.chartFrames());
    const started = Date.now();
    await freeze.evaluate(() => 1);
    const roundTrip = Date.now() - started;
    await freeze.waitForTimeout(1000);
    const painted = (await freeze.evaluate(() => window.chartFrames())) - framesBefore;
    assert.ok(roundTrip < 100, `${engine}: an evaluate round trip took ${roundTrip} ms`);
    assert.ok(painted > 20, `${engine}: ${painted} frames in a second while the Workers spun`);
    // Each hung chart ends in the error state within its timer and a second,
    // one after the other on the one Worker; the last chart draws on the
    // second replacement.
    const elapsed = await freeze.evaluate(async () => {
      const figures = [...document.querySelectorAll("figure.pages-chart")];
      while (figures.some((figure) => figure.dataset.chartStatus === "drawing"))
        await new Promise((resolve) => setTimeout(resolve, 25));
      return performance.now() - Number(document.body.dataset.started);
    });
    const ended = await freeze.evaluate(() => window.chartEnded);
    assert.ok(ended["log-base"] <= timeout + 1000, `${engine}: ${JSON.stringify(ended)}`);
    assert.ok(ended["derived-bin"] <= 2 * timeout + 2000, `${engine}: ${JSON.stringify(ended)}`);
    assert.ok(ended["bars-b"] >= ended["derived-bin"], `${engine}: ${JSON.stringify(ended)}`);
    assert.ok(elapsed <= 2 * timeout + 3000, `${engine}: ended after ${Math.round(elapsed)} ms`);
    const messages = (
      await freeze.locator("figure.pages-chart .pages-chart-message").allInnerTexts()
    ).filter(Boolean);
    const final = await freeze
      .locator("figure.pages-chart")
      .evaluateAll((figures) => figures.map((figure) => figure.dataset.chartStatus));
    assert.deepEqual(final, ["rendered", "error", "error", "rendered"], `${engine}: ended`);
    assert.deepEqual(messages, [
      "This chart took too long to draw.",
      "This chart took too long to draw.",
    ]);
    // One Worker for four charts, and a replacement for each hung one.
    assert.deepEqual(
      await freeze.evaluate(() => window.chartWorkers),
      { started: 3, terminated: 2 },
      `${engine}: each hung Worker was terminated and replaced`,
    );
    await freeze.evaluate(() => window.destroyCharts());
    assert.deepEqual(
      await freeze.evaluate(() => window.chartWorkers),
      { started: 3, terminated: 3 },
      `${engine}: no Worker outlives its charts`,
    );
    await expect.poll(() => freeze.workers().length, { timeout: 15_000 }).toBe(0);
    assert.deepEqual(errors, [], `${engine}: page errors`);
    report.freeze ??= {};
    report.freeze[engine] = { timeout, ended, roundTrip, painted };
    complete(
      `${engine}: charts that never finish end as an error at ${ended["log-base"]} and ` +
        `${ended["derived-bin"]} ms (timer ${timeout} ms each, one Worker), the chart behind ` +
        `them draws at ${ended["bars-b"]} ms, the page painting ${painted} frames a second ` +
        `and answering in ${roundTrip} ms`,
    );
  } catch (error) {
    await freeze
      .screenshot({ path: path.join(output, `failure-freeze-${engine}.png`), fullPage: true })
      .catch(() => {});
    throw error;
  } finally {
    await freezeContext.close();
    if (instance !== browser) await instance.close();
  }
}

// Ways out the chart Worker's CSP alone lets through, by engine; the
// lockdown closes each. The smoke fails if this list is wrong either way.
const KNOWN_CSP_LEAKS = { chromium: [], firefox: ["EventSource", "FontFace"], webkit: [] };
// Code from strings the lockdown alone leaves: any function's constructor
// compiles a string. The Worker's CSP closes it.
const KNOWN_LOCKDOWN_LEAKS = ["Function"];

/**
 * In `engine`, run code in a chart Worker that tries every way out
 * (scripts/fixtures/chart-escapes.mjs), in four Workers: no lockdown and no
 * CSP (the positive control: every way out present in the engine works),
 * the real Worker under its own CSP, the lockdown alone, and the CSP alone.
 * A network way out counts as open when the server received its request.
 */
async function escapeCheck(engine) {
  const instance =
    engine === "chromium" ? browser : await ENGINES[engine].launch({ headless: true });
  const escapeContext = await instance.newContext();
  const escape = await escapeContext.newPage();
  try {
    const before = report.escapeRequests.length;
    await escape.goto(`${origin}/breakout/`, { waitUntil: "load" });
    await expect(escape.locator("body[data-fixture=ready]")).toBeAttached({ timeout: 60_000 });
    const escapes = await escape.evaluate(() => window.escapes);
    const requests = report.escapeRequests.slice(before);
    for (const variant of ["control", "both", "lockdown", "csp"])
      assert.ok(
        escapes[variant]?.results,
        `${engine} ${variant}: ${JSON.stringify(escapes[variant])}`,
      );
    // A way out is open when its request reached the server (network) or
    // its attempt worked (code, storage).
    const open = (variant) => {
      const { results } = escapes[variant];
      const reached = new Set(
        requests
          .filter((path) => path.startsWith(`/escape/${variant}/`))
          .map((path) => path.split("/").at(-1)),
      );
      return [
        ...Object.entries(NETWORK)
          .filter(([, [file]]) => reached.has(file))
          .map(([name]) => name),
        ...Object.keys({ ...CODE, ...STORAGE }).filter((name) => results[name] === "open"),
      ].sort();
    };
    const absent = Object.keys(STORAGE).filter(
      (name) => escapes.control.results[name] === "absent",
    );
    const present = [...Object.keys(NETWORK), ...Object.keys(CODE), ...Object.keys(STORAGE)]
      .filter((name) => !absent.includes(name))
      .sort();
    assert.deepEqual(open("control"), present, `${engine}: the control must get out every way`);
    assert.deepEqual(open("both"), [], `${engine}: lockdown and CSP together`);
    assert.deepEqual(open("lockdown"), KNOWN_LOCKDOWN_LEAKS, `${engine}: the lockdown alone`);
    // The CSP doesn't govern storage or channels: each the engine has stays
    // open, with the engine's known network leaks.
    const storage = Object.keys(STORAGE).filter((name) => !absent.includes(name));
    assert.deepEqual(
      open("csp"),
      [...KNOWN_CSP_LEAKS[engine], ...storage].sort(),
      `${engine}: the CSP alone`,
    );
    // Nothing but the allowlist is left on the locked-down Worker.
    const allowed = new Set([
      ...ECMASCRIPT_GLOBALS,
      ...WORKER_GLOBALS,
      ...NEUTERED,
      ...HOST_CONSTANTS,
    ]);
    assert.deepEqual(
      escapes.both.remaining.filter((name) => !allowed.has(name)),
      [],
      `${engine}: unlisted names left on the Worker`,
    );
    report.escapes ??= {};
    report.escapes[engine] = { escapes, absent };
    complete(
      `${engine}: code in the chart Worker reaches nothing (${present.length} ways out, each ` +
        `shown open with no lockdown and no CSP${absent.length ? `; absent here: ${absent.join(", ")}` : ""}); ` +
        `the lockdown alone leaves only ${KNOWN_LOCKDOWN_LEAKS.join(", ")}; the CSP alone leaves ` +
        `${storage.join(", ")}${KNOWN_CSP_LEAKS[engine].length ? `, and on the network ${KNOWN_CSP_LEAKS[engine].join(", ")}` : ", and nothing on the network"}; ` +
        `${escapes.both.remaining.length} names left, all on the allowlist`,
    );
  } finally {
    await escapeContext.close();
    if (instance !== browser) await instance.close();
  }
}

/**
 * In `engine`, draw every corpus spec and the other chart kinds through the
 * chart Worker with a recorder in front, and fail if its code read a host
 * global the lockdown's allowlist (viewer/chart-lockdown.mjs) doesn't keep.
 */
async function globalsCheck(engine) {
  const instance =
    engine === "chromium" ? browser : await ENGINES[engine].launch({ headless: true });
  const recordContext = await instance.newContext();
  const recorder = await recordContext.newPage();
  const errors = [];
  recorder.on("pageerror", (error) => errors.push(error.message));
  recorder.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  try {
    await recorder.goto(`${origin}/open/recorder/`, { waitUntil: "load" });
    await expect(recorder.locator("body[data-fixture=ready]"))
      .toBeAttached({ timeout: 120_000 })
      .catch((error) => {
        throw new Error(`${engine}: the recorder page didn't finish: ${errors.join(" | ")}`, {
          cause: error,
        });
      });
    const { names, statuses } = await recorder.evaluate(() => window.recorded);
    const drawn = statuses.filter((status) => status === "drawn").length;
    assert.ok(drawn >= 90, `${engine}: ${drawn} drawn: ${[...new Set(statuses)].join(" | ")}`);
    const kept = new Set([...WORKER_GLOBALS, ...NEUTERED]);
    assert.deepEqual(
      names.filter((name) => !kept.has(name)),
      [],
      `${engine}: the chart Worker reads host globals the lockdown removes`,
    );
    report.globals ??= {};
    report.globals[engine] = names;
    complete(
      `${engine}: the chart Worker reads only allowlisted host globals (${names.join(", ")})`,
    );
  } finally {
    await recordContext.close();
    if (instance !== browser) await instance.close();
  }
}

/** Vega's default label limits, in px: an axis label or legend label is
 * truncated with an ellipsis to fit, by the width the Worker measures. */
const LABEL_LIMITS = { "axis-label": 180, "legend-label": 160 };

/**
 * In `engine`, check that the chart Worker measures text as the page draws
 * it, in whichever font stack the page's probe chose for the Worker
 * (viewer/chart-font.mjs): for a long title, axis titles longer than their
 * axes, a crowded band axis of long labels, a continuous axis Vega thins and
 * a legend that truncates, at a wide and a phone width, in light and dark,
 * every text's width by the Worker's own text metrics is within 1 px or 2
 * percent of its drawn width. Vega lays out, truncates and thins text by the
 * measured width, so with the widths equal, truncated text fits its limit,
 * the labels Vega keeps don't overlap, and every text lies inside the SVG.
 */
async function metricsCheck(engine) {
  const instance =
    engine === "chromium" ? browser : await ENGINES[engine].launch({ headless: true });
  const metricsContext = await instance.newContext({ viewport: { width: 1000, height: 900 } });
  const metrics = await metricsContext.newPage();
  try {
    await metrics.goto(`${origin}/metrics/`, { waitUntil: "load" });
    await expect(metrics.locator("body[data-fixture=ready]")).toBeAttached({ timeout: 60_000 });
    const charts = await metrics.evaluate(() => window.chartMetrics);
    (report.metricsCharts ??= {})[engine] = charts;
    assert.equal(charts.length, 20, `${engine}: ${charts.length} charts measured`);
    let worst = 0;
    let count = 0;
    for (const chart of charts) {
      const label = `${engine} ${chart.name} at ${chart.width}px${chart.dark ? ", dark" : ""}`;
      assert.equal(chart.status, "rendered", label);
      assert.ok(chart.texts.length >= 3, `${label}: ${chart.texts.length} texts`);
      for (const text of chart.texts) {
        const off = Math.abs(text.measured - text.drawn);
        worst = Math.max(worst, off);
        count++;
        assert.ok(
          off <= Math.max(1, 0.02 * text.drawn),
          `${label}: "${text.text}" measures ${text.measured} in the Worker, drawn ${text.drawn}`,
        );
        if (text.role in LABEL_LIMITS)
          assert.ok(
            text.drawn <= LABEL_LIMITS[text.role] + 1,
            `${label}: "${text.text}" is ${text.drawn} px past its ${LABEL_LIMITS[text.role]} px limit`,
          );
        assert.ok(
          text.box.left >= chart.svg.left - 1 &&
            text.box.right <= chart.svg.right + 1 &&
            text.box.top >= chart.svg.top - 1 &&
            text.box.bottom <= chart.svg.bottom + 1,
          `${label}: "${text.text}" lies outside the SVG`,
        );
      }
      // Vega thins a continuous axis's labels by their measured width; a
      // band axis's labels it only truncates.
      if (chart.name !== "thinned") continue;
      const labels = chart.texts.filter((text) => text.role === "axis-label");
      assert.ok(labels.length >= 3, `${label}: ${labels.length} labels kept`);
      for (const [i, a] of labels.entries())
        for (const b of labels.slice(i + 1)) {
          const across = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
          const down = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
          assert.ok(across <= 1 || down <= 1, `${label}: "${a.text}" overlaps "${b.text}"`);
        }
    }
    const fonts = [...new Set(charts.flatMap((chart) => chart.fonts))];
    assert.equal(fonts.length, 1, `${engine}: one font across every chart: ${fonts.join(" | ")}`);
    const kept = fonts[0] === charts[0].pageFont;
    report.metrics ??= {};
    report.metrics[engine] = { worst, count, font: fonts[0], pageFont: charts[0].pageFont, kept };
    complete(
      `${engine}: charts draw in ${kept ? "the Page's stack" : `the fallback, ${fonts[0]}`}, and the ` +
        `chart Worker measures text as the page draws it: ${count} texts, light and dark, ` +
        `wide and phone width, within ${worst.toFixed(2)} px; titles fit inside the chart`,
    );
  } finally {
    await metricsContext.close();
    if (instance !== browser) await instance.close();
  }
}

/**
 * Time the largest chart the budgets admit through the real Worker in
 * `engine`: each must draw well inside the timer.
 */
async function largeCheck(engine) {
  const instance =
    engine === "chromium" ? browser : await ENGINES[engine].launch({ headless: true });
  const largeContext = await instance.newContext({ viewport: { width: 1000, height: 700 } });
  const large = await largeContext.newPage();
  try {
    await large.goto(`${origin}/large/`, { waitUntil: "load" });
    await expect(large.locator("body[data-fixture=ready]")).toBeAttached({ timeout: 60_000 });
    const times = await large.evaluate(() => window.chartTimes);
    report.large ??= {};
    report.large[engine] = times;
    for (const [name, { status, ms, message }] of Object.entries(times))
      assert.equal(status, "rendered", `${engine} ${name}: ${message} after ${ms} ms`);
    // Axis labels and the title land inside the drawing, offset by Vega's
    // layout origin as well as its padding.
    const labels = await large.evaluate(() => window.chartLabels);
    assert.equal(labels.status, "rendered", `${engine}: the labels chart`);
    assert.ok(labels.count >= 6, `${engine}: ${labels.count} texts`);
    assert.deepEqual(labels.outside, [], `${engine}: texts outside the SVG`);
    complete(
      `${engine}: the largest admitted chart draws through the Worker: ` +
        Object.entries(times)
          .map(([name, { ms }]) => `${name} ${ms} ms`)
          .join(", "),
    );
  } finally {
    await largeContext.close();
    if (instance !== browser) await instance.close();
  }
}

const figure = page.locator("figure.pages-chart");
const frame = figure.locator(".pages-chart-frame");
const bars = frame.locator("path[role='graphics-symbol']");
const tooltip = page.locator(".vg-tooltip.visible");
const barFills = () => bars.evaluateAll((paths) => paths.map((p) => p.getAttribute("fill")));

async function hoverBar(index) {
  const box = await bars.nth(index).boundingBox();
  await page.mouse.move(0, 0);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await expect(tooltip).toBeVisible();
}

try {
  await page.goto(origin, { waitUntil: "load" });
  await expect(page.locator("body[data-fixture=ready]")).toBeAttached();
  await expect(figure).toHaveAttribute("data-chart-status", "rendered");
  await expect(figure.locator(".pages-chart-title")).toHaveText("Tool calls by client");
  // Four tools, three clients; move_page has no Codex row: eleven segments.
  await expect(bars).toHaveCount(11);
  // Vega-Lite's own axes and legend.
  const drawn = (await frame.innerText()).split("\n");
  for (const label of ["Tool", "Calls", "Client", "ChatGPT", "Claude", "Codex", "read_page"])
    assert.ok(drawn.includes(label), `${label} in ${drawn}`);
  const border = await frame.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: style.borderTopWidth, radius: style.borderTopLeftRadius };
  });
  assert.deepEqual(border, { width: "1px", radius: "6px" });
  complete("Draws a stacked horizontal bar chart with its title above one thin rounded frame");

  await hoverBar(0);
  const tip = await tooltip.innerText();
  for (const field of ["Tool", "Client", "Calls"]) assert.match(tip, new RegExp(field));
  await page.screenshot({ path: path.join(output, "chart-light.png") });
  complete("Hovering a bar shows Vega's tooltip with the bar's fields (chart-light.png)");

  const lightFills = new Set(await barFills());
  await page.evaluate(() => {
    document.documentElement.classList.add("dark");
    document.documentElement.style.colorScheme = "dark";
  });
  await expect
    .poll(async () => (await barFills()).some((fill) => !lightFills.has(fill)))
    .toBe(true);
  await expect(figure).toHaveAttribute("data-chart-status", "rendered");
  await hoverBar(0);
  await page.screenshot({ path: path.join(output, "chart-dark.png") });
  complete("The dark theme redraws from the Page's tokens and keeps the tooltip (chart-dark.png)");

  await page.mouse.move(0, 0);
  await figure.locator(".wordgard-diagram-maximize").click();
  const dialog = page.locator("dialog.diagram-viewer");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".diagram-viewer-title")).toHaveText("Tool calls by client");
  await expect(dialog.locator("path[role='graphics-symbol']")).toHaveCount(11);
  await page.screenshot({ path: path.join(output, "chart-maximized-dark.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  complete("Maximize opens the chart in the diagram viewer, and Escape closes it");

  await page.setViewportSize({ width: 375, height: 760 });
  await expect
    .poll(() =>
      frame.evaluate((element) => {
        const svg = element.querySelector(".pages-chart-canvas svg");
        return svg.getBoundingClientRect().right <= element.getBoundingClientRect().right;
      }),
    )
    .toBe(true);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  assert.equal(overflow, false, "the page doesn't scroll sideways at phone width");
  await page.screenshot({ path: path.join(output, "chart-narrow-dark.png"), fullPage: true });
  complete("At phone width the chart redraws inside its frame (chart-narrow-dark.png)");

  const foreign = report.requests.filter((url) => !url.startsWith(origin));
  assert.deepEqual(foreign, []);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.csp, []);
  complete("No page errors, Content-Security-Policy refusals or requests off the fixture origin");

  for (const engine of engines) await globalsCheck(engine);
  for (const engine of engines) await escapeCheck(engine);
  for (const engine of engines) await hostileCheck(engine);
  for (const engine of engines) await freezeCheck(engine);
  for (const engine of engines) await metricsCheck(engine);
  for (const engine of engines) await largeCheck(engine);
} catch (error) {
  report.failure = error.stack || error.message;
  await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  server.close();
}
