import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { catalogUploads } from "./publish-library-catalog.mjs";

test("a catalog publishes every file under its revision, manifest last", async (t) => {
  const dist = await mkdtemp(path.join(tmpdir(), "catalog-"));
  t.after(() => rm(dist, { recursive: true, force: true }));
  const revision = "b".repeat(64);
  const dir = path.join(dist, "public/catalog", revision);
  await mkdir(dir, { recursive: true });
  for (const name of ["manifest.json", "d3.js", "chunk-ABC.js", "sift.wasm"])
    await writeFile(path.join(dir, name), name);
  const uploads = await catalogUploads(dist);
  assert.deepEqual(
    uploads.map(({ key, contentType }) => [key, contentType]),
    [
      [`catalog/${revision}/chunk-ABC.js`, "text/javascript; charset=utf-8"],
      [`catalog/${revision}/d3.js`, "text/javascript; charset=utf-8"],
      [`catalog/${revision}/sift.wasm`, "application/wasm"],
      [`catalog/${revision}/manifest.json`, "application/json; charset=utf-8"],
    ],
  );
  assert.equal(uploads[0].file, path.join(dir, "chunk-ABC.js"));
  await writeFile(path.join(dir, "notes.txt"), "x");
  await assert.rejects(catalogUploads(dist), /cannot hold notes.txt/);
  await rm(path.join(dir, "notes.txt"));
  await mkdir(path.join(dist, "public/catalog", "latest"));
  await assert.rejects(catalogUploads(dist), /not a catalog revision/);
});
