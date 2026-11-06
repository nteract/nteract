import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RELEASE_ARCHIVE_LIMITS,
  inspectReleaseArchive,
  readReleaseZip,
  safeReleasePath,
  verifyReleaseArchive,
  writeReleaseDist,
} from "./release-archive.mjs";

import { SHA, releaseZip, sha256 } from "./fixtures/release-zip.mjs";

test("a release whose files match its receipt verifies", () => {
  const release = verifyReleaseArchive(releaseZip(), { sha: SHA });
  assert.deepEqual([...release.files.keys()].sort(), [
    "build-receipt.json",
    "index.js",
    "public/chunks/a.js",
    "public/index.html",
  ]);
  assert.equal(release.files.get("index.js").toString(), "worker");
  assert.equal(release.receipt.build_id, "0123456789ab");
  assert.match(release.receiptSha256, /^[0-9a-f]{64}$/);
});

test("release paths refuse traversal, absolute names and .git segments", () => {
  for (const name of ["a/../b", "..", "./a", "a//b", ".git/config", "a/.GIT/x", "a b", ""])
    assert.equal(safeReleasePath(name), false, name);
  assert.equal(safeReleasePath("public/chunks/viewer-abc.js"), true);
});

test("archive inspection refuses unsafe entries", () => {
  const file = (name, extra = {}) => ({
    name,
    method: 0,
    size: 1,
    compressedSize: 1,
    mode: 0,
    ...extra,
  });
  const cases = [
    [[file("/etc/passwd")], /absolute/],
    [[file("a\\b")], /absolute or not portable/],
    [[file("../x")], /unsafe/],
    [[file("public/.git/hooks")], /unsafe/],
    [[file("link", { mode: 0o120777 })], /not a regular file/],
    [[file("dir", { dosDirectory: true })], /marked as a directory/],
    [[file("a"), file("a")], /repeats/],
    [[file("a"), file("a/b")], /both file and directory/],
    [[file("a"), { name: "stray/", size: 0, compressedSize: 0, mode: 0 }], /not a parent/],
    [[file("a", { method: 12 })], /unsupported compression/],
    [
      Array.from({ length: RELEASE_ARCHIVE_LIMITS.entries + 1 }, (_, i) => file("f" + i)),
      /more than 64 entries/,
    ],
    [
      [
        file("a", { size: RELEASE_ARCHIVE_LIMITS.extracted, compressedSize: 1, method: 8 }),
        file("b", { method: 8, compressedSize: 1 }),
      ],
      /more than 128 MiB/,
    ],
    [[], /empty/],
  ];
  for (const [entries, message] of cases)
    assert.throws(() => inspectReleaseArchive(entries), message);
});

test("a real symlink entry in the ZIP is refused", () => {
  const zip = releaseZip({ extra: [{ name: "public/evil", data: "/etc/passwd", mode: 0o120777 }] });
  assert.throws(() => verifyReleaseArchive(zip, { sha: SHA }), /not a regular file/);
});

test("the file set must equal the receipt's files plus the receipt", () => {
  assert.throws(
    () =>
      verifyReleaseArchive(releaseZip({ extra: [{ name: "extra.js", data: "x" }] }), { sha: SHA }),
    /uncertified file extra.js/,
  );
  const missing = releaseZip({
    receipt: { files: { "index.js": sha256(Buffer.from("worker")), "gone.js": "0".repeat(64) } },
  });
  assert.throws(
    () => verifyReleaseArchive(missing, { sha: SHA }),
    /missing certified file gone.js/,
  );
});

test("a file whose bytes differ from its receipt digest is refused", () => {
  const zip = releaseZip({
    receipt: {
      files: {
        "index.js": sha256(Buffer.from("other")),
        "public/index.html": sha256(Buffer.from("<html>")),
        "public/chunks/a.js": sha256(Buffer.from("a")),
      },
    },
  });
  assert.throws(
    () => verifyReleaseArchive(zip, { sha: SHA }),
    /does not match its receipt: index.js/,
  );
});

test("the receipt must be for the clean requested source", () => {
  assert.throws(
    () => verifyReleaseArchive(releaseZip(), { sha: "b".repeat(40) }),
    /clean requested source/,
  );
  assert.throws(
    () => verifyReleaseArchive(releaseZip({ receipt: { source_dirty: true } }), { sha: SHA }),
    /clean requested source/,
  );
  assert.throws(
    () => verifyReleaseArchive(releaseZip({ receipt: { build_id: "nope" } }), { sha: SHA }),
    /no build id/,
  );
});

test("ZIP parsing refuses trailing data and truncated archives", () => {
  const zip = releaseZip();
  assert.throws(() => readReleaseZip(Buffer.concat([zip, Buffer.from("junk")])), /exact ZIP end/);
  assert.throws(() => readReleaseZip(zip.subarray(0, 10)), /outside the archive cap/);
  assert.throws(() => readReleaseZip(Buffer.alloc(100)), /exact ZIP end/);
});

test("writeReleaseDist writes only into a new dist below plain directories", () => {
  const checkout = fs.mkdtempSync(path.join(tmpdir(), "release-dist-"));
  try {
    fs.mkdirSync(path.join(checkout, "app"));
    const files = verifyReleaseArchive(releaseZip(), { sha: SHA }).files;
    const dist = path.join(checkout, "app", "dist");
    writeReleaseDist({ checkout, dist, files });
    assert.equal(fs.readFileSync(path.join(dist, "public/chunks/a.js"), "utf8"), "a");
    assert.throws(() => writeReleaseDist({ checkout, dist, files }), /dist already exists/);

    fs.mkdirSync(path.join(checkout, "real"));
    fs.symlinkSync(path.join(checkout, "real"), path.join(checkout, "linked"));
    assert.throws(
      () => writeReleaseDist({ checkout, dist: path.join(checkout, "linked", "dist"), files }),
      /not a plain directory/,
    );
    assert.equal(fs.existsSync(path.join(checkout, "real", "dist")), false);
    assert.throws(
      () => writeReleaseDist({ checkout, dist: path.join(checkout, "..", "dist"), files }),
      /inside the checkout/,
    );
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test("a write failure partway through extraction removes the new dist", () => {
  const checkout = fs.mkdtempSync(path.join(tmpdir(), "release-dist-"));
  try {
    const files = verifyReleaseArchive(releaseZip(), { sha: SHA }).files;
    const dist = path.join(checkout, "dist");
    let writes = 0;
    const failing = {
      ...fs,
      writeFileSync(...args) {
        if (++writes === 2) throw new Error("disk full");
        return fs.writeFileSync(...args);
      },
    };
    assert.throws(() => writeReleaseDist({ checkout, dist, files, fs: failing }), /disk full/);
    assert.equal(fs.existsSync(dist), false);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});
