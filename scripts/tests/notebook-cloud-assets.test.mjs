import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { LAYOUT, packageAssets, readProtocolVersion, splitUstarPath } from "../ci/package-notebook-cloud-assets.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HANDSHAKE = "crates/notebook-protocol/src/connection/handshake.rs";
const PACKAGER = path.join(repo, "scripts/ci/package-notebook-cloud-assets.mjs");
const SMOKE = path.join(repo, "scripts/ci/notebook-cloud-assets-smoke.sh");

// A fixture tree with every LAYOUT and single-file source present. The
// handshake constant is a fixture value, not the repository's, so a packager
// that hard-coded protocol_version would fail the drift test below.
function fixtureRoot({ protocolVersion = 99, extraFiles = [] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "nc-fixture-"));
  const put = (rel, data) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), data);
  };
  put(HANDSHAKE, `// fixture\npub const PROTOCOL_VERSION: u8 = ${protocolVersion};\n`);
  put("LICENSE", "license\n");
  put("packages/runtimed/package.json", "{}\n");
  put("packages/runtimed/src/index.ts", "export {};\n");
  put("apps/notebook-cloud/dist/assets/notebook-cloud-viewer.js", "//viewer\n");
  put("apps/notebook-cloud/dist/assets/notebook-cloud-viewer.css", "/* css */\n");
  put("apps/notebook-cloud/dist/assets/runtimed_wasm_bg.0123abcd.wasm", Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  put("apps/notebook-cloud/dist-output-document/index.html", "<html></html>\n");
  put("apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm_bg.wasm", Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  put("apps/notebook/src/wasm/runtimed-wasm/runtimed_wasm.js", "//glue\n");
  for (const [rel, data] of extraFiles) put(rel, data);
  assert.equal(LAYOUT.length, 4);
  return root;
}

const outDir = (label) => mkdtempSync(path.join(tmpdir(), `nc-${label}-`));
const opts = { version: "1.2.3-nightly.202601010000", channel: "nightly", sourceSha: "abc123", builtAt: "2026-01-01T00:00:00Z" };

// Minimal ustar reader: enough to recover entry paths and sizes from the
// archive this packager writes, independent of the host tar.
function listTarEntries(tarball) {
  const tar = gunzipSync(readFileSync(tarball));
  const field = (buf, start, len) => buf.subarray(start, start + len).toString("utf8").replace(/\0.*$/s, "");
  const entries = [];
  for (let offset = 0; offset < tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(field(header, 124, 12), 8);
    const prefix = field(header, 345, 155);
    const name = field(header, 0, 100);
    assert.equal(field(header, 257, 6), "ustar", "magic");
    assert.equal(field(header, 136, 12), "00000000000", "mtime is zero");
    assert.equal(field(header, 108, 8), "0000000", "uid is zero");
    entries.push({ path: prefix ? `${prefix}/${name}` : name, size });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test("manifest protocol_version is read from handshake.rs, not hard-coded", () => {
  const source = readFileSync(path.join(repo, HANDSHAKE), "utf8");
  const declared = Number(/pub const PROTOCOL_VERSION: u8 = (\d+);/.exec(source)?.[1]);
  assert.ok(Number.isInteger(declared), "PROTOCOL_VERSION constant must stay greppable in the repository");
  assert.equal(readProtocolVersion(), declared, "repository constant round-trips");

  for (const protocolVersion of [7, 250]) {
    const { manifest } = packageAssets({ root: fixtureRoot({ protocolVersion }), outDir: outDir("pv"), ...opts });
    assert.equal(manifest.protocol_version, protocolVersion);
  }
});

test("tarball is reproducible and ships a sidecar", () => {
  const root = fixtureRoot();
  const a = packageAssets({ root, outDir: outDir("a"), ...opts });
  const b = packageAssets({ root, outDir: outDir("b"), ...opts });
  assert.deepEqual(readFileSync(a.tarball), readFileSync(b.tarball));
  assert.match(readFileSync(`${a.tarball}.sha256`, "utf8"), /^[0-9a-f]{64} {2}notebook-cloud-assets-nightly\.tar\.gz\n$/);
  assert.ok(Object.keys(a.manifest.files).includes("viewer/assets/notebook-cloud-viewer.js"));
  assert.ok(!("manifest.json" in a.manifest.files));
  assert.equal(a.manifest.built_at, "2026-01-01T00:00:00.000Z", "built_at is the normalized input, not the clock");

  // gzip header: MTIME (bytes 4-7) is zero and OS (byte 9) is pinned to Unix.
  const gz = readFileSync(a.tarball);
  assert.deepEqual([...gz.subarray(4, 8)], [0, 0, 0, 0]);
  assert.equal(gz[9], 3);

  const paths = listTarEntries(a.tarball).map((e) => e.path);
  assert.deepEqual(paths, [...paths].sort(), "entries are sorted");
  assert.deepEqual(new Set(paths), new Set([...Object.keys(a.manifest.files), "manifest.json"]));
});

test("built_at is required and must be a date-time", () => {
  assert.throws(() => packageAssets({ root: fixtureRoot(), outDir: outDir("nb"), ...opts, builtAt: undefined }), /built_at/);
  assert.throws(() => packageAssets({ root: fixtureRoot(), outDir: outDir("bb"), ...opts, builtAt: "yesterday" }), /built_at/);

  const root = fixtureRoot();
  const cli = (...extra) =>
    spawnSync(process.execPath, [PACKAGER, `--out=${outDir("cli")}`, "--version=1.0.0", "--channel=stable", "--source-sha=deadbeef", ...extra], {
      cwd: root,
      encoding: "utf8",
    });
  const missing = cli();
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /--built-at=ISO-8601/);
});

test("ustar paths split by byte length and round-trip through the host tar", () => {
  // 148-byte prefix + 73-byte name: needs the prefix field, and only the
  // right-most slash gives a split where both halves fit.
  const ascii = `viewer/${"a".repeat(80)}/${"b".repeat(60)}/${"c".repeat(70)}.js`;
  assert.ok(Buffer.byteLength(ascii) > 100, "fixture exceeds the name field");
  const split = splitUstarPath(ascii);
  assert.equal(Buffer.byteLength(split.prefix), 148);
  assert.ok(Buffer.byteLength(split.prefix) <= 155 && Buffer.byteLength(split.base) <= 100);
  assert.equal(`${split.prefix}/${split.base}`, ascii);

  // Two-byte characters: the right-most slash gives an 84-character prefix
  // that is 160 bytes, so the split must fall back to the earlier slash.
  const wide = `viewer/${"é".repeat(40)}/${"é".repeat(36)}/x.js`;
  const wideSplit = splitUstarPath(wide);
  assert.equal(wideSplit.prefix, `viewer/${"é".repeat(40)}`);
  assert.ok(Buffer.byteLength(wideSplit.base) <= 100);
  assert.equal(`${wideSplit.prefix}/${wideSplit.base}`, wide);
  // No split fits: 157-byte prefix, or a 155-byte name.
  assert.throws(() => splitUstarPath(`viewer/${"é".repeat(75)}/x.js`), /too long for ustar/);
  assert.throws(() => splitUstarPath(`${"z".repeat(160)}/${"y".repeat(120)}`), /too long for ustar/);

  const root = fixtureRoot({ extraFiles: [[`apps/notebook-cloud/dist/${ascii.slice("viewer/".length)}`, "long\n"]] });
  const { tarball } = packageAssets({ root, outDir: outDir("long"), ...opts });
  assert.ok(listTarEntries(tarball).some((e) => e.path === ascii && e.size === 5));
  const listing = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.ok(listing.stdout.split("\n").includes(ascii), `host tar lists the split path:\n${listing.stdout}`);
});

test("smoke script accepts a packaged tarball", { skip: spawnSync("sha256sum", ["--version"]).error ? "sha256sum unavailable" : false }, () => {
  const { tarball } = packageAssets({ root: fixtureRoot(), outDir: outDir("smoke"), ...opts });
  const r = spawnSync("bash", [SMOKE, tarball], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /served 5 probes/, r.stdout);
});

test("smoke script rejects a tampered file", { skip: spawnSync("sha256sum", ["--version"]).error ? "sha256sum unavailable" : false }, () => {
  const { tarball } = packageAssets({ root: fixtureRoot(), outDir: outDir("tamper"), ...opts });
  // Repack with one file changed but keep the original sidecar: the sidecar
  // check must fail before the manifest check runs.
  const sidecar = readFileSync(`${tarball}.sha256`);
  const root = fixtureRoot({ extraFiles: [["LICENSE", "tampered\n"]] });
  const tampered = packageAssets({ root, outDir: outDir("tamper2"), ...opts });
  writeFileSync(`${tampered.tarball}.sha256`, sidecar);
  const r = spawnSync("bash", [SMOKE, tampered.tarball], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
});
