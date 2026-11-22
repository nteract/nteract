import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import worker from "../worker/index.mjs";
import { CHECK_VIEW_PATH } from "../agent-check-view.mjs";

const execFileAsync = promisify(execFile);
const origin = "https://pages.example";
const env = {
  NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
  get DB() {
    throw Error("Public check-view route must not touch account storage");
  },
  get ASSETS() {
    throw Error("Public check-view route must not fall through to the app shell");
  },
};

async function fetchServedScript() {
  const response = await worker.fetch(new Request(origin + CHECK_VIEW_PATH), env);
  assert.equal(response.status, 200);
  return response.text();
}

async function runChecker(scriptPath, args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, ...args], {
      timeout: 15_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
    };
  }
}

test("/llms/check-view.mjs is served publicly with JS headers and HEAD/405 semantics", async () => {
  const res = await worker.fetch(new Request(origin + CHECK_VIEW_PATH), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
  assert.equal(
    res.headers.get("link"),
    `</llms/check-view.mjs>; rel="self"; type="text/javascript", </llms.txt>; rel="index"; type="text/plain"`,
  );
  const body = await res.text();
  assert.ok(body.startsWith("#!/usr/bin/env node\n"));

  const head = await worker.fetch(new Request(origin + CHECK_VIEW_PATH, { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("content-type"), "text/javascript; charset=utf-8");

  const post = await worker.fetch(
    new Request(origin + CHECK_VIEW_PATH, { method: "POST", body: "ignored" }),
    env,
  );
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
});

test("served check-view.mjs runs a complete module view with data, imports, canvas, rAF, theme switch, and cleanup", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pages-check-view-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const checker = path.join(dir, "check-view.mjs");
  writeFileSync(checker, await fetchServedScript());
  writeFileSync(path.join(dir, "rows.csv"), "name,count,active\nalpha,10,true\nbeta,20,false\n");
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ title: "Demo" }));
  writeFileSync(path.join(dir, "pixels.bin"), Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]));
  writeFileSync(path.join(dir, "table.parquet"), Buffer.from("PAR1abcdPAR1"));
  writeFileSync(
    path.join(dir, "helper.js"),
    `import meta from "data/meta";
     export async function readTitle() { return (await meta.json()).title; }`,
  );
  writeFileSync(
    path.join(dir, "entry.js"),
    `import { readTitle } from "my-helper";
     import * as Plot from "@observablehq/plot";
     export async function render({ model, el, signal, host }) {
       const title = await readTitle();
       const rows = await model.get("rows").csv({ typed: true });
       if (rows.length !== 2 || rows[0].count !== 10 || rows[0].active !== true)
         throw new Error("Unexpected CSV parse: " + JSON.stringify(rows));
       if (rows.columns.join(",") !== "name,count,active")
         throw new Error("Missing CSV columns");
       const slice = await model.get("pixels").slice(0, 4).arrayBuffer();
       if (slice.byteLength !== 4) throw new Error("Bad slice size");
       const pq = await model.get("pq").parquet();
       if (typeof pq.toArray !== "function") throw new Error("Bad parquet table");
       const root = document.createElement("div");
       root.innerHTML = '<div class="wrap"><h2 data-role="title"></h2><canvas width="16" height="16"></canvas></div>';
       root.querySelector('[data-role="title"]').textContent = title;
       const ctx = root.querySelector("canvas").getContext("2d");
       const img = ctx.createImageData(2, 1);
       ctx.putImageData(img, 0, 0);
       Plot.plot({ marks: [] });
       el.replaceChildren(root);
       let themes = [host.getContext().theme];
       const unsub = host.onContextChange((next) => themes.push(next.theme));
       let raf = requestAnimationFrame(() => {
         if (signal.aborted) return;
         raf = requestAnimationFrame(() => {});
       });
       const onResize = () => {};
       window.addEventListener("resize", onResize);
       return () => {
         unsub();
         cancelAnimationFrame(raf);
         window.removeEventListener("resize", onResize);
         if (themes.length < 2) throw new Error("Theme switch never fired");
       };
     }`,
  );

  const res = await runChecker(checker, [
    path.join(dir, "entry.js"),
    "--data",
    `rows=${path.join(dir, "rows.csv")}`,
    "--data",
    `meta=${path.join(dir, "meta.json")}`,
    "--data",
    `pixels=${path.join(dir, "pixels.bin")}`,
    "--data",
    `pq=${path.join(dir, "table.parquet")}`,
    "--import",
    `my-helper=${path.join(dir, "helper.js")}`,
    "--json",
  ]);
  assert.equal(res.code, 0, res.stderr + res.stdout);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.framesStepped, 1);
  assert.equal(report.themeSwitched, true);
  assert.equal(report.cleanedUp, true);
  assert.deepEqual(report.warnings, []);
});

