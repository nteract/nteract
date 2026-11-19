import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { cloudflareConfig, outputStructuralConfig, structuralConfig } from "./cloudflare-stage.mjs";
import {
  OUTPUT_ENTRIES,
  OUTPUT_STRUCTURAL_FIELDS,
  PACKAGE_ENTRIES,
  STRUCTURAL_FIELDS,
  entryProblems,
  gzipOf,
  packageFiles,
  tarOf,
  ustarName,
  writeReleasePackage,
} from "./release-package.mjs";
import { OUTPUT_WORKER, releaseArtifacts, releaseFilesOf } from "./stage-artifacts.mjs";
import { VIEWER_ASSETS, hashedAssetPath } from "./viewer-chunks.mjs";
import {
  LIBRARY_REVISION_FIXTURE,
  libraryCatalogContents,
  libraryCatalogFiles,
  libraryCatalogReceipt,
} from "./fixtures/library-catalog-fixture.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const BUILD_ID = "0123456789ab";
const COMMIT = "a".repeat(40);
const OUTPUT_MODULE = `export default { fetch() { return new Response("pages-output-v2 ${BUILD_ID}"); } };\n`;

/** A complete fake dist the way build.mjs leaves it, with local-only files
 * beside it that a package must never carry. */
function fakeDist(dir) {
  const dist = path.join(dir, "dist");
  mkdirSync(path.join(dist, "public/chunks"), { recursive: true });
  const chunk = "public/chunks/ABCDEFGH.js";
  const assets = Object.fromEntries(
    VIEWER_ASSETS.map((name) => [hashedAssetPath(name, name), name]),
  );
  const contents = (file) => assets[file] ?? libraryCatalogContents[file] ?? file;
  const receipt = {
    build_id: BUILD_ID,
    source_sha: COMMIT,
    source_dirty: false,
    document_formats: { "pages.page": [3], "pages.comments": [2] },
    viewer_chunks: { [chunk]: sha256(chunk) },
    viewer_assets: Object.fromEntries(
      Object.entries(assets).map(([file, bytes]) => [file, sha256(bytes)]),
    ),
    library_catalog: libraryCatalogReceipt(),
    files: Object.fromEntries(
      releaseFilesOf([chunk], Object.keys(assets), libraryCatalogFiles).map((file) => [
        file,
        sha256(contents(file)),
      ]),
    ),
    output_frame_paths: ["/frame/v2/"],
    output_files: { [OUTPUT_WORKER]: sha256(OUTPUT_MODULE) },
  };
  mkdirSync(path.join(dist, `public/catalog/${LIBRARY_REVISION_FIXTURE}`), { recursive: true });
  for (const file of [...releaseArtifacts, chunk, ...Object.keys(assets), ...libraryCatalogFiles])
    writeFileSync(
      path.join(dist, file),
      file === "build-receipt.json" ? JSON.stringify(receipt) : contents(file),
    );
  mkdirSync(path.join(dist, "output"));
  writeFileSync(path.join(dist, OUTPUT_WORKER), OUTPUT_MODULE);
  writeFileSync(path.join(dist, ".dev.vars"), "secret-that-must-stay-local");
  mkdirSync(path.join(dist, ".celld"));
  writeFileSync(path.join(dist, ".celld", "private.db"), "private");
  return dist;
}

