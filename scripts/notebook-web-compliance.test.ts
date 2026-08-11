import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertRequiredNotebookNpmComponents,
  buildSpdxDocument,
  buildThirdPartyNotices,
  collectOpaqueRendererAssets,
  NOTEBOOK_WEB_BUILD_PROVENANCE,
  opaqueRendererAssetNames,
  pnpmExecutable,
  requiredNotebookNpmComponents,
  validateLicenseExpression,
  type ComplianceComponent,
} from "./notebook-web-compliance.ts";

const COMPONENT: ComplianceComponent = {
  ecosystem: "cargo",
  scope: "runtime",
  name: "fixture-crate",
  version: "1.2.3",
  licenseDeclared: "MIT OR Apache-2.0",
  licenseTexts: [
    {
      name: "LICENSE-MIT",
      text: "MIT License\nCopyright (c) Fixture",
    },
  ],
};

test("builds deterministic SPDX and notice documents with renderer provenance", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "nteract-compliance-"));
  const rendererRoot = path.join(repoRoot, "apps/notebook/src/renderer-plugins");
  const outputDir = path.join(repoRoot, "dist");
  await mkdir(rendererRoot, { recursive: true });
  await mkdir(path.join(outputDir, "assets"), { recursive: true });
  await Promise.all(
    opaqueRendererAssetNames().map((name) =>
      writeFile(path.join(rendererRoot, name), `release payload for ${name}`),
    ),
  );
  const outputPayload = "generated renderer chunk";
  const outputSha256 = createHash("sha256").update(outputPayload).digest("hex");
  await writeFile(path.join(outputDir, "assets/renderer-fixture.js"), outputPayload);
  await writeFile(
    path.join(outputDir, NOTEBOOK_WEB_BUILD_PROVENANCE),
    `${JSON.stringify({
      schemaVersion: 1,
      inputs: opaqueRendererAssetNames().map((name) => {
        const source = `release payload for ${name}`;
        return {
          path: `apps/notebook/src/renderer-plugins/${name}`,
          sha256: createHash("sha256").update(source).digest("hex"),
          outputs: [{ path: "assets/renderer-fixture.js", sha256: outputSha256 }],
        };
      }),
    })}\n`,
  );

  const assets = await collectOpaqueRendererAssets(repoRoot, outputDir);
  const first = buildSpdxDocument({
    components: [COMPONENT],
    opaqueRendererAssets: assets,
    shippedWebFiles: [
      { path: "assets/main-fixture.js", bytes: 7, sha1: "0".repeat(40), sha256: "0".repeat(64) },
      {
        path: "assets/runtime-fixture.wasm",
        bytes: 8,
        sha1: "1".repeat(40),
        sha256: "1".repeat(64),
      },
    ],
    sourceRevision: "abc1234",
    version: "1.0.0",
  });
  const second = buildSpdxDocument({
    components: [COMPONENT],
    opaqueRendererAssets: assets,
    shippedWebFiles: [
      { path: "assets/main-fixture.js", bytes: 7, sha1: "0".repeat(40), sha256: "0".repeat(64) },
      {
        path: "assets/runtime-fixture.wasm",
        bytes: 8,
        sha1: "1".repeat(40),
        sha256: "1".repeat(64),
      },
    ],
    sourceRevision: "abc1234",
    version: "1.0.0",
  });

  assert.deepEqual(first, second);
  assert.equal(first.packages[1]?.licenseDeclared, "MIT OR Apache-2.0");
  assert.equal(first.files.length, 2);
  assert.match(first.annotations[0]?.comment ?? "", /plotly\.js/);
  assert.match(buildThirdPartyNotices([COMPONENT], assets), /fixture-crate@1\.2\.3/);

  await writeFile(path.join(rendererRoot, "plotly.js"), "stale renderer source");
  await assert.rejects(
    collectOpaqueRendererAssets(repoRoot, outputDir),
    /renderer build provenance is stale or missing/,
  );
  await writeFile(path.join(rendererRoot, "plotly.js"), "release payload for plotly.js");
  await writeFile(path.join(outputDir, "assets/renderer-fixture.js"), "stale renderer chunk");
  await assert.rejects(
    collectOpaqueRendererAssets(repoRoot, outputDir),
    /renderer output provenance is stale/,
  );
});

test("rejects unknown licenses and incomplete opaque renderer provenance", async () => {
  assert.throws(() => validateLicenseExpression("GPL-3.0-only"), /unknown license expression/);
  for (const malformed of ["MIT OR", "MIT AND", "MIT OR OR Apache-2.0", "(MIT OR Apache-2.0"]) {
    assert.throws(() => validateLicenseExpression(malformed), /Invalid SPDX license expression/);
  }

  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "nteract-compliance-missing-"));
  const outputDir = path.join(repoRoot, "dist");
  await mkdir(path.join(repoRoot, "apps/notebook/src/renderer-plugins"), { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, NOTEBOOK_WEB_BUILD_PROVENANCE),
    '{"schemaVersion":1,"inputs":[]}',
  );
  await assert.rejects(
    collectOpaqueRendererAssets(repoRoot, outputDir),
    /Missing opaque renderer asset/,
  );
});

test("fails closed when any required notebook or renderer component is omitted", () => {
  const required = [...requiredNotebookNpmComponents()];
  assert.doesNotThrow(() => assertRequiredNotebookNpmComponents(required));
  for (const omitted of required) {
    assert.throws(
      () => assertRequiredNotebookNpmComponents(required.filter((name) => name !== omitted)),
      (error: unknown) => error instanceof Error && error.message.includes(omitted),
    );
  }
});

test("uses the Windows pnpm command shim when required", () => {
  assert.equal(pnpmExecutable("win32"), "pnpm.cmd");
  assert.equal(pnpmExecutable("darwin"), "pnpm");
});
