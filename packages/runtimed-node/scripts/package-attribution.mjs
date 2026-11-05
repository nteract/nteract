#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ATTRIBUTION_FILES = ["LICENSE.nteract", "THIRD_PARTY_NOTICES.txt", "sbom.cdx.json"];
export const RUST_TARGETS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64-gnu": "x86_64-unknown-linux-gnu",
  "linux-arm64-gnu": "aarch64-unknown-linux-gnu",
  "win32-x64-msvc": "x86_64-pc-windows-msvc",
  "win32-arm64-msvc": "aarch64-pc-windows-msvc",
};
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function verifyAttribution(directory, { target, version, commit }) {
  if (!Object.hasOwn(RUST_TARGETS, target))
    throw new Error(`Unsupported native npm target: ${target}`);
  const manifest = json(join(directory, "package.json"));
  if (
    manifest.name !== `@runtimed/node-${target}` ||
    manifest.version !== version ||
    manifest.nteractRelease?.sourceSha !== commit
  ) {
    throw new Error("Native package identity does not match attribution source/version/target");
  }
  for (const name of ATTRIBUTION_FILES) {
    const path = join(directory, name);
    if (!lstatSync(path).isFile()) throw new Error(`Attribution must be a regular file: ${name}`);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
    if (!text.trim() || text.includes("\0"))
      throw new Error(`Empty or invalid attribution: ${name}`);
  }
  const sbom = json(join(directory, "sbom.cdx.json"));
  const application = sbom.metadata?.component;
  const properties = sbom.metadata?.properties ?? [];
  const matches = (name, value) => {
    if (!Array.isArray(properties)) return false;
    const selected = properties.filter((property) => property?.name === `nteract:${name}`);
    return selected.length === 1 && selected[0].value === value;
  };
  const binary = join(directory, `runtimed-node.${target}.node`);
  if (!lstatSync(binary).isFile()) throw new Error("Native binding must be a regular file");
  if (
    sbom.bomFormat !== "CycloneDX" ||
    sbom.specVersion !== "1.6" ||
    sbom.version !== 1 ||
    application?.type !== "application" ||
    application.name !== "runtimed-node" ||
    application.version !== version ||
    !matches("source-commit", commit) ||
    !matches("target", RUST_TARGETS[target]) ||
    !application.hashes?.some(
      (hash) => hash.alg === "SHA-256" && hash.content === digest(readFileSync(binary)),
    ) ||
    !Array.isArray(sbom.components) ||
    !sbom.components.length
  ) {
    throw new Error("Native attribution SBOM does not match the binary/source/version/target");
  }
  for (const name of ATTRIBUTION_FILES) {
    if (!manifest.files?.includes(name))
      throw new Error(`Native package files must include ${name}`);
  }
}

export function generateAttribution(repoRoot, target, version, commit) {
  if (!Object.hasOwn(RUST_TARGETS, target))
    throw new Error(`Unsupported native npm target: ${target}`);
  const source = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit) || source !== commit)
    throw new Error("Attribution must use the built release checkout SHA");
  const directory = join(repoRoot, "packages/runtimed-node/npm", target);
  const binary = join(directory, `runtimed-node.${target}.node`);
  execFileSync(
    process.execPath,
    [
      join(repoRoot, "scripts/release-attribution.mjs"),
      "--kind",
      "runtimed-node",
      "--target",
      RUST_TARGETS[target],
      "--output",
      directory,
      "--version",
      version,
      "--commit",
      commit,
      "--binary",
      binary,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  const manifestPath = join(directory, "package.json");
  const manifest = json(manifestPath);
  manifest.files = [...new Set([...(manifest.files ?? []), ...ATTRIBUTION_FILES])];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  verifyAttribution(directory, { target, version, commit });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, target, version, commit, directory, ...extra] = process.argv.slice(2);
  if (
    !target ||
    !version ||
    !commit ||
    extra.length ||
    !["generate", "verify"].includes(command) ||
    (command === "verify" ? !directory : directory)
  ) {
    throw new Error(
      "Usage: package-attribution.mjs generate <npm-target> <version> <commit> | verify <npm-target> <version> <commit> <package-dir>",
    );
  }
  if (command === "verify") verifyAttribution(directory, { target, version, commit });
  else
    generateAttribution(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      target,
      version,
      commit,
    );
}