const scratch = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pages-release-package-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("the release package holds exactly the package entries, no symlinks, and a digest that matches", (t) => {
  const dir = scratch(t);
  const out = path.join(dir, "out");
  const manifest = writeReleasePackage(fakeDist(dir), out);

  const archivePath = path.join(out, manifest.archive.name);
  assert.deepEqual(
    readdirSync(out).sort(),
    [
      archivePath.split("/").pop(),
      `${manifest.archive.name}.sha256`,
      `pages-package-${BUILD_ID}.manifest.json`,
    ].sort(),
  );
  assert.equal(manifest.archive.name, `pages-package-${BUILD_ID}.tar.gz`);
  assert.equal(manifest.tag, `pages-${BUILD_ID}`);
  assert.equal(manifest.build_id, BUILD_ID);
  assert.equal(manifest.source_commit, COMMIT);
  assert.deepEqual(manifest.document_formats, { "pages.page": [3], "pages.comments": [2] });

  // The digest in the manifest and in the .sha256 file is the archive's.
  const archive = readFileSync(archivePath);
  assert.equal(manifest.archive.sha256, sha256(archive));
  assert.equal(manifest.archive.bytes, archive.length);
  assert.equal(
    readFileSync(`${archivePath}.sha256`, "utf8"),
    `${sha256(archive)}  ${manifest.archive.name}\n`,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(out, `pages-package-${BUILD_ID}.manifest.json`), "utf8")),
    manifest,
  );

  // A real tar reads it: link entries and non-regular types show in the
  // verbose listing's first column, so only `-` (file) is allowed.
  const listing = execFileSync("tar", ["-tvzf", archivePath], { encoding: "utf8" })
    .trim()
    .split("\n");
  assert.ok(
    listing.every((line) => line.startsWith("-")),
    listing.join("\n"),
  );

  const extracted = path.join(dir, "extracted");
  mkdirSync(extracted);
  execFileSync("tar", ["-xzf", archivePath, "-C", extracted]);
  assert.deepEqual(readdirSync(extracted).sort(), [...PACKAGE_ENTRIES].sort());
  const files = packageFiles(extracted);
  assert.deepEqual(entryProblems(files), []);
  assert.deepEqual(
    files,
    manifest.entries.map((entry) => entry.path),
  );
  for (const entry of manifest.entries) {
    assert.ok(lstatSync(path.join(extracted, entry.path)).isFile());
    assert.equal(sha256(readFileSync(path.join(extracted, entry.path))), entry.sha256);
  }
  assert.deepEqual(readdirSync(path.join(extracted, "worker")).sort(), [
    "automerge.wasm",
    "index.js",
    "sift.wasm",
  ]);
  // The output Worker: the certified module and its structural config, both
  // listed in the manifest's entries.
  assert.deepEqual(readdirSync(path.join(extracted, "output")).sort(), [
    "worker.js",
    "wrangler.json",
  ]);
  assert.deepEqual(
    files.filter((file) => file.startsWith("output/")),
    [...OUTPUT_ENTRIES],
  );
  assert.equal(readFileSync(path.join(extracted, "output/worker.js"), "utf8"), OUTPUT_MODULE);
  for (const file of OUTPUT_ENTRIES)
    assert.ok(
      manifest.entries.some((entry) => entry.path === file),
      file,
    );
  assert.ok(files.every((file) => !file.includes(".dev.vars") && !file.includes(".celld")));
  // The library catalog travels under public/catalog/<revision>/.
  assert.deepEqual(
    files.filter((file) => file.startsWith("public/catalog/")),
    [...libraryCatalogFiles],
  );
});

test("the same package files give the same archive bytes", (t) => {
  const dir = scratch(t);
  const dist = fakeDist(dir);
  const first = writeReleasePackage(dist, path.join(dir, "one"));
  const second = writeReleasePackage(dist, path.join(dir, "two"));
  assert.equal(first.archive.sha256, second.archive.sha256);
});

