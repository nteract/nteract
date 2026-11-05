import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectMsvcRuntime, collectRustReport, mergeComponents, nativeMaterial, parseArgs, pinnedMsvcMaterial, renderRelease } from "../release-attribution.mjs";

const identity = { kind: "notebook-ui", target: "wasm32-unknown-unknown", version: "2.9.0-nightly.1", commit: "a".repeat(40) };
const component = (name, properties = []) => ({ type: "library", "bom-ref": `pkg:cargo/${name}@1.0.0`, name, version: "1.0.0", purl: `pkg:cargo/${name}@1.0.0`, licenses: [{ expression: "MIT" }], properties });
const fixture = () => ({ ownLicense: "BSD 3-Clause License\nCopyright nteract\n", rust: { components: [component("test")], materials: [{ title: "test", text: "MIT material" }] }, npm: { components: [], notices: "npm license material" } });

test("CLI validates target, identity, required and duplicate arguments", () => {
  const args = Object.entries({ ...identity, output: "out" }).flatMap(([key, value]) => [`--${key}`, value]);
  assert.deepEqual(parseArgs(args), { ...identity, output: "out" });
  for (const [key, value] of [["kind", "other"], ["target", "x86_64-unknown-linux-gnu"], ["target", "--bad"], ["version", "2.0\ninjected"], ["commit", "abc"], ["commit", "z".repeat(40)]]) {
    assert.throws(() => parseArgs(Object.entries({ ...identity, [key]: value, output: "out" }).flatMap(([k, v]) => [`--${k}`, v])));
  }
  assert.throws(() => parseArgs(args.concat("--output", "again")), /duplicate/);
  assert.throws(() => parseArgs(args.concat("--unexpected", "value")), /Invalid/);
  assert.throws(() => parseArgs(args.slice(0, -2)), /output/);
  assert.throws(() => parseArgs(["--kind", "runtimed", "--target", "wasm32-unknown-unknown", "--version", "1.0.0", "--commit", identity.commit, "--output", "out"]), /native/);
});

test("merge is deterministic and unions roots without duplicate bom-refs", () => {
  const a = component("shared", [{ name: "nteract:cargo-root", value: "sift-wasm" }]);
  const b = component("shared", [{ name: "nteract:cargo-root", value: "runtimed" }]);
  assert.deepEqual(mergeComponents([a, component("z")], [b]), mergeComponents([b], [component("z"), a]));
  assert.equal(mergeComponents([a, b, a]).length, 1);
  assert.equal(mergeComponents([a, b])[0].properties.length, 2);
  assert.throws(() => mergeComponents([a, { ...b, version: "2.0.0" }]), /Conflicting version/);
  assert.throws(() => mergeComponents([a, { ...b, licenses: [{ expression: "Apache-2.0" }] }]), /Conflicting licenses/);
});

test("Cargo selected license groups choose permissive alternatives in SBOM", () => {
  const pkg = { name: "alternatives", version: "1.0.0", id: "alternatives", source: null };
  for (const [declared, selected] of [["Apache-2.0 OR GPL-2.0-only", "Apache-2.0"], ["MIT OR LGPL-3.0-only", "MIT"]]) {
    const data = collectRustReport({ crates: [{ package: pkg, license: declared }], licenses: [{ id: selected, text: `${selected} text`, used_by: [{ crate: pkg }] }] }, { root: "test", target: identity.target });
    assert.deepEqual(data.components[0].licenses, [{ expression: selected }]);
    assert.ok(data.components[0].properties.some((p) => p.name === "nteract:declared-license" && p.value === declared));
  }
});

