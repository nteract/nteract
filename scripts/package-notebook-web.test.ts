import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  NOTEBOOK_WEB_CHECKSUMS,
  NOTEBOOK_WEB_MANIFEST,
  packageNotebookWeb,
} from "./package-notebook-web.ts";

async function fixture(includeWasm = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nteract-notebook-web-"));
  const distDir = path.join(root, "dist");
  const outputDir = path.join(root, "artifact");
  await mkdir(path.join(distDir, "assets"), { recursive: true });
  await writeFile(path.join(distDir, "index.html"), "<main>notebook</main>");
  await writeFile(path.join(distDir, "assets", "main-AbCd1234.js"), "export {};");
  if (includeWasm) await writeFile(path.join(distDir, "assets", "runtime-ZyXw9876.wasm"), "wasm");
  return { distDir, outputDir };
}

test("packages a revision-pinned host artifact with deterministic checksums", async () => {
  const { distDir, outputDir } = await fixture();
  const manifest = await packageNotebookWeb({
    distDir,
    outputDir,
    sourceRevision: "abc1234",
    version: "0.4.3",
    channel: "nightly",
  });

  assert.equal(manifest.sourceRevision, "abc1234");
  assert.equal(manifest.runtimeCompatibility.rendererAssets, "embedded-in-runtimed");
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ["assets/main-AbCd1234.js", "assets/runtime-ZyXw9876.wasm", "index.html"],
  );
  assert.equal(
    JSON.parse(await readFile(path.join(outputDir, NOTEBOOK_WEB_MANIFEST), "utf8")).kind,
    "nteract-notebook-web",
  );
  const checksums = await readFile(path.join(outputDir, NOTEBOOK_WEB_CHECKSUMS), "utf8");
  assert.match(checksums, /notebook-web-manifest\.json/);
  assert.match(checksums, /runtime-ZyXw9876\.wasm/);
});

test("rejects a frontend build that omitted runtime WASM", async () => {
  const { distDir, outputDir } = await fixture(false);
  await assert.rejects(
    packageNotebookWeb({
      distDir,
      outputDir,
      sourceRevision: "abc1234",
      version: "0.4.3",
      channel: "nightly",
    }),
    /missing its generated runtime WASM/,
  );
});
