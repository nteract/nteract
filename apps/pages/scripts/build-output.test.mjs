import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  bootstrapSha256,
  bundleOutputWorker,
  frameRuntimeText,
  writeFrameHtml,
} from "./build-output.mjs";
import { BOOTSTRAP_HTML, BOOTSTRAP_SCRIPT, RUNTIME_ENTRY } from "@nteract/output-frame/bootstrap";
import { OUTPUT_FRAME_URL } from "../shared/anywidget-view.mjs";
import { OUTPUT_FRAME_PATH, OUTPUT_FRAME_PATHS } from "../shared/output-frame-paths.mjs";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_ID = "0123456789ab";

test("the viewer's default frame URL is a path the output Worker serves", () => {
  assert.ok(OUTPUT_FRAME_PATHS.includes(new URL(OUTPUT_FRAME_URL).pathname), OUTPUT_FRAME_URL);
  assert.ok(OUTPUT_FRAME_PATHS.includes(OUTPUT_FRAME_PATH));
  assert.deepEqual(OUTPUT_FRAME_PATHS, ["/frame/v2/"]);
});

const FRAME_CACHE = "public, max-age=86400, no-transform";
// Every response's headers but Content-Type and Cache-Control, which differ
// between the bootstrap and the other answers. The frame CSP, in full.
const COMMON_HEADERS = {
  "content-security-policy": [
    "sandbox allow-scripts",
    "default-src 'none'",
    "script-src 'unsafe-inline' 'wasm-unsafe-eval' https: blob:",
    "style-src 'unsafe-inline' https:",
    "connect-src *",
    "img-src * data: blob:",
    "media-src * data: blob:",
    "font-src https: data:",
    "worker-src blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};
const headersOf = (response) => Object.fromEntries(response.headers);

test("the output Worker serves the bootstrap at the frame path and nothing at others", async () => {
  await writeFrameHtml(app);
  const { default: worker } = await import("../output/worker.mjs");
  for (const method of ["GET", "HEAD"]) {
    const frame = await worker.fetch(
      new Request(`https://outputs.example${OUTPUT_FRAME_PATH}`, { method }),
    );
    assert.equal(frame.status, 200);
    assert.deepEqual(headersOf(frame), {
      ...COMMON_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "cache-control": FRAME_CACHE,
    });
    assert.equal(await frame.text(), method === "HEAD" ? "" : BOOTSTRAP_HTML);
  }
  for (const missing of ["/frame/v1/", "/frame/v9/", "/frame/v2", "/frame/v2/x", "/"]) {
    const response = await worker.fetch(new Request(`https://outputs.example${missing}`));
    assert.equal(response.status, 404, missing);
    assert.deepEqual(headersOf(response), {
      ...COMMON_HEADERS,
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store, no-transform",
    });
  }
  const health = await worker.fetch(new Request("https://outputs.example/health"));
  assert.equal(health.headers.get("cache-control"), "no-store, no-transform");
  assert.equal(
    (
      await worker.fetch(
        new Request(`https://outputs.example${OUTPUT_FRAME_PATH}`, { method: "POST" }),
      )
    ).status,
    405,
  );
});

test("the bootstrap's recorded sha256 is the sha256 of its script", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pages-frame-html-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await writeFrameHtml(dir);
  const { FRAME_HTML, FRAME_BOOTSTRAP_SHA256 } = await import(
    pathToFileURL(path.join(dir, ".output-dist/frame-html.mjs")).href
  );
  assert.equal(FRAME_HTML, BOOTSTRAP_HTML);
  assert.equal(FRAME_BOOTSTRAP_SHA256, createHash("sha256").update(BOOTSTRAP_SCRIPT).digest("hex"));
  assert.equal(FRAME_BOOTSTRAP_SHA256, bootstrapSha256());
  // What an installer reads back from a served document (deployment/install.mjs).
  const served = /<script>([\s\S]*?)<\/script>/.exec(FRAME_HTML)[1];
  assert.equal(createHash("sha256").update(served).digest("hex"), FRAME_BOOTSTRAP_SHA256);
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
  const bundled = await import(pathToFileURL(path.join(dir, "worker.js")).href);
  // workerd refuses an entry module that exports anything but handlers.
  assert.deepEqual(Object.keys(bundled), ["default"]);
  const worker = bundled.default;

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
    assert.equal(await frame.text(), BOOTSTRAP_HTML);
  }
  assert.equal((await worker.fetch(new Request("https://outputs.example/frame/v1/"))).status, 404);
  assert.equal(
    (await worker.fetch(new Request("https://outputs.example/health", { method: "POST" }))).status,
    405,
  );
});

test("the frame runtime the viewer sends is one strict classic script with its stylesheet", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pages-frame-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await writeFrameHtml(dir);
  const { FRAME_RUNTIME } = await import(
    pathToFileURL(path.join(dir, ".output-dist/frame-runtime.mjs")).href
  );
  assert.equal(FRAME_RUNTIME, await frameRuntimeText());
  // An import map appended at mount applies only while no module has loaded,
  // so the runtime is never a module.
  assert.match(FRAME_RUNTIME, /^"use strict";/);
  assert.doesNotMatch(FRAME_RUNTIME, /import\.meta|^\s*(import|export)\b/m);
  assert.match(FRAME_RUNTIME, /\bimport\(/, "dynamic import() stays a real dynamic import");
  assert.ok(FRAME_RUNTIME.includes(RUNTIME_ENTRY), "it defines the bootstrap's entry point");
  assert.ok(FRAME_RUNTIME.includes("--background"), "it carries styles.css");
});

test("the output Worker run unbundled reports the bare version, with no build id", async () => {
  const { default: worker } = await import("../output/worker.mjs");
  const health = await worker.fetch(new Request("https://outputs.example/health"));
  assert.equal(await health.text(), "pages-output-v2");
});
