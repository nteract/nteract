import {readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {stripVTControlCharacters} from "node:util";

const sri = "sha256-[A-Za-z0-9+/]{43}=";

export function updatePnpmDepsHash(source, log, expectedDerivation) {
  const cleanLog = stripVTControlCharacters(log);
  const mismatches = [...cleanLog.matchAll(new RegExp(
    `^error: hash mismatch in fixed-output derivation '([^'\\n]+)':\\s*\\n\\s*specified:\\s*(${sri})\\s*\\n\\s*got:\\s*(${sri})\\s*$`,
    "gm",
  ))];
  if (mismatches.length !== 1 ||
      [...cleanLog.matchAll(/hash mismatch in fixed-output derivation/g)].length !== 1 ||
      mismatches[0][1] !== expectedDerivation) {
    throw new Error("Expected one hash mismatch for the evaluated pnpmDeps derivation; refusing to update flake.nix");
  }
  const [, , specified, actual] = mismatches[0];
  const blocks = [...source.matchAll(/^([ \t]*pnpmDeps = pkgs\.fetchPnpmDeps \{\n)([\s\S]*?)(^[ \t]*\};)/gm)];
  if (blocks.length !== 1) throw new Error("Expected exactly one pnpmDeps fetchPnpmDeps block");
  const block = blocks[0];
  const hashes = [...block[2].matchAll(new RegExp(`^([ \\t]*hash[ \\t]*=[ \\t]*")(${sri})(";[ \\t]*)$`, "gm"))];
  if (hashes.length !== 1 || hashes[0][2] !== specified) {
    throw new Error("The pnpmDeps hash does not match the failed build; refusing to update flake.nix");
  }
  const hash = hashes[0];
  const start = block.index + block[1].length + hash.index + hash[1].length;
  return {
    source: source.slice(0, start) + actual + source.slice(start + specified.length),
    hash: actual,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const [flakePath, logPath, expectedDerivation, ...extra] = process.argv.slice(2);
    if (!flakePath || !logPath || !expectedDerivation || extra.length) {
      throw new Error("Usage: update-pnpm-deps-hash.mjs <flake.nix> <build.log> <pnpmDeps.drvPath>");
    }
    const result = updatePnpmDepsHash(readFileSync(flakePath, "utf8"), readFileSync(logPath, "utf8"), expectedDerivation);
    writeFileSync(flakePath, result.source);
    console.log(result.hash);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
