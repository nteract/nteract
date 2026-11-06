// Checks for a `pages-release` artifact ZIP. The archive is untrusted until
// every file matches its build-receipt.json. These rules mirror the lab1
// controller's (nteract/preview-infra lib/pages-artifact.mjs); change both
// together.
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

// About 2.5x headroom over the current 24 MiB, 31-file release. Raise these
// deliberately when the bundle grows.
export const RELEASE_ARCHIVE_LIMITS = Object.freeze({
  zip: 64 * 1024 * 1024,
  extracted: 128 * 1024 * 1024,
  entries: 64,
  receipt: 1024 * 1024,
});
export const RELEASE_RECEIPT = "build-receipt.json";
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** A release path: relative, `/`-separated, safe charset, no `.`, `..`, empty
 * or `.git` (any case) segment. */
export function safeReleasePath(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 255 &&
    name
      .split("/")
      .every((s) => SEGMENT.test(s) && s !== "." && s !== ".." && s.toLowerCase() !== ".git")
  );
}

/** Parse the ZIP central directory without extracting. Sizes, names and modes
 * come from the central directory; each local header must agree on name and
 * method. ZIP64, multi-disk, encrypted and trailing-data archives are refused. */
export function readReleaseZip(zip) {
  check(
    Buffer.isBuffer(zip) && zip.length >= 22 && zip.length <= RELEASE_ARCHIVE_LIMITS.zip,
    "Release artifact size is outside the archive cap",
  );
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--)
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  check(
    end >= 0 && end + 22 + zip.readUInt16LE(end + 20) === zip.length,
    "Release artifact has no exact ZIP end record",
  );
  const disk = zip.readUInt16LE(end + 4);
  const cdDisk = zip.readUInt16LE(end + 6);
  const here = zip.readUInt16LE(end + 8);
  const count = zip.readUInt16LE(end + 10);
  const cdSize = zip.readUInt32LE(end + 12);
  const cdOffset = zip.readUInt32LE(end + 16);
  check(
    disk === 0 &&
      cdDisk === 0 &&
      here === count &&
      count !== 0xffff &&
      cdOffset !== 0xffffffff &&
      cdSize !== 0xffffffff,
    "Release artifact uses multi-disk or ZIP64 records",
  );
  check(
    count <= RELEASE_ARCHIVE_LIMITS.entries,
    `Release artifact has more than ${RELEASE_ARCHIVE_LIMITS.entries} entries`,
  );
  check(cdOffset + cdSize === end, "Release artifact central directory is not contiguous");
  const entries = [];
  let at = cdOffset;
  for (let n = 0; n < count; n++) {
    check(
      at + 46 <= end && zip.readUInt32LE(at) === 0x02014b50,
      "Release artifact central directory is corrupt",
    );
    const madeBy = zip.readUInt16LE(at + 4);
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const external = zip.readUInt32LE(at + 38);
    const offset = zip.readUInt32LE(at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    check(next <= end, "Release artifact central directory is corrupt");
    check((flags & 0x41) === 0, "Release artifact entries must not be encrypted");
    check(
      compressedSize !== 0xffffffff && size !== 0xffffffff && offset !== 0xffffffff,
      "Release artifact uses ZIP64 records",
    );
    const name = zip.toString("latin1", at + 46, at + 46 + nameLength);
    check(
      offset + 30 <= cdOffset && zip.readUInt32LE(offset) === 0x04034b50,
      "Release artifact local header is missing",
    );
    const localName = zip.readUInt16LE(offset + 26);
    const localExtra = zip.readUInt16LE(offset + 28);
    const data = offset + 30 + localName + localExtra;
    check(
      zip.toString("latin1", offset + 30, offset + 30 + localName) === name &&
        zip.readUInt16LE(offset + 8) === method,
      "Release artifact local header disagrees with its central directory",
    );
    // Streaming entries (flag bit 3) leave local CRC and sizes zero. Any value
    // a local header does state must match the central directory.
    const local = [
      [zip.readUInt32LE(offset + 14), crc],
      [zip.readUInt32LE(offset + 18), compressedSize],
      [zip.readUInt32LE(offset + 22), size],
    ];
    check(
      local.every(([stated, central]) => stated === 0 || stated === central),
      "Release artifact local header sizes or CRC disagree with its central directory",
    );
    check(
      data + compressedSize <= cdOffset,
      "Release artifact entry data overruns the central directory",
    );
    // Unix "made by" stores st_mode in the high external-attribute bits.
    const mode = madeBy >> 8 === 3 ? external >>> 16 : 0;
    entries.push({
      name,
      method,
      compressedSize,
      size,
      mode,
      dosDirectory: (external & 0x10) !== 0,
      data,
    });
    at = next;
  }
  check(at === end, "Release artifact central directory has unaccounted bytes");
  return entries;
}

/** Classify parsed entries and refuse anything other than regular files and
 * the exact parent directories of those files. */
