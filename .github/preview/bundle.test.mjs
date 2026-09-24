import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, mkdir, writeFile, symlink, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {gunzipSync} from "node:zlib";
import {pack, digest} from "./bundle.mjs";
import {SERVICES} from "./protocol.mjs";

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "nteract-preview-test-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  for (const service of SERVICES) {
    await mkdir(path.join(dir, service, "assets"), {recursive: true});
    await writeFile(path.join(dir, service, "index.js"), "export default {};");
    await writeFile(path.join(dir, service, "assets", "index.html"), "<html></html>");
    await writeFile(path.join(dir, service, "wrangler.json"), '{"secret":"must-stay-in-ci"}');
  }
  return dir;
}

test("packages the existing bundle format and strips all exporter configs", async t => {
  const dir = await fixture(t);
  await mkdir(path.join(dir, "main", "migrations"));
  await writeFile(path.join(dir, "main", "migrations", "0001.sql"), "SELECT 1;");
  await writeFile(path.join(dir, "main", "example.wasm"), new Uint8Array([0, 97, 115, 109]));
  const bytes = await pack(dir, "a".repeat(40));
  const json = gunzipSync(bytes).toString("utf8");
  const bundle = JSON.parse(json);
  assert.equal(bundle.format, "nteract-preview-v1");
  assert.equal(bundle.sourceSha, "a".repeat(40));
  assert.equal(bundle.files.length, 10);
  assert.ok(!json.includes("must-stay-in-ci") && !json.includes("wrangler.json"));
  assert.ok(bundle.files.every(file => digest(Buffer.from(file.content, "base64")) === file.sha256));
  assert.deepEqual(await pack(dir, "a".repeat(40)), bytes);
});

test("rejects symlinks, including a linked exporter config", async t => {
  const dir = await fixture(t);
  await rm(path.join(dir, "main", "wrangler.json"));
  await symlink(path.join(dir, "outputs", "wrangler.json"), path.join(dir, "main", "wrangler.json"));
  await assert.rejects(pack(dir, "a".repeat(40)), /Symlink/);
});

test("rejects unexpected root files instead of accidentally shipping secrets", async t => {
  const dir = await fixture(t);
  await writeFile(path.join(dir, "main", ".env"), "PRIVATE_TOKEN=test");
  await assert.rejects(pack(dir, "a".repeat(40)), /not code, assets, or migrations/);
});

test("requires all service entrypoints and static assets", async t => {
  const dir = await fixture(t);
  await rm(path.join(dir, "outputs", "assets", "index.html"));
  await assert.rejects(pack(dir, "a".repeat(40)), /Missing outputs assets/);
});
