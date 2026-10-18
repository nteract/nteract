import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {fileURLToPath} from "node:url";
import {updatePnpmDepsHash} from "../ci/update-pnpm-deps-hash.mjs";

const packageHash = "sha256-K1Z6pmAmI4B4rC4KM77D/r1g6WKYeqxpdFbzGAgZsoc=";
const oldHash = "sha256-+6vWny6dQEB8NkN6EbV4wflBY+43mHSZ3tu7tG0pG3Q=";
const newHash = "sha256-7Pd6B5RYfvPqw0Ox75KmEeghJD/Vxh9nt41RcJkaCQA=";
const target = "/nix/store/272vb1j55xs69cmn8rhqwz65k460804p-nteract-desktop-js-pnpm-deps.drv";
const flake = `{
  pnpm_11 = pkgs.callPackage pnpmGeneric {
    version = "11.9.0";
    hash = "${packageHash}";
  };
  pnpmDeps = pkgs.fetchPnpmDeps {
    pname = "nteract-desktop-js";
    hash = "${oldHash}";
  };
}`;
function mismatch(derivation = target, specified = oldHash, actual = newHash) {
  return `error: hash mismatch in fixed-output derivation '${derivation}':
         specified: ${specified}
            got:    ${actual}
`;
}

test("updates only pnpmDeps and preserves the independent pnpm package hash", () => {
  const updated = updatePnpmDepsHash(flake, mismatch(), target);
  assert.equal(updated.hash, newHash);
  assert.equal(updated.source, flake.replace(oldHash, newHash));
  assert.ok(updated.source.includes(packageHash));
});

test("rejects a dependency mismatch even when its log contains a valid got hash", () => {
  assert.throws(() => updatePnpmDepsHash(flake, mismatch("/nix/store/dependency-pnpm-11.9.0.tgz.drv"), target), /evaluated pnpmDeps/);
});

test("rejects ambiguous mismatches and incomplete or malformed hash reports", () => {
  for (const log of [mismatch() + mismatch(), "got: " + newHash, mismatch().replace(newHash, "sha256-not-a-hash"), mismatch().replace("specified:", "expected:")]) {
    assert.throws(() => updatePnpmDepsHash(flake, log, target), /evaluated pnpmDeps/);
  }
});

test("handles ANSI styling without loosening the derivation identity check", () => {
  const log = mismatch().replace("error:", "\u001b[31merror:\u001b[0m");
  assert.equal(updatePnpmDepsHash(flake, log, target).source, flake.replace(oldHash, newHash));
});

test("rejects a stale build log or ambiguous flake definition", () => {
  for (const source of [flake.replace(oldHash, newHash), flake + flake, flake.replace(`    hash = "${oldHash}";`, `    hash = "${oldHash}";\n    hash = "${oldHash}";`)]) {
    assert.throws(() => updatePnpmDepsHash(source, mismatch(), target));
  }
});

test("CLI leaves the file unchanged for an unrelated dependency failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "nix-hash-update-"));
  try {
    const path = join(dir, "flake.nix");
    const log = join(dir, "build.log");
    writeFileSync(path, flake);
    writeFileSync(log, mismatch("/nix/store/dependency.drv"));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../ci/update-pnpm-deps-hash.mjs", import.meta.url)), path, log, target], {encoding: "utf8"});
    assert.equal(result.status, 1);
    assert.equal(readFileSync(path, "utf8"), flake);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test("PR Nix validation cannot update or push hashes", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/nix.yml", import.meta.url), "utf8");
  const validation = workflow.split("  validate:\n")[1]?.split("  update-hashes:\n")[0];
  assert.ok(validation, "read-only PR job must exist");
  assert.match(validation, /github.event_name == 'pull_request'/);
  assert.match(validation, /contents: read/);
  assert.match(validation, /persist-credentials: false/);
  assert.match(validation, /nix build .*pnpm-toolchain .*pnpmDeps/);
  assert.doesNotMatch(validation, /git push|gh pr|contents: write|pull-requests: write/);
  const updater = workflow.split("  update-hashes:\n")[1];
  assert.match(updater, /github.event_name == 'push' \|\| github.event_name == 'workflow_dispatch'/);
  assert.match(updater, /nix eval --raw .#pnpmDeps.drvPath/);
  assert.match(updater, /node scripts\/ci\/update-pnpm-deps-hash.mjs/);
  assert.doesNotMatch(updater, /sed -i|awk '\/\^\[\[:space:\]\]\*got:/);
});