export function inspectReleaseArchive(entries) {
  check(Array.isArray(entries) && entries.length > 0, "Release artifact is empty");
  check(
    entries.length <= RELEASE_ARCHIVE_LIMITS.entries,
    `Release artifact has more than ${RELEASE_ARCHIVE_LIMITS.entries} entries`,
  );
  const files = new Map();
  const directories = new Set();
  let total = 0;
  for (const entry of entries) {
    const directory = entry.name.endsWith("/");
    const name = directory ? entry.name.slice(0, -1) : entry.name;
    const type = entry.mode & 0o170000;
    check(
      !entry.name.startsWith("/") && !entry.name.includes("\\") && !entry.name.includes("\0"),
      `Release artifact path is absolute or not portable: ${JSON.stringify(entry.name)}`,
    );
    check(safeReleasePath(name), `Release artifact path is unsafe: ${JSON.stringify(entry.name)}`);
    check(!files.has(name) && !directories.has(name), `Release artifact repeats ${name}`);
    if (directory) {
      check(
        type === 0 || type === 0o040000,
        `Release artifact directory has a non-directory mode: ${name}`,
      );
      check(
        entry.size === 0 && entry.compressedSize === 0,
        `Release artifact directory carries data: ${name}`,
      );
      directories.add(name);
      continue;
    }
    check(type === 0 || type === 0o100000, `Release artifact entry is not a regular file: ${name}`);
    check(!entry.dosDirectory, `Release artifact file is marked as a directory: ${name}`);
    check(
      entry.method === 0 || entry.method === 8,
      `Release artifact uses an unsupported compression method: ${name}`,
    );
    check(
      entry.method !== 0 || entry.compressedSize === entry.size,
      `Release artifact stored entry sizes disagree: ${name}`,
    );
    check(
      Number.isSafeInteger(entry.size) && entry.size >= 0,
      `Release artifact entry size is invalid: ${name}`,
    );
    total += entry.size;
    check(
      total <= RELEASE_ARCHIVE_LIMITS.extracted,
      "Release artifact extracts to more than 128 MiB",
    );
    files.set(name, entry);
  }
  const parents = new Set();
  for (const name of files.keys()) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) parents.add(parts.slice(0, i).join("/"));
  }
  for (const name of files.keys())
    check(!parents.has(name), `Release artifact uses ${name} as both file and directory`);
  for (const name of directories)
    check(
      parents.has(name),
      `Release artifact directory is not a parent of a release file: ${name}`,
    );
  return files;
}

function inflate(zip, entry) {
  const raw = zip.subarray(entry.data, entry.data + entry.compressedSize);
  let bytes;
  try {
    bytes =
      entry.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
  } catch {
    check(false, `Release artifact entry does not inflate within its declared size: ${entry.name}`);
  }
  check(
    bytes.length === entry.size,
    `Release artifact entry size disagrees with its data: ${entry.name}`,
  );
  return bytes;
}

/** Bind the archive to its receipt: source revision, clean tree, exactly the
 * certified file set plus the receipt, and every file's sha256. Returns the
 * verified bytes; nothing is written here. */
export function verifyReleaseArchive(zip, { sha }) {
  const files = inspectReleaseArchive(readReleaseZip(zip));
  const receiptEntry = files.get(RELEASE_RECEIPT);
  check(
    receiptEntry && receiptEntry.size <= RELEASE_ARCHIVE_LIMITS.receipt,
    "Release artifact needs a bounded build-receipt.json",
  );
  const receiptBytes = inflate(zip, receiptEntry);
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8"));
  } catch {
    check(false, "Release artifact build-receipt.json is not JSON");
  }
  check(
    receipt?.source_sha === sha && receipt.source_dirty === false,
    "Release artifact receipt is not for the clean requested source",
  );
  check(
    typeof receipt.build_id === "string" && /^[a-f0-9]{12}$/.test(receipt.build_id),
    "Release artifact receipt has no build id",
  );
  const certified = receipt.files;
  check(
    certified &&
      typeof certified === "object" &&
      !Array.isArray(certified) &&
      Object.keys(certified).length > 0 &&
      Object.entries(certified).every(
        ([file, digest]) =>
          safeReleasePath(file) &&
          file !== RELEASE_RECEIPT &&
          typeof digest === "string" &&
          /^[0-9a-f]{64}$/.test(digest),
      ),
    "Release artifact receipt must certify release files with sha256",
  );
  const expected = [...Object.keys(certified), RELEASE_RECEIPT].sort();
  const present = [...files.keys()].sort();
  for (const file of expected)
    check(files.has(file), `Release artifact is missing certified file ${file}`);
  for (const file of present)
    check(
      file === RELEASE_RECEIPT || Object.hasOwn(certified, file),
      `Release artifact carries uncertified file ${file}`,
    );
  check(
    JSON.stringify(expected) === JSON.stringify(present),
    "Release artifact file set differs from its receipt",
  );
  const verified = new Map([[RELEASE_RECEIPT, receiptBytes]]);
  for (const [file, digest] of Object.entries(certified).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const bytes = inflate(zip, files.get(file));
    check(sha256(bytes) === digest, `Release artifact file does not match its receipt: ${file}`);
    verified.set(file, bytes);
  }
  return { receipt, receiptSha256: sha256(receiptBytes), files: verified };
}

/** Write verified files into `dist`, which must be new. Every ancestor from
 * `checkout` to dist must be a plain directory, and each file is created
 * exclusively, so no existing path or symlink is followed or replaced. */
export function writeReleaseDist({ checkout, dist, files, fs = nodeFs }) {
  const relative = path.relative(checkout, dist);
  check(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    "Release dist must be inside the checkout",
  );
  let directory = checkout;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    directory = path.join(directory, part);
    const stat = fs.lstatSync(directory);
    check(
      stat.isDirectory() && !stat.isSymbolicLink(),
      "Pages source path to dist is not a plain directory: " + directory,
    );
  }
  try {
    fs.mkdirSync(dist, { mode: 0o755 });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Pages dist already exists: " + dist + ". Move it aside before extracting a release",
      );
    throw error;
  }
  const made = new Set();
  for (const [file, bytes] of files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      if (made.has(parent)) continue;
      fs.mkdirSync(path.join(dist, parent), { mode: 0o755 });
      made.add(parent);
    }
    fs.writeFileSync(path.join(dist, file), bytes, { flag: "wx", mode: 0o644 });
  }
  return dist;
}