test("SBOM has CycloneDX 1.6 identity, source, selected licenses and binary hash", () => {
  const data = fixture();
  const bytes = Buffer.from("the exact shipped binary");
  const outputs = renderRelease(identity, { ...data, binary: bytes });
  const sbom = JSON.parse(outputs["sbom.cdx.json"]);
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.6");
  assert.equal(sbom.version, 1);
  assert.equal(sbom.metadata.component.version, identity.version);
  assert.deepEqual(sbom.metadata.component.hashes, [{ alg: "SHA-256", content: createHash("sha256").update(bytes).digest("hex") }]);
  assert.ok(sbom.metadata.properties.some((p) => p.value === identity.commit));
  assert.ok(sbom.metadata.properties.some((p) => p.value === identity.target));
  assert.match(outputs["THIRD_PARTY_NOTICES.txt"], /Conservative resolved dependency inventory/);
  assert.match(outputs["THIRD_PARTY_NOTICES.txt"], /Copyright nteract/);
  assert.equal(outputs["LICENSE.nteract"], data.ownLicense);
  assert.equal(JSON.parse(renderRelease(identity, data)["sbom.cdx.json"]).metadata.component.hashes, undefined);
});

test("rendered inventory and notices are deterministic across graph order", () => {
  const first = fixture();
  first.rust.components.push(component("second"));
  first.rust.materials.push({ title: "second", text: "MIT material" }, { title: "other", text: "BSD material" });
  const second = structuredClone(first);
  second.rust.components.reverse();
  second.rust.materials.reverse();
  assert.deepEqual(renderRelease(identity, first), renderRelease(identity, second));
});

test("missing license material fails rather than creating partial notices", () => {
  for (const change of [(data) => { data.ownLicense = ""; }, (data) => { data.npm.notices = ""; }, (data) => { data.rust.materials[0].text = ""; }]) {
    const data = fixture();
    change(data);
    assert.throws(() => renderRelease(identity, data), /Missing/);
  }
  assert.throws(() => collectRustReport({ crates: [], licenses: [] }, { root: "test" }), /Empty/);
  const pkg = { name: "test", version: "1.0.0", id: "test", source: null };
  assert.throws(() => collectRustReport({ crates: [{ package: pkg }], licenses: [{ id: "MIT", text: "MIT", used_by: [{ crate: { ...pkg, id: "other" } }] }] }, { root: "test", target: identity.target }), /Missing selected license/);
});

