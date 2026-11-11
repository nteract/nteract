#!/usr/bin/env node
// Package a built Pages checkout as the deployment-neutral release asset:
//
//   pages-package-<build_id>.tar.gz          the package
//   pages-package-<build_id>.tar.gz.sha256   `sha256sum -c` line for the archive
//   pages-package-<build_id>.manifest.json   what the archive holds
//
// The archive holds the layout cloudflare-stage.mjs writes (worker/, public/,
// build-receipt.json, wrangler.json) and nothing else, but its wrangler.json is
// structuralConfig(): no Worker name, account, address, database, bucket or
// deployment variable. A consumer keeps its own Wrangler file, deploys the
// package's modules and assets with it, and compares the structural fields.
//
// This script only reads dist and writes the three files. It never publishes.
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  cleanBuildDist,
  expectedBindings,
  stageWithConfig,
  structuralConfig,
} from "./cloudflare-stage.mjs";

export const PACKAGE_ENTRIES = Object.freeze([
  "build-receipt.json",
  "public",
  "worker",
  "wrangler.json",
]);
// The top-level wrangler.json fields a consumer compares. `vars` is compared
// key by key: only NOTEBOOK_CLOUD_OIDC_FLOW is structural.
export const STRUCTURAL_FIELDS = Object.freeze(Object.keys(structuralConfig()));
const BUILD_ID = /^[0-9a-f]{12}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const archiveName = (buildId) => `pages-package-${buildId}.tar.gz`;
export const releaseTag = (buildId) => `pages-${buildId}`;

/** Every regular file under `directory`, as sorted package paths. Anything
 * that is not a regular file or directory (a symlink, a socket) throws. */
export function packageFiles(directory) {
  const files = [];
  const walk = (relative) => {
    for (const name of readdirSync(path.join(directory, relative)).sort()) {
      const entry = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(path.join(directory, entry));
      if (stat.isDirectory()) walk(entry);
      else if (stat.isFile()) files.push(entry);
      else throw new Error(`${entry} must be a regular file or a directory`);
    }
  };
  walk("");
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Why `files` is not a Pages package; empty when it is. The top level is
 * exactly PACKAGE_ENTRIES, and worker/ holds only flat modules. */
export function entryProblems(files) {
  const problems = [];
  const top = new Set(files.map((file) => file.split("/")[0]));
  for (const name of top)
    if (!PACKAGE_ENTRIES.includes(name)) problems.push(`${name} is not part of a Pages package`);
  for (const name of PACKAGE_ENTRIES)
    if (!top.has(name)) problems.push(`The package has no ${name}`);
  for (const file of files) {
    const parts = file.split("/");
    if (parts[0] === "worker" && parts.length !== 2)
      problems.push(`${file} must be a flat module in worker`);
    if (parts.some((part) => part === "" || part === "." || part === ".."))
      problems.push(`${file} is not a clean relative path`);
    if (["build-receipt.json", "wrangler.json"].includes(parts[0]) && parts.length !== 1)
      problems.push(`${parts[0]} must be a file`);
  }
  if (!files.includes("worker/index.js")) problems.push("The package has no worker/index.js");
  return problems;
}

const octal = (value, width) => value.toString(8).padStart(width - 1, "0") + "\0";

/** A ustar archive of `files` (path → bytes): sorted, mode 0644, owner 0, mtime
 * 0, no directory entries. The same files give the same bytes. */
export function tarOf(files) {
  const blocks = [];
  for (const [file, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const name = Buffer.from(file);
    if (name.length > 100) throw new Error(`${file} is too long for a ustar header`);
    const header = Buffer.alloc(512);
    name.copy(header, 0);
    header.write("0000644\0", 100);
    header.write(octal(0, 8), 108);
    header.write(octal(0, 8), 116);
    header.write(octal(bytes.length, 12), 124);
    header.write(octal(0, 12), 136);
    header.fill(" ", 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** gzip with a fixed header: no mtime and the Unix OS byte on every platform. */
export function gzipOf(tar) {
  const bytes = gzipSync(tar, { level: 9 });
  bytes[4] = bytes[5] = bytes[6] = bytes[7] = 0;
  bytes[9] = 3;
  return bytes;
}

/** Write the archive, its digest file and its manifest for the build in
 * `dist` into `outDir` (which must not exist). Returns the manifest. */
export function writeReleasePackage(dist, outDir) {
  outDir = path.resolve(outDir);
  const scratch = mkdtempSync(path.join(os.tmpdir(), "pages-package-"));
  try {
    const staged = path.join(scratch, "package");
    stageWithConfig(dist, staged, structuralConfig());
    const files = packageFiles(staged);
    const problems = entryProblems(files);
    if (problems.length) throw new Error(problems.join("\n"));
    const contents = files.map((file) => [file, readFileSync(path.join(staged, file))]);
    const receipt = JSON.parse(readFileSync(path.join(staged, "build-receipt.json"), "utf8"));
    if (!BUILD_ID.test(receipt.build_id)) throw new Error("The build receipt has no build id");
    if (!COMMIT.test(receipt.source_sha) || receipt.source_dirty !== false)
      throw new Error("The build receipt must name a clean commit");

    const archive = gzipOf(tarOf(contents));
    const name = archiveName(receipt.build_id);
    const manifest = {
      schema: 1,
      tag: releaseTag(receipt.build_id),
      build_id: receipt.build_id,
      source_commit: receipt.source_sha,
      document_formats: receipt.document_formats,
      archive: { name, bytes: archive.length, sha256: sha256(archive) },
      entries: contents.map(([file, bytes]) => ({
        path: file,
        bytes: bytes.length,
        sha256: sha256(bytes),
      })),
      structural_fields: [...STRUCTURAL_FIELDS],
      structural_vars: Object.keys(structuralConfig().vars),
      bindings: expectedBindings(),
    };
    mkdirSync(outDir);
    writeFileSync(path.join(outDir, name), archive);
    writeFileSync(path.join(outDir, `${name}.sha256`), `${manifest.archive.sha256}  ${name}\n`);
    writeFileSync(
      path.join(outDir, `pages-package-${receipt.build_id}.manifest.json`),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    return manifest;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [outDir, ...extra] = process.argv.slice(2);
  if (!outDir || extra.length) throw Error("Usage: release-package.mjs NEW_OUTPUT_DIRECTORY");
  const manifest = writeReleasePackage(cleanBuildDist(), outDir);
  console.log(
    JSON.stringify({
      tag: manifest.tag,
      build_id: manifest.build_id,
      source_commit: manifest.source_commit,
      archive: manifest.archive,
    }),
  );
}
