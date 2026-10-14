import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LAYOUT, packageAssets, readProtocolVersion } from "../ci/package-notebook-cloud-assets.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HANDSHAKE = "crates/notebook-protocol/src/connection/handshake.rs";

function fixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "nc-fixture-"));
  const put = (rel, data) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), data);
  };
  put(HANDSHAKE, readFileSync(path.join(repo, HANDSHAKE)));
  put("LICENSE", "license\n");
  put("packages/runtimed/package.json", "{}\n");
  put("packages/runtimed/src/index.ts", "export {};\n");
  put("apps/notebook-cloud/dist/assets/notebook-cloud-viewer.js", "//viewer\n");
  put("apps/notebook-cloud/dist-output-document/index.html", "<html></html>\n");
  put("apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm", Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  put("apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm.js", "//glue\n");
  assert.ok(LAYOUT.length === 4);
  return root;
}

const opts = { version: "1.2.3-nightly.202601010000", channel: "nightly", sourceSha: "abc123", builtAt: "2026-01-01T00:00:00.000Z" };

test("manifest protocol_version equals PROTOCOL_VERSION in handshake.rs", () => {
  const source = readFileSync(path.join(repo, HANDSHAKE), "utf8");
  const declared = Number(/pub const PROTOCOL_VERSION: u8 = (\d+);/.exec(source)?.[1]);
  assert.ok(Number.isInteger(declared), "PROTOCOL_VERSION constant must stay greppable");
  assert.equal(readProtocolVersion(), declared);
  const { manifest } = packageAssets({ root: fixtureRoot(), outDir: mkdtempSync(path.join(tmpdir(), "nc-out-")), ...opts });
  assert.equal(manifest.protocol_version, declared);
});

test("tarball is reproducible and ships a sidecar", () => {
  const root = fixtureRoot();
  const a = packageAssets({ root, outDir: mkdtempSync(path.join(tmpdir(), "nc-a-")), ...opts });
  const b = packageAssets({ root, outDir: mkdtempSync(path.join(tmpdir(), "nc-b-")), ...opts });
  assert.deepEqual(readFileSync(a.tarball), readFileSync(b.tarball));
  assert.match(readFileSync(`${a.tarball}.sha256`, "utf8"), /^[0-9a-f]{64} {2}notebook-cloud-assets-nightly\.tar\.gz\n$/);
  assert.ok(Object.keys(a.manifest.files).includes("viewer/assets/notebook-cloud-viewer.js"));
  assert.ok(!("manifest.json" in a.manifest.files));
});

test("smoke script accepts a packaged tarball", { skip: spawnSync("sha256sum", ["--version"]).error ? "sha256sum unavailable" : false }, () => {
  const { tarball } = packageAssets({ root: fixtureRoot(), outDir: mkdtempSync(path.join(tmpdir(), "nc-s-")), ...opts });
  const r = spawnSync("bash", [path.join(repo, "scripts/ci/notebook-cloud-assets-smoke.sh"), tarball], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
