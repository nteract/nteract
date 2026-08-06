import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { describe, it } from "node:test";

import { CELLD_DRY_RUN_BUCKET, celldDryRunArgs } from "../scripts/celld-dry-run.mjs";

const CONFIG_URL = new URL("../wrangler.celld.jsonc", import.meta.url);
const ESBUILD_WRAPPER_URL = new URL("../scripts/celld-esbuild.sh", import.meta.url);

describe("celld packaging spike", () => {
  it("declares only the currently active Durable Object classes", async () => {
    const config = await readConfig();

    assert.deepEqual(config.durable_objects.bindings, [
      { name: "NOTEBOOK_ROOMS", class_name: "NotebookRoom" },
      { name: "WORKSTATION_EVENTS", class_name: "WorkstationEvents" },
      { name: "OWNER_COMPUTE_INDEX", class_name: "OwnerComputeIndex" },
    ]);
    assert.deepEqual(config.migrations, [
      {
        tag: "celld-v1",
        new_sqlite_classes: ["NotebookRoom", "WorkstationEvents", "OwnerComputeIndex"],
      },
    ]);
  });

  it("keeps unsupported D1 and R2 bindings out of the celld manifest", async () => {
    const config = await readConfig();

    assert.equal("d1_databases" in config, false);
    assert.equal("r2_buckets" in config, false);
    assert.deepEqual(config.assets, {
      directory: "./dist",
      binding: "ASSETS",
      run_worker_first: true,
    });
  });

  it("uses a non-writing deployment command and the WASM loader override", async () => {
    const wrapper = await readFile(ESBUILD_WRAPPER_URL, "utf8");
    const wrapperStat = await stat(ESBUILD_WRAPPER_URL);
    const args = celldDryRunArgs("/tmp/wrangler.celld.jsonc");

    assert.notEqual(wrapperStat.mode & 0o111, 0);
    assert.match(wrapper, /--loader:\.wasm=binary/);
    assert.deepEqual(args, [
      "deploy",
      "--config",
      "/tmp/wrangler.celld.jsonc",
      "--bucket",
      CELLD_DRY_RUN_BUCKET,
      "--dry-run",
    ]);
  });
});

async function readConfig() {
  const source = await readFile(CONFIG_URL, "utf8");
  return JSON.parse(source.replace(/,\s*([}\]])/g, "$1"));
}
