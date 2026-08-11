import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSpdxDocument,
  buildThirdPartyNotices,
  collectOpaqueRendererAssets,
  opaqueRendererAssetNames,
  validateLicenseExpression,
  type ComplianceComponent,
} from "./notebook-web-compliance.ts";

const COMPONENT: ComplianceComponent = {
  ecosystem: "cargo",
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
  await mkdir(rendererRoot, { recursive: true });
  await Promise.all(
    opaqueRendererAssetNames().map((name) =>
      writeFile(path.join(rendererRoot, name), `release payload for ${name}`),
    ),
  );

  const assets = await collectOpaqueRendererAssets(repoRoot);
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
});

test("rejects unknown licenses and incomplete opaque renderer provenance", async () => {
  assert.throws(() => validateLicenseExpression("GPL-3.0-only"), /unknown license expression/);

  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "nteract-compliance-missing-"));
  await mkdir(path.join(repoRoot, "apps/notebook/src/renderer-plugins"), { recursive: true });
  await assert.rejects(collectOpaqueRendererAssets(repoRoot), /Missing opaque renderer asset/);
});
