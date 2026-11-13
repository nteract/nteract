// Times the page's chart renderer on the largest legitimate charts the
// budgets admit and on adversarial paths, in Chromium, Firefox and WebKit,
// from drawScene to first paint. The path command budgets in
// viewer/chart-scene.mjs come from these numbers.
//
//   node scripts/chart-path-bench.mjs [case,case,...]
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, firefox, webkit } from "playwright";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(app, "test-results/chart-path-bench");
await mkdir(site, { recursive: true });
await build({
  entryPoints: { fixture: path.join(app, "scripts/fixtures/chart-path-bench-fixture.mjs") },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir: site,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "error",
});
await writeFile(
  path.join(site, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8" /><title>Path bench</title></head>
<body><div id="chart"></div><script type="module" src="/fixture.js"></script></body></html>`,
);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname;
  const file = path.join(site, name === "/" ? "index.html" : name);
  try {
    if (!file.startsWith(site)) throw new Error("outside");
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "text/plain" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(0);
const origin = `http://localhost:${server.address().port}`;

const cases = (process.argv[2] ?? "points,line,geoshape,lines,cubics,arcs,closes,moves").split(",");
const results = {};
for (const engine of [chromium, firefox, webkit]) {
  const browser = await engine.launch({ headless: true });
  for (const name of cases) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    let result;
    try {
      await page.goto(`${origin}/?case=${name}`, { waitUntil: "load" });
      await page
        .locator("body[data-fixture=ready]")
        .waitFor({ state: "attached", timeout: 120_000 });
      result = await page.evaluate(() => window.benched);
    } catch (error) {
      result = { error: `no answer: ${error.message.split("\n")[0]}` };
    }
    await page.close();
    (results[name] ??= {})[engine.name()] = result;
    console.log(engine.name(), name, JSON.stringify(result));
  }
  await browser.close();
}
server.close();
console.log(JSON.stringify(results));
