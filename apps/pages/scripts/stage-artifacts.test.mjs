import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { releaseArtifacts, releaseFilesOf, stageArtifacts } from "./stage-artifacts.mjs";
import { VIEWER_ASSETS, hashedAssetPath } from "./viewer-chunks.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const chunk = "public/chunks/ABCDEFGH.js";

/** A built dist whose receipt certifies every release file. `edit` adjusts
 * the receipt's `files` before it is written. */
function bundle(t, edit = (files) => files) {
  const root = mkdtempSync(path.join(tmpdir(), "pages-stage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = path.join(root, "dist");
  const assets = Object.fromEntries(
    VIEWER_ASSETS.map((name) => [hashedAssetPath(name, "asset:" + name), "asset:" + name]),
  );
  const contents = (file) => assets[file] ?? "artifact:" + file;
  const write = (file, value) => {
    mkdirSync(path.dirname(path.join(dist, file)), { recursive: true });
    writeFileSync(path.join(dist, file), value);
  };
  const files = Object.fromEntries(
    releaseFilesOf([chunk], Object.keys(assets)).map((file) => [file, sha256(contents(file))]),
  );
  for (const file of Object.keys(files)) write(file, contents(file));
  write(
    "build-receipt.json",
    JSON.stringify({
      viewer_chunks: { [chunk]: files[chunk] },
      viewer_assets: Object.fromEntries(Object.keys(assets).map((file) => [file, files[file]])),
      files: edit({ ...files }),
    }),
  );
  return { root, dist, files, write, contents };
}

test("the receipt's files cover every release file but the receipt itself", () => {
  const listed = releaseFilesOf([chunk], ["public/app-ABCDEFGH.js"]);
  assert.ok(!listed.includes("build-receipt.json"));
  for (const file of releaseArtifacts.filter((name) => name !== "build-receipt.json"))
    assert.ok(listed.includes(file), file);
  assert.ok(listed.includes(chunk));
  assert.ok(listed.includes("public/app-ABCDEFGH.js"));
});

test("staging copies exactly the certified files and the receipt", (t) => {
  const { root, dist, files, contents } = bundle(t);
  const destination = path.join(root, "release");
  stageArtifacts(dist, destination);
  for (const file of Object.keys(files))
    assert.equal(readFileSync(path.join(destination, file), "utf8"), contents(file));
  assert.equal(
    readFileSync(path.join(destination, "build-receipt.json"), "utf8"),
    readFileSync(path.join(dist, "build-receipt.json"), "utf8"),
  );
});

// index.js, the Worker's WASM, wrangler.json and the shell's unhashed files
// carry no digest in their names, so only the receipt's `files` catches a change.
for (const file of [
  "index.js",
  "automerge.wasm",
  "sift.wasm",
  "wrangler.json",
  "public/index.html",
  "public/_headers",
])
  test(`staging refuses a tampered ${file}`, (t) => {
    const { root, dist, write } = bundle(t);
    write(file, "tampered");
    assert.throws(
      () => stageArtifacts(dist, path.join(root, "release")),
      new RegExp(`Release file changed since the build: ${file.replace(".", "[.]")}$`),
    );
    assert.equal(existsSync(path.join(root, "release")), false);
  });

test("staging refuses a receipt without files", (t) => {
  for (const files of [undefined, {}, [], { "index.js": "not-a-digest" }]) {
    const { root, dist } = bundle(t, () => files);
    assert.throws(
      () => stageArtifacts(dist, path.join(root, "release")),
      /must list the release files with their sha256/,
      JSON.stringify(files),
    );
    assert.equal(existsSync(path.join(root, "release")), false);
  }
});

test("staging refuses a receipt that lists an extra file", (t) => {
  for (const extra of [
    "unreviewed-worker.js",
    ".dev.vars",
    "public/extra.js",
    "build-receipt.json",
  ]) {
    const { root, dist, write } = bundle(t, (files) => ({
      ...files,
      [extra]: sha256("DO NOT SHIP"),
    }));
    write(extra === "build-receipt.json" ? "unused" : extra, "DO NOT SHIP");
    assert.throws(
      () => stageArtifacts(dist, path.join(root, "release")),
      /files differ from the release allowlist/,
      extra,
    );
    assert.equal(existsSync(path.join(root, "release")), false);
  }
});

test("staging refuses a receipt that leaves a release file out", (t) => {
  for (const missing of ["index.js", "public/connect.js", chunk]) {
    const { root, dist } = bundle(t, ({ [missing]: _, ...files }) => files);
    assert.throws(
      () => stageArtifacts(dist, path.join(root, "release")),
      /files differ from the release allowlist/,
      missing,
    );
    assert.equal(existsSync(path.join(root, "release")), false);
  }
});

test("staging refuses a missing release file", (t) => {
  const { root, dist } = bundle(t);
  rmSync(path.join(dist, "automerge.wasm"));
  assert.throws(() => stageArtifacts(dist, path.join(root, "release")), /automerge[.]wasm/);
  assert.equal(existsSync(path.join(root, "release")), false);
});

test("staging refuses a viewer digest that disagrees with files", (t) => {
  const { root, dist } = bundle(t, (files) => ({ ...files, [chunk]: sha256("other") }));
  assert.throws(
    () => stageArtifacts(dist, path.join(root, "release")),
    /lists two digests for public[/]chunks[/]ABCDEFGH[.]js/,
  );
});
