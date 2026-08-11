import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildReleaseManifest,
  extractArchive,
  nodeApiVersionFromCargoManifest,
  packWrapperReleaseAsset,
  releaseAssetName,
  releaseManifestName,
} from "./release-assets.mjs";

const releaseVersion = "2.6.3-nightly.202608110900";
const sourceRevision = "0123456789abcdef0123456789abcdef01234567";

test("release asset names use the nteract release version", () => {
  assert.equal(
    releaseAssetName("wrapper", releaseVersion),
    "runtimed-node-wrapper-2.6.3-nightly.202608110900.tgz",
  );
  assert.equal(
    releaseAssetName("darwin-x64", releaseVersion),
    "runtimed-node-darwin-x64-2.6.3-nightly.202608110900.tgz",
  );
  assert.equal(
    releaseManifestName(releaseVersion),
    "runtimed-node-assets-2.6.3-nightly.202608110900.json",
  );
});

test("release manifest carries source and npm package identities", () => {
  const manifest = buildReleaseManifest({
    releaseVersion,
    sourceRevision,
    packageVersion: "0.4.3",
  });

  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.release_version, releaseVersion);
  assert.equal(manifest.source_revision, sourceRevision);
  assert.equal(manifest.binding_source_revision, sourceRevision.slice(0, 7));
  assert.equal(manifest.npm_package_version, "0.4.3");
  assert.equal(manifest.node_api_version, 9);
  assert.deepEqual(Object.keys(manifest.platforms), [
    "darwin-arm64",
    "darwin-x64",
    "linux-x64-gnu",
    "win32-x64-msvc",
  ]);
  assert.equal(
    manifest.platforms["win32-x64-msvc"].asset,
    `runtimed-node-win32-x64-msvc-${releaseVersion}.tgz`,
  );
});

test("a Node host can consume the manifest compatibility fields", () => {
  const manifest = JSON.parse(
    JSON.stringify(
      buildReleaseManifest({
        releaseVersion,
        sourceRevision,
        packageVersion: "0.4.3",
      }),
    ),
  );
  const hostNodeApiVersion = Number(process.versions.napi);

  assert.ok(Number.isInteger(hostNodeApiVersion));
  assert.ok(hostNodeApiVersion >= manifest.node_api_version);
  assert.equal(manifest.binding_source_revision, manifest.source_revision.slice(0, 7));
});

test("release version and source revision are validated", () => {
  assert.throws(() => releaseAssetName("wrapper", "../unsafe"), /release-safe token/);
  assert.throws(
    () =>
      buildReleaseManifest({
        releaseVersion,
        sourceRevision: "short",
        packageVersion: "0.4.3",
      }),
    /full lowercase Git commit SHA/,
  );
});

test("manifest Node-API minimum follows the native crate feature", () => {
  const root = mkdtempSync(join(tmpdir(), "runtimed-node-api-version-"));
  try {
    const manifest = join(root, "Cargo.toml");
    writeFileSync(
      manifest,
      'napi = { version = "3", default-features = false, features = ["napi9", "async"] }\n',
    );
    assert.equal(nodeApiVersionFromCargoManifest(manifest), 9);
    writeFileSync(manifest, 'napi = { version = "3", features = ["async"] }\n');
    assert.throws(() => nodeApiVersionFromCargoManifest(manifest), /exactly one napiN feature/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper release archives are byte reproducible", () => {
  const root = mkdtempSync(join(tmpdir(), "runtimed-node-wrapper-reproducibility-"));
  try {
    const firstDirectory = join(root, "first");
    const secondDirectory = join(root, "second");
    mkdirSync(firstDirectory);
    mkdirSync(secondDirectory);
    const first = packWrapperReleaseAsset({ outputDir: firstDirectory });
    const second = packWrapperReleaseAsset({ outputDir: secondDirectory });
    const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
    assert.equal(digest(first), digest(second));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("archives extract through relative paths when directories contain spaces", () => {
  const root = mkdtempSync(join(tmpdir(), "runtimed node archive paths "));
  try {
    const packageDirectory = join(root, "source", "package");
    const archive = join(root, "release archive.tgz");
    const destination = join(root, "destination with spaces");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "fixture.txt"), "release fixture\n");
    const packed = spawnSync("tar", ["-czf", "release archive.tgz", "-C", "source", "package"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(packed.status, 0, packed.stderr || packed.stdout);

    extractArchive(archive, destination);

    assert.equal(readFileSync(join(destination, "fixture.txt"), "utf8"), "release fixture\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
