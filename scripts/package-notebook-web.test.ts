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
import {
  assertNotebookWebCompliance,
  buildSpdxDocument,
  buildThirdPartyNotices,
  collectShippedWebFiles,
  NOTEBOOK_WEB_LICENSE,
  NOTEBOOK_WEB_NOTICES,
  NOTEBOOK_WEB_SBOM,
  opaqueRendererAssetNames,
  type ComplianceComponent,
  type OpaqueRendererAsset,
} from "./notebook-web-compliance.ts";

const TEST_COMPONENT: ComplianceComponent = {
  ecosystem: "npm",
  name: "fixture-package",
  version: "1.0.0",
  licenseDeclared: "MIT",
  licenseTexts: [
    {
      name: "LICENSE",
      text: "MIT License\n\nCopyright (c) Fixture",
    },
  ],
};

const TEST_RENDERER_ASSETS: OpaqueRendererAsset[] = opaqueRendererAssetNames().map((name) => ({
  path: `apps/notebook/src/renderer-plugins/${name}`,
  bytes: 1,
  sha256: "0".repeat(64),
  components: ["nteract"],
}));

async function writeFixtureCompliance(outputDir: string): Promise<void> {
  const shippedWebFiles = await collectShippedWebFiles(outputDir);
  const spdx = buildSpdxDocument({
    components: [TEST_COMPONENT],
    opaqueRendererAssets: TEST_RENDERER_ASSETS,
    shippedWebFiles,
    sourceRevision: "abc1234",
    version: "0.4.3",
  });
  await Promise.all([
    writeFile(path.join(outputDir, NOTEBOOK_WEB_LICENSE), "BSD 3-Clause License\n"),
    writeFile(
      path.join(outputDir, NOTEBOOK_WEB_NOTICES),
      buildThirdPartyNotices([TEST_COMPONENT], TEST_RENDERER_ASSETS),
    ),
    writeFile(path.join(outputDir, NOTEBOOK_WEB_SBOM), `${JSON.stringify(spdx, null, 2)}\n`),
  ]);
}

async function fixture(includeWasm = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nteract-notebook-web-"));
  const distDir = path.join(root, "dist");
  const outputDir = path.join(root, "artifact");
  await mkdir(path.join(distDir, "assets"), { recursive: true });
  await writeFile(path.join(distDir, "index.html"), "<main>notebook</main>");
  await writeFile(path.join(distDir, "assets", "main-AbCd1234.js"), "export {};");
  await writeFile(path.join(distDir, "stats.html"), "/private/build/path");
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
    writeCompliance: writeFixtureCompliance,
  });

  assert.equal(manifest.sourceRevision, "abc1234");
  assert.equal(manifest.runtimeCompatibility.rendererAssets, "embedded-in-runtimed");
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    [
      "assets/main-AbCd1234.js",
      "assets/runtime-ZyXw9876.wasm",
      "index.html",
      "LICENSE",
      "notebook-web.spdx.json",
      "THIRD_PARTY_NOTICES.txt",
    ],
  );
  assert.equal(
    JSON.parse(await readFile(path.join(outputDir, NOTEBOOK_WEB_MANIFEST), "utf8")).kind,
    "nteract-notebook-web",
  );
  const checksums = await readFile(path.join(outputDir, NOTEBOOK_WEB_CHECKSUMS), "utf8");
  assert.match(checksums, /notebook-web-manifest\.json/);
  assert.match(checksums, /runtime-ZyXw9876\.wasm/);
  assert.match(checksums, /THIRD_PARTY_NOTICES\.txt/);
  await assert.rejects(readFile(path.join(outputDir, "stats.html"), "utf8"));
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
      writeCompliance: writeFixtureCompliance,
    }),
    /missing its generated runtime WASM/,
  );
});

test("rejects an SPDX document that omits a shipped web file", async () => {
  const { distDir, outputDir } = await fixture();
  await packageNotebookWeb({
    distDir,
    outputDir,
    sourceRevision: "abc1234",
    version: "0.4.3",
    channel: "nightly",
    writeCompliance: writeFixtureCompliance,
  });
  const sbomPath = path.join(outputDir, NOTEBOOK_WEB_SBOM);
  const sbom = JSON.parse(await readFile(sbomPath, "utf8")) as { files: unknown[] };
  sbom.files.pop();
  await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);

  await assert.rejects(
    assertNotebookWebCompliance(outputDir),
    /SPDX file provenance is incomplete/,
  );
});