test("check-view.mjs catches ReferenceError, broken DOM selector, bad imports, CSP violations, and bad file options", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pages-check-view-fail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checker = path.join(dir, "check-view.mjs");
  writeFileSync(checker, await fetchServedScript());
  writeFileSync(path.join(dir, "rows.csv"), "a,b\n1,2\n");

  // 1. ReferenceError inside render (e.g. typo syncUI vs syncHUD)
  const undefFile = path.join(dir, "undef.js");
  writeFileSync(undefFile, `export function render({ el }) { el.textContent = "hi"; syncUI(); }`);
  const r1 = await runChecker(checker, [undefFile]);
  assert.equal(r1.code, 1);
  assert.match(r1.stderr, /syncUI is not defined/);

  // 2. Broken DOM selector returning null
  const nullDom = path.join(dir, "null-dom.js");
  writeFileSync(
    nullDom,
    `export function render({ el }) {
       const root = document.createElement("div");
       root.innerHTML = '<button data-act="play">Play</button>';
       el.append(root);
       root.querySelector('[data-act="typo"]').addEventListener("click", () => {});
     }`,
  );
  const r2 = await runChecker(checker, [nullDom]);
  assert.equal(r2.code, 1);
  assert.match(r2.stderr, /Cannot read properties of null/);

  // 3. Disallowed relative import and unmapped subpath
  const badImport = path.join(dir, "bad-import.js");
  writeFileSync(
    badImport,
    `import x from "./sibling.js";\nimport y from "d3/array";\nexport function render({ el }) { el.textContent = x + y; }`,
  );
  const r3 = await runChecker(checker, [badImport]);
  assert.equal(r3.code, 1);
  assert.match(r3.stderr, /\.\/sibling\.js/);
  assert.match(r3.stderr, /d3\/array/);

  // 4. CSP-blocked eval() and fetch("data:...")
  const evalFile = path.join(dir, "eval.js");
  writeFileSync(evalFile, `export function render({ el }) { el.textContent = eval("1+1"); }`);
  const r4 = await runChecker(checker, [evalFile]);
  assert.equal(r4.code, 1);
  assert.match(r4.stderr, /CSP violation/);

  const fetchData = path.join(dir, "fetch-data.js");
  writeFileSync(
    fetchData,
    `export async function render({ el }) { await fetch("data:text/plain,hi"); el.textContent = "ok"; }`,
  );
  const r5 = await runChecker(checker, [fetchData]);
  assert.equal(r5.code, 1);
  assert.match(r5.stderr, /Pages CSP blocks fetch/);

  // 5. Invalid csv({ typed: false }) option matching output-frame/file-object.mjs
  const badCsv = path.join(dir, "bad-csv.js");
  writeFileSync(
    badCsv,
    `export async function render({ model, el }) { await model.get("rows").csv({ typed: false }); el.textContent = "ok"; }`,
  );
  const r6 = await runChecker(checker, [badCsv, "--data", `rows=${path.join(dir, "rows.csv")}`]);
  assert.equal(r6.code, 1);
  assert.match(r6.stderr, /typed option must be true/);

  // 6. Missing render / default export
  const noExport = path.join(dir, "no-export.js");
  writeFileSync(noExport, `function render({ el }) { el.textContent = "oops"; }`);
  const r7 = await runChecker(checker, [noExport]);
  assert.equal(r7.code, 1);
  assert.match(r7.stderr, /Export render/);
});

test("check-view.mjs warns on leaked rAF/listeners and supports --anywidget mode", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pages-check-view-warn-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checker = path.join(dir, "check-view.mjs");
  writeFileSync(checker, await fetchServedScript());

  const leaky = path.join(dir, "leaky.js");
  writeFileSync(
    leaky,
    `export function render({ el }) {
       el.textContent = "running";
       window.addEventListener("keydown", () => {});
       requestAnimationFrame(function tick() { requestAnimationFrame(tick); });
     }`,
  );
  const rLeak = await runChecker(checker, [leaky, "--json"]);
  assert.equal(rLeak.code, 0, rLeak.stderr);
  const leakReport = JSON.parse(rLeak.stdout);
  assert.ok(leakReport.warnings.some((w) => /requestAnimationFrame/.test(w)));
  assert.ok(leakReport.warnings.some((w) => /window event listener/.test(w)));

  const widget = path.join(dir, "counter.js");
  writeFileSync(path.join(dir, "clip.wav"), Buffer.from("RIFF1234"));
  writeFileSync(
    widget,
    `export default {
       render({ model, el, signal }) {
         const btn = document.createElement("button");
         const bytes = model.get("clip");
         if (!(bytes instanceof DataView) || bytes.byteLength !== 8)
           throw new Error("Expected DataView buffer");
         const update = () => { btn.textContent = "Count: " + model.get("count"); };
         model.on("change:count", update);
         btn.addEventListener("click", () => { model.set("count", model.get("count") + 1); model.save_changes(); }, { signal });
         update();
         btn.click();
         if (btn.textContent !== "Count: 1") throw new Error("Model update failed");
         el.append(btn);
         return () => { model.off("change:count", update); btn.remove(); };
       }
     };`,
  );
  const rWidget = await runChecker(checker, [
    widget,
    "--anywidget",
    "--state",
    '{"count":0}',
    "--data",
    `clip=${path.join(dir, "clip.wav")}`,
    "--json",
  ]);
  assert.equal(rWidget.code, 0, rWidget.stderr + rWidget.stdout);
  assert.equal(JSON.parse(rWidget.stdout).ok, true);
});
