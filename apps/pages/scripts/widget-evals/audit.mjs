import path from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { outputDir, origin, session } from "./shared.mjs";
import { grade } from "./grade.mjs";
const cohort = process.argv[2];
if (!cohort || !/^[-\w.]+$/.test(cohort) || cohort === "." || cohort === "..")
  throw Error("Supply the cohort name");
const root = path.join(outputDir, "runs", cohort);
const { browser, page, client } = await session();
const catalogOrigin = "http://127.0.0.1:" + (process.env.PAGES_CATALOG_PORT ?? "9447");
let blocked;
try {
  await page.route(/^https?:/, (route) => {
    const u = new URL(route.request().url());
    if ([origin, catalogOrigin].includes(u.origin)) return route.continue();
    blocked.add(u.hostname);
    return route.abort();
  });
  await page.addInitScript(() => {
    const native = Document.prototype.createElementNS;
    const traces = new WeakMap();
    window.__chartTraces = traces;
    Document.prototype.createElementNS = function (...args) {
      const element = native.apply(this, args);
      if (args[1] === "svg") traces.set(element, new Error().stack);
      return element;
    };
  });
  for (const name of (await readdir(root)).sort()) {
    const target = path.join(root, name);
    let r;
    try {
      r = JSON.parse(await readFile(path.join(target, "result.json"), "utf8"));
    } catch (e) {
      if (["ENOENT", "ENOTDIR"].includes(e.code)) continue;
      throw e;
    }
    if (r.origin && r.origin !== origin)
      throw Error("Run the audit against the original eval host: " + r.origin);
    blocked = new Set();
    const local = await grade(page, origin + "/p/" + r.page_id);
    const authoredWithPlot =
      local.ready &&
      (await page
        .frameLocator(".pages-anywidget-view iframe")
        .first()
        .locator("svg")
        .evaluateAll((svgs) =>
          svgs.some((el) => window.__chartTraces.get(el)?.includes("/observablehq-plot.js:")),
        ));
    const audit = {
      local,
      authoredWithPlot,
      blockedHosts: [...blocked],
      pass: local.initial && local.filtered && local.restored && authoredWithPlot,
    };
    await writeFile(path.join(target, "audit.json"), JSON.stringify(audit, null, 2));
    console.log(name, audit.pass, blocked.size ? [...blocked].join(",") : "");
  }
} finally {
  await client.close();
  await browser.close();
}
