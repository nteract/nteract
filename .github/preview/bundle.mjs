import {gzipSync} from "node:zlib";
import {createHash} from "node:crypto";
import {readdir, readFile, lstat} from "node:fs/promises";
import path from "node:path";
import {check, SERVICES, sourceSha} from "./protocol.mjs";

const MAX_BYTES = 160 * 1024 * 1024;
const MAX_FILES = 10000;
export const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function validPath(name) {
  check(name.length < 512, "Invalid bundle path");
  const parts = name.split("/");
  check(parts.length >= 2 && SERVICES.includes(parts[0]), "Unknown bundle service");
  check(parts.every(part => /^[A-Za-z0-9_@+.,() -]+$/.test(part) && part !== "." && part !== ".."), "Unsafe bundle path");
  check((parts[1] === "index.js" && parts.length === 2) ||
    (parts.length === 2 && parts[1].endsWith(".wasm")) ||
    (parts.length > 2 && ["assets", "migrations"].includes(parts[1])), "Bundle path is not code, assets, or migrations");
}

// This deliberately matches preview-infra's nteract-preview-v1 wire format.
// Exporter configs (including the generated session secret) are never packaged.
export async function pack(exportRoot, sha) {
  sourceSha(sha);
  const files = [];
  let total = 0;
  async function walk(relative) {
    const full = path.join(exportRoot, relative);
    const stat = await lstat(full);
    check(!stat.isSymbolicLink(), "Symlink in export");
    if (stat.isDirectory()) {
      for (const name of (await readdir(full)).sort()) await walk(`${relative}/${name}`);
    } else {
      check(stat.isFile(), "Non-regular export entry");
      if (relative.endsWith("/wrangler.json")) return;
      validPath(relative);
      check(files.length < MAX_FILES, "Too many bundle files");
      check(total + stat.size <= MAX_BYTES, "Bundle too large");
      const bytes = await readFile(full);
      total += bytes.length;
      check(total <= MAX_BYTES, "Bundle too large");
      files.push({path: relative, sha256: digest(bytes), content: bytes.toString("base64")});
    }
  }
  for (const service of SERVICES) await walk(service);
  const names = new Set(files.map(file => file.path));
  for (const service of SERVICES) {
    check(names.has(`${service}/index.js`), `Missing ${service} entrypoint`);
    check(files.some(file => file.path.startsWith(`${service}/assets/`)), `Missing ${service} assets`);
  }
  return gzipSync(JSON.stringify({format: "nteract-preview-v1", sourceSha: sha, files}));
}
