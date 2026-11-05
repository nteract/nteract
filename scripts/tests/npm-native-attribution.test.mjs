import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {test} from "node:test";
import {ATTRIBUTION_FILES, RUST_TARGETS, generateAttribution, verifyAttribution} from "../../packages/runtimed-node/scripts/package-attribution.mjs";

const commit = "a".repeat(40);
const version = "0.7.0-nightly.100";
const binary = Buffer.from([0, 1, 2, 255]);
const hash = createHash("sha256").update(binary).digest("hex");

function fixture(t, target = "linux-x64-gnu") {
  const directory = mkdtempSync(join(tmpdir(), "native-attribution-"));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const manifest = {
    name: `@runtimed/node-${target}`, version, nteractRelease: {sourceSha: commit},
    files: [`runtimed-node.${target}.node`, ...ATTRIBUTION_FILES],
  };
  const sbom = {
    bomFormat: "CycloneDX", specVersion: "1.6", version: 1,
    metadata: {
      component: {type: "application", name: "runtimed-node", version, hashes: [{alg: "SHA-256", content: hash}]},
      properties: [{name: "nteract:source-commit", value: commit}, {name: "nteract:target", value: RUST_TARGETS[target]}],
    },
    components: [{type: "library", name: "binding-dependency", version: "1.0.0"}],
  };
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(directory, "sbom.cdx.json"), JSON.stringify(sbom));
  writeFileSync(join(directory, "LICENSE.nteract"), "project license\n");
  writeFileSync(join(directory, "THIRD_PARTY_NOTICES.txt"), "binding dependency licenses\n");
  writeFileSync(join(directory, `runtimed-node.${target}.node`), binary);
  return {directory, manifest, sbom, identity: {target, version, commit}};
}

for (const target of Object.keys(RUST_TARGETS)) {
  test(`${target} native pnpm pack includes all attribution bytes`, t => {
    const {directory, identity} = fixture(t, target);
    verifyAttribution(directory, identity);
    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    execFileSync(pnpm, ["pack", "--json"], {cwd: directory, stdio: "pipe"});
    const tarball = `runtimed-node-${target}-${version}.tgz`;
    const listing = execFileSync("tar", ["-tzf", tarball], {cwd: directory, encoding: "utf8"});
    for (const name of ATTRIBUTION_FILES) {
      assert.ok(listing.split("\n").includes(`package/${name}`));
      const packed = execFileSync("tar", ["-xOf", tarball, `package/${name}`], {cwd: directory});
      assert.deepEqual(packed, readFileSync(join(directory, name)));
    }
    execFileSync("tar", ["-xzf", tarball], {cwd: directory});
    verifyAttribution(join(directory, "package"), identity);
  });
}

for (const name of ATTRIBUTION_FILES) {
  test(`native pack rejects missing, empty, invalid and symlinked ${name}`, t => {
    const {directory, identity} = fixture(t);
    const path = join(directory, name);
    for (const bytes of [Buffer.alloc(0), Buffer.from(" \n"), Buffer.from([255]), Buffer.from("\0")]) {
      writeFileSync(path, bytes);
      assert.throws(() => verifyAttribution(directory, identity));
    }
    rmSync(path);
    assert.throws(() => verifyAttribution(directory, identity));
    symlinkSync(join(directory, "package.json"), path);
    assert.throws(() => verifyAttribution(directory, identity), /regular file/);
  });
}

for (const field of ["source", "target", "version", "hash", "kind", "components", "format"]) {
  test(`native attribution rejects mismatched ${field}`, t => {
    const {directory, sbom, identity} = fixture(t);
    if (field === "source") sbom.metadata.properties[0].value = "b".repeat(40);
    if (field === "target") sbom.metadata.properties[1].value = "aarch64-apple-darwin";
    if (field === "version") sbom.metadata.component.version = "0.0.0";
    if (field === "hash") sbom.metadata.component.hashes[0].content = "0".repeat(64);
    if (field === "kind") sbom.metadata.component.name = "runtimed";
    if (field === "components") sbom.components = [];
    if (field === "format") sbom.bomFormat = "SPDX";
    writeFileSync(join(directory, "sbom.cdx.json"), JSON.stringify(sbom));
    assert.throws(() => verifyAttribution(directory, identity), /SBOM does not match/);
  });
}

test("native attribution rejects stripped pack allowlist and mutated binary", t => {
  const {directory, manifest, identity} = fixture(t);
  writeFileSync(join(directory, "runtimed-node.linux-x64-gnu.node"), "different binary");
  assert.throws(() => verifyAttribution(directory, identity), /SBOM does not match/);
  writeFileSync(join(directory, "runtimed-node.linux-x64-gnu.node"), binary);
  manifest.files = ["*.node"];
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  assert.throws(() => verifyAttribution(directory, identity), /files must include/);
  assert.throws(() => verifyAttribution(directory, {...identity, target: "unknown"}), /Unsupported native/);
});

test("generator runs on the exact checkout and forwards only binding target identity", t => {
  const {directory, sbom} = fixture(t);
  execFileSync("git", ["init", "-q", directory]);
  const sourceCommit = execFileSync("git", ["hash-object", "-t", "commit", "--stdin", "-w"], {
    cwd: directory, input: "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor Test <test@example.com> 0 +0000\ncommitter Test <test@example.com> 0 +0000\n\nfixture\n", encoding: "utf8",
  }).trim();
  execFileSync("git", ["update-ref", "HEAD", sourceCommit], {cwd: directory});
  const platform = join(directory, "packages/runtimed-node/npm/linux-x64-gnu");
  mkdirSync(platform, {recursive: true});
  for (const name of ["package.json", "runtimed-node.linux-x64-gnu.node"]) copyFileSync(join(directory, name), join(platform, name));
  const manifest = JSON.parse(readFileSync(join(platform, "package.json"), "utf8"));
  manifest.files = ["runtimed-node.linux-x64-gnu.node"];
  manifest.nteractRelease.sourceSha = sourceCommit;
  writeFileSync(join(platform, "package.json"), JSON.stringify(manifest));
  sbom.metadata.properties[0].value = sourceCommit;
  const script = join(directory, "scripts/release-attribution.mjs");
  mkdirSync(dirname(script));
  writeFileSync(script, [
    'import {writeFileSync} from "node:fs";',
    'import {join} from "node:path";',
    'const args = process.argv.slice(2);',
    'writeFileSync("args.json", JSON.stringify(args));',
    'const output = args[args.indexOf("--output") + 1];',
    `const files = ${JSON.stringify({"LICENSE.nteract": "project license", "THIRD_PARTY_NOTICES.txt": "native notices", "sbom.cdx.json": JSON.stringify(sbom)})};`,
    'for (const [name, text] of Object.entries(files)) writeFileSync(join(output, name), text);',
  ].join("\n"));
  generateAttribution(directory, "linux-x64-gnu", version, sourceCommit);
  const args = JSON.parse(readFileSync(join(directory, "args.json"), "utf8"));
  assert.deepEqual(args, ["--kind", "runtimed-node", "--target", "x86_64-unknown-linux-gnu", "--output", platform,
    "--version", version, "--commit", sourceCommit, "--binary", join(platform, "runtimed-node.linux-x64-gnu.node")]);
  assert.throws(() => generateAttribution(directory, "linux-x64-gnu", version, commit), /built release checkout SHA/);
  const cli = fileURLToPath(new URL("../../packages/runtimed-node/scripts/package-attribution.mjs", import.meta.url));
  execFileSync(process.execPath, [cli, "verify", "linux-x64-gnu", version, sourceCommit, platform]);
});
