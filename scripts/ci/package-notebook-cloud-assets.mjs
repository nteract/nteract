#!/usr/bin/env node
// Packages the embeddable editor assets into a reproducible tarball.
//
// The archive is written by this script (ustar + gzip) rather than by the host
// `tar`, so bytes depend only on file contents: entries are sorted, owners are
// zero, mtime is fixed, and the gzip header carries no timestamp. `built_at`
// lives only in manifest.json.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HANDSHAKE_RS = "crates/notebook-protocol/src/connection/handshake.rs";

// Each entry: archive directory <- repository path.
export const LAYOUT = [
  ["viewer", "apps/notebook-cloud/dist"],
  ["output-document", "apps/notebook-cloud/dist-output-document"],
  ["wasm/runtimed-wasm", "apps/notebook/src/wasm/runtimed-wasm"],
  ["protocol/src", "packages/runtimed/src"],
];
const SINGLE_FILES = [
  ["protocol/package.json", "packages/runtimed/package.json"],
  ["LICENSE", "LICENSE"],
];

export function readProtocolVersion(root = repoRoot) {
  const source = readFileSync(path.join(root, HANDSHAKE_RS), "utf8");
  const match = /pub const PROTOCOL_VERSION: u8 = (\d+);/.exec(source);
  if (!match) throw new Error(`PROTOCOL_VERSION not found in ${HANDSHAKE_RS}`);
  return Number(match[1]);
}

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function octal(value, width) {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function tarHeader(name, size) {
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
    if (cut < 1 || Buffer.byteLength(base) > 100) throw new Error(`path too long for ustar: ${name}`);
  }
  const header = Buffer.alloc(512);
  header.write(base, 0);
  header.write(octal(0o644, 8), 100);
  header.write(octal(0, 8), 108);
  header.write(octal(0, 8), 116);
  header.write(octal(size, 12), 124);
  header.write(octal(0, 12), 136);
  header.write("        ", 148);
  header.write("0", 156);
  header.write("ustar\0" + "00", 257);
  header.write(prefix, 345);
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return header;
}

export function packageAssets({ root = repoRoot, outDir, version, channel, sourceSha, builtAt = new Date().toISOString() }) {
  if (!["nightly", "stable"].includes(channel)) throw new Error(`bad channel: ${channel}`);
  const stage = mkdtempSync(path.join(tmpdir(), "nc-assets-"));
  try {
    for (const [dest, src] of LAYOUT) {
      const from = path.join(root, src);
      if (!existsSync(from)) throw new Error(`missing build output: ${src}`);
      cpSync(from, path.join(stage, dest), { recursive: true });
    }
    for (const [dest, src] of SINGLE_FILES) {
      mkdirSync(path.dirname(path.join(stage, dest)), { recursive: true });
      cpSync(path.join(root, src), path.join(stage, dest));
    }
    const files = {};
    for (const rel of walk(stage)) files[rel] = `sha256:${sha256(readFileSync(path.join(stage, rel)))}`;
    const manifest = {
      name: "notebook-cloud-assets",
      version,
      channel,
      protocol_version: readProtocolVersion(root),
      source_sha: sourceSha,
      built_at: builtAt,
      files,
    };
    writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

    const chunks = [];
    for (const rel of walk(stage)) {
      const data = readFileSync(path.join(stage, rel));
      chunks.push(tarHeader(rel, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    chunks.push(Buffer.alloc(1024));
    const archive = gzipSync(Buffer.concat(chunks), { level: 9 });

    mkdirSync(outDir, { recursive: true });
    const name = `notebook-cloud-assets-${channel}.tar.gz`;
    const tarball = path.join(outDir, name);
    writeFileSync(tarball, archive);
    writeFileSync(`${tarball}.sha256`, `${sha256(archive)}  ${name}\n`);
    return { tarball, manifest };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
  for (const key of ["out", "version", "channel", "source-sha"]) {
    if (!args[key]) throw new Error(`usage: package-notebook-cloud-assets.mjs --out=DIR --version=V --channel=nightly|stable --source-sha=SHA [--built-at=ISO]`);
  }
  const { tarball } = packageAssets({
    outDir: args.out,
    version: args.version,
    channel: args.channel,
    sourceSha: args["source-sha"],
    builtAt: args["built-at"],
  });
  console.log(tarball);
}
