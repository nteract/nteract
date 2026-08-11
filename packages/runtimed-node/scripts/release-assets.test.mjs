import assert from "node:assert/strict";
import test from "node:test";

import { buildReleaseManifest, releaseAssetName, releaseManifestName } from "./release-assets.mjs";

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