test("the shipped wrangler.json is the structural config and names no deployment", (t) => {
  const dir = scratch(t);
  const out = path.join(dir, "out");
  const manifest = writeReleasePackage(fakeDist(dir), out);
  const extracted = path.join(dir, "extracted");
  mkdirSync(extracted);
  execFileSync("tar", ["-xzf", path.join(out, manifest.archive.name), "-C", extracted]);
  const shipped = JSON.parse(readFileSync(path.join(extracted, "wrangler.json"), "utf8"));
  assert.deepEqual(shipped, structuralConfig());
  assert.deepEqual(Object.keys(shipped).sort(), [...STRUCTURAL_FIELDS].sort());
  for (const bound of ["name", "account_id", "workers_dev", "routes", "d1_databases", "r2_buckets"])
    assert.ok(!(bound in shipped), bound);
  assert.deepEqual(Object.keys(shipped.vars), [
    "NOTEBOOK_CLOUD_OIDC_FLOW",
    "PAGES_OAUTH_METADATA_EGRESS",
  ]);
  assert.deepEqual(shipped.compatibility_flags, ["global_fetch_strictly_public"]);
  assert.equal(shipped.vars.PAGES_OAUTH_METADATA_EGRESS, "public-https");
  assert.ok(manifest.structural_fields.includes("compatibility_flags"));
  assert.ok(manifest.structural_vars.includes("PAGES_OAUTH_METADATA_EGRESS"));
  assert.deepEqual(manifest.bindings, { d1: ["DB", "PAGES_USAGE"], r2: ["PAGES_ASSETS"] });

  // Drift guard: a deployment profile's config agrees with the package on every
  // structural field, so the two cannot fall apart without this test failing.
  const full = cloudflareConfig({
    name: "pages-example",
    workers_dev: true,
    d1: {
      auth: { database_name: "a", database_id: "11111111-1111-4111-8111-111111111111" },
      usage: { database_name: "u", database_id: "22222222-2222-4222-8222-222222222222" },
    },
    r2_bucket: "pages-example-assets",
    vars: { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages-example.example.workers.dev" },
  });
  for (const field of STRUCTURAL_FIELDS) {
    if (field === "vars") {
      for (const [key, value] of Object.entries(shipped.vars))
        assert.equal(full.vars[key], value, key);
    } else assert.deepEqual(full[field], shipped[field], field);
  }
  assert.deepEqual(
    [d1Bindings(full), full.r2_buckets.map((r) => r.binding)],
    [manifest.bindings.d1, manifest.bindings.r2],
  );
});
const d1Bindings = (config) => config.d1_databases.map((database) => database.binding);

test("the shipped output/wrangler.json is the output structural config and names no deployment", (t) => {
  const dir = scratch(t);
  const out = path.join(dir, "out");
  const manifest = writeReleasePackage(fakeDist(dir), out);
  const extracted = path.join(dir, "extracted");
  mkdirSync(extracted);
  execFileSync("tar", ["-xzf", path.join(out, manifest.archive.name), "-C", extracted]);
  const shipped = JSON.parse(readFileSync(path.join(extracted, "output/wrangler.json"), "utf8"));
  assert.deepEqual(shipped, outputStructuralConfig());
  // Exactly the documented fields: no name, route, account, workers_dev,
  // binding or variable, and no compatibility flag the code does not need.
  assert.deepEqual(OUTPUT_STRUCTURAL_FIELDS, ["main", "no_bundle", "compatibility_date"]);
  assert.deepEqual(Object.keys(shipped), [...OUTPUT_STRUCTURAL_FIELDS]);
  assert.equal(shipped.main, "worker.js");
  assert.equal(shipped.no_bundle, true);
  assert.match(shipped.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(manifest.output_structural_fields, [...OUTPUT_STRUCTURAL_FIELDS]);
  // The receipt in the archive names the frame paths this shell serves.
  const receipt = JSON.parse(readFileSync(path.join(extracted, "build-receipt.json"), "utf8"));
  assert.deepEqual(receipt.output_frame_paths, ["/frame/v2/"]);
});

test("an output Worker that changed since the build, or a receipt without one, is refused", (t) => {
  const dir = scratch(t);
  const dist = fakeDist(dir);
  const receiptPath = path.join(dist, "build-receipt.json");
  const { output_files: certified, ...receipt } = JSON.parse(readFileSync(receiptPath, "utf8"));
  writeFileSync(path.join(dist, OUTPUT_WORKER), "export default {};\n");
  assert.throws(
    () => writeReleasePackage(dist, path.join(dir, "changed")),
    /changed since the build: output\/worker\.js/,
  );
  writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.throws(() => writeReleasePackage(dist, path.join(dir, "uncertified")), /output_files/);
  writeFileSync(
    receiptPath,
    JSON.stringify({ ...receipt, output_files: certified, output_frame_paths: ["frame/v2"] }),
  );
  assert.throws(() => writeReleasePackage(dist, path.join(dir, "paths")), /frame paths/);
});

test("entryProblems refuses extra, missing and nested entries", () => {
  const ok = [
    "build-receipt.json",
    "output/worker.js",
    "output/wrangler.json",
    "public/index.html",
    "worker/index.js",
    "wrangler.json",
  ];
  assert.deepEqual(entryProblems(ok), []);
  assert.match(entryProblems([...ok, ".dev.vars"]).join(), /\.dev\.vars is not part/);
  assert.match(entryProblems(ok.filter((f) => f !== "wrangler.json")).join(), /no wrangler\.json/);
  assert.match(entryProblems([...ok, "worker/sub/x.js"]).join(), /flat module/);
  assert.match(
    entryProblems(ok.filter((f) => f !== "worker/index.js").concat("worker/a.js")).join(),
    /no worker\/index\.js/,
  );
  // output/ is required and holds exactly its two files, flat.
  assert.match(
    entryProblems(ok.filter((f) => !f.startsWith("output/"))).join(),
    /The package has no output/,
  );
  assert.match(
    entryProblems([...ok, "output/extra.js"]).join(),
    /output\/extra\.js is not part of output, which holds only output\/worker\.js and output\/wrangler\.json/,
  );
  assert.match(
    entryProblems([...ok, "output/nested/worker.js"]).join(),
    /output\/nested\/worker\.js is not part of output/,
  );
  assert.match(
    entryProblems(ok.filter((f) => f !== "output/wrangler.json")).join(),
    /no output\/wrangler\.json/,
  );
  assert.match(
    entryProblems(ok.filter((f) => f !== "output/worker.js")).join(),
    /no output\/worker\.js/,
  );
});

test("packageFiles refuses a symlink", (t) => {
  const dir = scratch(t);
  mkdirSync(path.join(dir, "worker"));
  writeFileSync(path.join(dir, "worker/index.js"), "x");
  symlinkSync("/etc/hosts", path.join(dir, "worker/link.js"));
  assert.throws(() => packageFiles(dir), /worker\/link\.js must be a regular file/);
});

test("tarOf and gzipOf are deterministic and refuse an over-long path", () => {
  const files = [
    ["b.txt", Buffer.from("two")],
    ["a.txt", Buffer.from("one")],
  ];
  assert.deepEqual(gzipOf(tarOf(files)), gzipOf(tarOf([...files].reverse())));
  assert.throws(() => tarOf([["x".repeat(101), Buffer.alloc(0)]]), /too long/);
  assert.throws(() => tarOf([[`${"p".repeat(156)}/name.js`, Buffer.alloc(0)]]), /too long/);
});

test("a library catalog path past 100 bytes travels in the ustar prefix", (t) => {
  const file = `public/catalog/${"a".repeat(64)}/nteract-sift-parquet.js`;
  assert.ok(Buffer.byteLength(file) > 100);
  const { name, prefix } = ustarName(file);
  assert.equal(`${prefix}/${name}`, file);
  const dir = scratch(t);
  const archive = path.join(dir, "catalog.tar.gz");
  writeFileSync(archive, gzipOf(tarOf([[file, Buffer.from("export {};\n")]])));
  // The system tar reads the path back whole.
  assert.equal(execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim(), file);
});

test("a receipt without a clean commit is refused", (t) => {
  const dir = scratch(t);
  const dist = fakeDist(dir);
  // Rewrite the receipt as dirty; stageArtifacts' digest check covers
  // build-receipt.json by copying it, so the packager's own check must refuse.
  const receiptPath = path.join(dist, "build-receipt.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  writeFileSync(receiptPath, JSON.stringify({ ...receipt, source_dirty: true }));
  assert.throws(() => writeReleasePackage(dist, path.join(dir, "out")), /clean commit/);
});
