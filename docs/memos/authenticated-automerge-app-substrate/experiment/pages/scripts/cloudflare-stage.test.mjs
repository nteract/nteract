import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageCloudflareFiles, cloudflareConfig } from "./cloudflare-stage.mjs";
import { releaseArtifacts } from "./stage-artifacts.mjs";

test("Cloudflare staging separates native modules from browser assets and excludes local secrets/state", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pages-cloudflare-stage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dist = path.join(dir, "dist");
  mkdirSync(path.join(dist, "public"), { recursive: true });
  for (const file of releaseArtifacts) writeFileSync(path.join(dist, file), file);
  writeFileSync(path.join(dist, ".dev.vars"), "secret-that-must-stay-local");
  mkdirSync(path.join(dist, ".celld"));
  writeFileSync(path.join(dist, ".celld", "private.db"), "private");
  const destination = path.join(dir, "release");
  const id = "11111111-1111-4111-8111-111111111111";
  const config = JSON.parse(readFileSync(stageCloudflareFiles(dist, destination, id)));
  assert.deepEqual(readdirSync(destination).sort(), [
    "build-receipt.json",
    "public",
    "worker",
    "wrangler.json",
  ]);
  assert.deepEqual(readdirSync(path.join(destination, "worker")).sort(), [
    "automerge.wasm",
    "index.js",
    "subduction.wasm",
  ]);
  assert.equal(config.main, "worker/index.js");
  assert.equal(config.d1_databases[0].database_id, id);
  assert.equal(config.routes, undefined, "domain reassignment is a separate verified action");
  assert.equal(config.vars.NOTEBOOK_CLOUD_OIDC_REDIRECT_URI, "https://preview.runt.run/oidc");
  assert.equal(
    Object.keys(config.vars).some((k) => /SECRET|DEV_TOKEN|LOCAL_OIDC/.test(k)),
    false,
  );
  assert.throws(() => stageCloudflareFiles(dist, destination, id), /must be new/);
  assert.throws(() => cloudflareConfig("arbitrary database name"), /UUID/);
});
