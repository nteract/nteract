import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { parsePortableBuildArgs } from "../scripts/portable-host-build.mjs";

const CELLD_CONFIG_URL = new URL("../wrangler.celld.jsonc", import.meta.url);

describe("portable notebook-cloud host artifact", () => {
  it("parses deterministic build controls", () => {
    assert.deepEqual(parsePortableBuildArgs([]), {
      output: undefined,
      skipApplicationBuild: false,
    });
    assert.deepEqual(
      parsePortableBuildArgs(["--skip-application-build", "--output", "/tmp/artifact"]),
      { output: "/tmp/artifact", skipApplicationBuild: true },
    );
    assert.throws(() => parsePortableBuildArgs(["--mystery"]), /unknown argument/);
  });

  it("uses the prebuilt workspace artifact and the current D1 migrations in CellD", async () => {
    const source = await readFile(CELLD_CONFIG_URL, "utf8");
    const config = JSON.parse(source.replace(/,\s*([}\]])/g, "$1"));

    assert.equal(config.main, "./dist-portable/worker/index.js");
    assert.equal(config.no_bundle, true);
    assert.deepEqual(config.d1_databases, [
      {
        binding: "DB",
        database_name: "nteract-notebook-cloud-celld-proof",
        database_id: "nteract-notebook-cloud-celld-proof",
        migrations_dir: "./migrations",
      },
    ]);
    assert.equal("r2_buckets" in config, false);
    assert.deepEqual(config.durable_objects.bindings, [
      { name: "NOTEBOOK_ROOMS", class_name: "PortableNotebookRoom" },
      { name: "WORKSTATION_EVENTS", class_name: "WorkstationEvents" },
      { name: "OWNER_COMPUTE_INDEX", class_name: "OwnerComputeIndex" },
    ]);
  });
});