test("native reviews fail for unknown sources, upgrades and missing required files", (t) => {
  const root = mkdtempSync(join(tmpdir(), "release-attribution-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = { name: "unknown-native", version: "1.0.0", manifest_path: join(root, "Cargo.toml") };
  writeFileSync(join(root, "native.c"), "int native(void) { return 0; }");
  assert.throws(() => nativeMaterial(pkg), /Unreviewed native/);
  assert.throws(() => nativeMaterial({ ...pkg, name: "zstd-sys", version: "99.0.0" }), /Unreviewed native/);
  assert.throws(() => nativeMaterial({ ...pkg, name: "zstd-sys", version: "2.0.16+zstd.1.5.7" }), /ENOENT/);
  mkdirSync(join(root, "zstd"));
  writeFileSync(join(root, "zstd/LICENSE"), "BSD C library license");
  const material = nativeMaterial({ ...pkg, name: "zstd-sys", version: "2.0.16+zstd.1.5.7" });
  assert.equal(material[0].expression, "BSD-3-Clause");
  assert.throws(() => nativeMaterial({ ...pkg, name: "nix", version: "0.31.2" }), /Unreviewed native source/);
});

test("MPL source notice uses exact registry archive and selected licenses", (t) => {
  const root = mkdtempSync(join(tmpdir(), "release-mpl-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "LICENSE"), "Mozilla license text");
  const pkg = { name: "option-ext", version: "0.2.0", id: "option-ext", source: "registry+https://github.com/rust-lang/crates.io-index", manifest_path: join(root, "Cargo.toml") };
  const data = collectRustReport({ crates: [{ package: pkg, license: "MPL-2.0" }], licenses: [{ id: "MPL-2.0", text: "Mozilla license text", used_by: [{ crate: pkg }] }] }, { root: "runtimed", target: "aarch64-apple-darwin" });
  assert.deepEqual(data.components[0].licenses, [{ expression: "MPL-2.0" }]);
  assert.ok(data.materials.some((m) => m.text.includes("https://static.crates.io/crates/option-ext/option-ext-0.2.0.crate")));
});

test("AWS-LC requires compound and nested license material", (t) => {
  const root = mkdtempSync(join(tmpdir(), "release-aws-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "aws-lc/third_party/fiat"), { recursive: true });
  for (const path of ["LICENSE", "aws-lc/LICENSE"]) writeFileSync(join(root, path), "AWS-LC compound license text");
  const pkg = { name: "aws-lc-sys", version: "0.47.0", manifest_path: join(root, "Cargo.toml") };
  assert.throws(() => nativeMaterial(pkg), /ENOENT/);
  writeFileSync(join(root, "aws-lc/third_party/fiat/LICENSE"), "Fiat cryptography license");
  const material = nativeMaterial(pkg);
  assert.equal(material.length, 3);
  assert.ok(material.every((m) => m.expression.includes("ISC AND Apache-2.0 AND MIT AND BSD-3-Clause")));
});

test("SQLite public-domain source declaration is required separately from bindings", (t) => {
  const root = mkdtempSync(join(tmpdir(), "release-sqlite-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "sqlite3"));
  mkdirSync(join(root, "sqlcipher"));
  writeFileSync(join(root, "sqlcipher/LICENSE"), "SQLCipher license");
  writeFileSync(join(root, "sqlite3/sqlite3.c"), "no declaration");
  const pkg = { name: "libsqlite3-sys", version: "0.30.1", manifest_path: join(root, "Cargo.toml") };
  assert.throws(() => nativeMaterial(pkg), /Missing SQLite public-domain declaration/);
  writeFileSync(join(root, "sqlite3/sqlite3.c"), "** The author disclaims copyright to this source code.\n** May you share freely, never taking more than you give.");
  const material = nativeMaterial(pkg);
  assert.ok(material.some((m) => m.text.includes("SQLite is public domain, not the MIT license of its Rust bindings")));
});

test("Node binding validates native target and requires its binary, not npm material", () => {
  const options = { ...identity, kind: "runtimed-node", target: "aarch64-apple-darwin" };
  const data = fixture();
  delete data.npm;
  assert.throws(() => renderRelease(options, data), /requires --binary/);
  const binary = Buffer.from("node binding bytes");
  const outputs = renderRelease(options, { ...data, binary });
  const sbom = JSON.parse(outputs["sbom.cdx.json"]);
  assert.equal(sbom.metadata.component.name, "runtimed-node");
  assert.equal(sbom.metadata.component.hashes[0].content, createHash("sha256").update(binary).digest("hex"));
  assert.doesNotMatch(outputs["THIRD_PARTY_NOTICES.txt"], /BUNDLED NPM MATERIAL/);
  assert.throws(() => renderRelease({ ...options, target: "wasm32-unknown-unknown" }, { ...data, binary }), /native/);
  assert.throws(() => renderRelease(options, { ...fixture(), binary }), /must not include npm/);
});

test("Node CLI generates without npm collector and requests only native runtimed-node graph", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "release-node-cli-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "share/doc/rust/licenses"), { recursive: true });
  writeFileSync(join(root, "scripts/release-attribution.mjs"), readFileSync(new URL("../release-attribution.mjs", import.meta.url)));
  writeFileSync(join(root, "LICENSE"), "First-party BSD license");
  writeFileSync(join(root, "share/doc/rust/COPYRIGHT-library.html"), "Standard library attribution");
  for (const name of ["MIT", "Apache-2.0"]) writeFileSync(join(root, `share/doc/rust/licenses/${name}.txt`), `${name} standard library material`);
  writeFileSync(join(root, "binding.node"), "binary bytes");
  const pkg = { name: "runtimed-node", version: "0.8.0", id: "node", source: null };
  const report = { crates: [{ package: pkg, license: "BSD-3-Clause" }], licenses: [{ id: "BSD-3-Clause", text: "BSD license", used_by: [{ crate: pkg }] }] };
  writeFileSync(join(root, "bin/cargo"), `#!${process.execPath}\nimport fs from 'node:fs'; if(process.argv.includes('--version')) console.log('cargo-about 0.9.2'); else { fs.appendFileSync(${JSON.stringify(join(root, "cargo-args.jsonl"))}, JSON.stringify(process.argv.slice(2))+'\\n'); console.log(${JSON.stringify(JSON.stringify(report))}); }`, { mode: 0o755 });
  writeFileSync(join(root, "bin/rustc"), `#!${process.execPath}\nif(process.argv.includes('target-list')) console.log('aarch64-apple-darwin'); else if(process.argv.includes('sysroot')) console.log(${JSON.stringify(root)}); else console.log('release: 1.99.1\\ncommit-hash: ${"b".repeat(40)}');`, { mode: 0o755 });
  const output = join(root, "output");
  execFileSync(process.execPath, [join(root, "scripts/release-attribution.mjs"), "--kind", "runtimed-node", "--target", "aarch64-apple-darwin", "--version", "0.8.0", "--commit", identity.commit, "--binary", join(root, "binding.node"), "--output", output], { env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` } });
  const calls = readFileSync(join(root, "cargo-args.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(join(root, "crates/runtimed-node/Cargo.toml")));
  assert.ok(calls[0].includes("aarch64-apple-darwin"));
  const sbom = JSON.parse(readFileSync(join(output, "sbom.cdx.json"), "utf8"));
  assert.deepEqual(sbom.components.map((c) => c.name).sort(), ["runtimed-node", "rust-standard-library"].sort());
  const notices = readFileSync(join(output, "THIRD_PARTY_NOTICES.txt"), "utf8");
  assert.match(notices, /Standard library attribution/);
  assert.match(notices, /First-party BSD license/);
  assert.doesNotMatch(notices, /BUNDLED NPM MATERIAL|sift-wasm|runtimed-wasm/);
});

test("MSVC runtime requires producer evidence only for Windows MSVC targets", () => {
  assert.deepEqual(collectMsvcRuntime({ target: "aarch64-apple-darwin" }, {}), { components: [], materials: [] });
  assert.deepEqual(collectMsvcRuntime({ target: "wasm32-unknown-unknown" }, {}), { components: [], materials: [] });
  assert.throws(() => collectMsvcRuntime({ target: "x86_64-pc-windows-msvc" }, {}), /action required: missing producer VCToolsInstallDir/);
});

test("MSVC records exact proprietary CRT/SDK producer inputs and license evidence", (t) => {
  const root = mkdtempSync(join(tmpdir(), "release-msvc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = join(root, "VS/VC/Tools/MSVC/14.44.35207");
  const sdk = join(root, "Windows Kits/10");
  const sdkVersion = "10.0.26100.0";
  const vcLib = join(tools, "lib/x64");
  const ucrtLib = join(sdk, "Lib", sdkVersion, "ucrt/x64");
  const compiler = join(tools, "bin/Hostx64/x64/cl.exe");
  for (const path of [vcLib, ucrtLib, join(tools, "bin/Hostx64/x64"), join(sdk, "Licenses", sdkVersion)]) mkdirSync(path, { recursive: true });
  writeFileSync(compiler, "compiler bytes");
  for (const file of [join(vcLib, "libcmt.lib"), join(vcLib, "libvcruntime.lib"), join(ucrtLib, "libucrt.lib")]) writeFileSync(file, "runtime library bytes");
  writeFileSync(join(root, "VS/License.txt"), "Microsoft Visual Studio Enterprise 2022 license terms. Distributable Code.");
  const sdkLicense = join(sdk, "Licenses", sdkVersion, "SDKLicense.txt");
  writeFileSync(sdkLicense, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Microsoft Windows Software Development Kit license terms. Distributable Code.", "utf16le")]));
  const env = { VSINSTALLDIR: join(root, "VS"), VCToolsInstallDir: tools, VCToolsVersion: "14.44.35207", WindowsSdkDir: sdk, UCRTVersion: sdkVersion, VSCMD_ARG_TGT_ARCH: "x64", LIB: `${vcLib};${ucrtLib}` };
  const run = (command) => command === "where.exe" ? compiler : JSON.stringify([{ installationPath: env.VSINSTALLDIR, installationVersion: "17.14.37824.6", productId: "Microsoft.VisualStudio.Product.Enterprise", isPrerelease: false }]);
  const options = { target: "x86_64-pc-windows-msvc" };
  const result = collectMsvcRuntime(options, env, run);
  assert.equal(result.components.length, 2);
  assert.ok(result.components.every((c) => c.licenses[0].license.name.includes("proprietary")));
  assert.equal(result.components[0].version, env.VCToolsVersion);
  assert.equal(result.components[1].version, sdkVersion);
  assert.ok(result.components[0].properties.some((p) => p.name === "nteract:compiler-sha256" && /^[a-f0-9]{64}$/.test(p.value)));
  assert.ok(result.materials.some((m) => m.text.includes("No independent license grant")));
  assert.ok(result.materials.some((m) => m.text.includes("Windows Software Development Kit license terms")));
  assert.throws(() => collectMsvcRuntime(options, { ...env, VCToolsVersion: "14.99.12345" }, run), /versions do not match/);
  assert.throws(() => collectMsvcRuntime(options, { ...env, VSCMD_ARG_TGT_ARCH: "arm64" }, run), /architecture/);
  assert.throws(() => collectMsvcRuntime(options, { ...env, NTERACT_MSVC_LICENSE_FILE: join(root, "missing") }, run), /cannot locate/);
  assert.throws(() => collectMsvcRuntime(options, { ...env, LIB: ucrtLib }, run), /libcmt.lib LIB resolution/);
  const structured = join(root, "structured.txt");
  for (const text of ["{\\rtf1 Microsoft Windows SDK license Distributable\\line Code}", "<html>Microsoft Windows SDK license Distributable Code</html>"]) {
    writeFileSync(structured, text);
    assert.throws(() => collectMsvcRuntime(options, { ...env, NTERACT_WINDOWS_SDK_LICENSE_FILE: structured }, run), /convert structured.*plain text/);
  }
  writeFileSync(join(root, "VS/License.txt"), "Microsoft Visual Studio Community 2022 license terms. Distributable Code.");
  assert.throws(() => collectMsvcRuntime(options, { ...env, NTERACT_MSVC_LICENSE_FILE: join(root, "VS/License.txt") }, run), /license text for this product/);
  writeFileSync(join(root, "VS/License.txt"), "Microsoft Visual Studio Enterprise 2022 license terms. Distributable Code.");
  rmSync(sdkLicense);
  assert.throws(() => collectMsvcRuntime(options, env, run), /cannot locate Windows SDK/);
  rmSync(join(root, "VS/License.txt"));
  const officialRun = (command) => command === "powershell.exe" ? JSON.stringify([{ DisplayName: "Windows Software Development Kit - Windows 10.0.26100.7705", DisplayVersion: "10.1.26100.7705" }]) : run(command);
  const fallback = collectMsvcRuntime(options, env, officialRun);
  assert.ok(fallback.materials.some((m) => m.text.includes("VS_EntPro_2022_ENU.1033")));
  assert.ok(fallback.materials.some((m) => m.text.includes("WIN10SDK.RTM.AUG_2018_en-US")));
  assert.ok(fallback.materials.some((m) => m.text.includes("Microsoft.Windows.SDK.CPP.x64")));
  assert.ok(fallback.materials.some((m) => m.text.includes("Original source SHA-256:")));
  const futureSdk = (command) => command === "powershell.exe" ? JSON.stringify([{ DisplayName: "Windows Software Development Kit", DisplayVersion: "10.1.26100.9999" }]) : run(command);
  assert.throws(() => collectMsvcRuntime(options, env, futureSdk), /cannot locate Windows SDK/);
  const futureVs = (command) => command === "where.exe" ? compiler : JSON.stringify([{ installationPath: env.VSINSTALLDIR, installationVersion: "18.0.10000.1", productId: "Microsoft.VisualStudio.Product.Enterprise" }]);
  assert.throws(() => collectMsvcRuntime(options, env, futureVs), /cannot locate Visual Studio 2026/);
});

test("pinned official Microsoft terms require reviewed content hashes", (t) => {
  assert.match(pinnedMsvcMaterial("vs2022").text, /DISTRIBUTABLE CODE/);
  assert.match(pinnedMsvcMaterial("sdk").text, /Distributable Code/);
  const directory = mkdtempSync(join(tmpdir(), "msvc-pin-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "msvc-provenance.json"), readFileSync(new URL("../licenses/msvc-provenance.json", import.meta.url)));
  writeFileSync(join(directory, "msvc-sdk.txt"), "modified Microsoft license");
  assert.throws(() => pinnedMsvcMaterial("sdk", directory), /digest mismatch/);
});
