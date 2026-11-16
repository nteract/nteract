import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleOutputWorker } from "./build-output.mjs";
import { OUTPUT_FRAME_URL } from "../shared/anywidget-view.mjs";
import { OUTPUT_FRAME_PATH, OUTPUT_FRAME_PATHS } from "../shared/output-frame-paths.mjs";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_ID = "0123456789ab";

test("the viewer's default frame URL is a path the output Worker serves", () => {
  assert.ok(OUTPUT_FRAME_PATHS.includes(new URL(OUTPUT_FRAME_URL).pathname), OUTPUT_FRAME_URL);
  assert.ok(OUTPUT_FRAME_PATHS.includes(OUTPUT_FRAME_PATH));
  assert.deepEqual(OUTPUT_FRAME_PATHS, ["/frame/v2/"]);
});

test("the bundled output Worker is one deterministic module that names its build", async (t) => {
  const define = { __PAGES_BUILD__: JSON.stringify(BUILD_ID) };
  const first = await bundleOutputWorker(app, define);
  const second = await bundleOutputWorker(app, define);
  assert.deepEqual(Buffer.from(first), Buffer.from(second));
  const source = Buffer.from(first).toString("utf8");
  // Nothing machine-specific: no checkout path, home directory or temp path.
  for (const local of [app, os.homedir(), os.tmpdir()])
    assert.ok(!source.includes(local), `the bundle names ${local}`);
  assert.doesNotMatch(source, /^\s*import\b/m);

  const dir = mkdtempSync(path.join(os.tmpdir(), "pages-output-worker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "worker.js"), first);
  const { default: worker } = await import(pathToFileURL(path.join(dir, "worker.js")).href);

  const health = await worker.fetch(new Request("https://outputs.example/health"));
  assert.equal(health.status, 200);
  const text = await health.text();
  assert.ok(text.startsWith("pages-output-v2"));
  assert.equal(text, `pages-output-v2 ${BUILD_ID}`);
  for (const framePath of OUTPUT_FRAME_PATHS) {
    const frame = await worker.fetch(new Request(`https://outputs.example${framePath}`));
    assert.equal(frame.status, 200, framePath);
    assert.equal(frame.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(frame.headers.get("content-security-policy"), /^sandbox allow-scripts;/);
    assert.match(await frame.text(), /^<!doctype html>.*<main><\/main>/s);
  }
  assert.equal((await worker.fetch(new Request("https://outputs.example/frame/v1/"))).status, 404);
  assert.equal(
    (await worker.fetch(new Request("https://outputs.example/health", { method: "POST" }))).status,
    405,
  );
});

test("the output Worker run unbundled reports the bare version, with no build id", async () => {
  const { default: worker } = await import("../output/worker.mjs");
  const health = await worker.fetch(new Request("https://outputs.example/health"));
  assert.equal(await health.text(), "pages-output-v2");
});
