import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { parsePortableBuildArgs } from "../scripts/portable-host-build.mjs";
import { generatedCelldProofConfig, parseJsonc } from "../scripts/celld-proof-config.mjs";

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
    const config = parseJsonc(source);

    assert.equal(config.main, "./dist-portable/worker/index.js");
    // CellD's bundler discovers the generated artifact's sibling WASM module
    // and registers it as a compiled-module import. The pnpm workspace still
    // builds the application artifact; CellD does not build source packages.
    assert.equal(config.no_bundle, false);
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

  it("generates a disposable CellD config with separately scoped fleet and app identities", () => {
    const generated = generatedCelldProofConfig(
      { vars: { DEPLOYMENT_ENV: "celld-proof" } },
      {
        AWS_ACCESS_KEY_ID: "fleet-only",
        NOTEBOOK_CLOUD_S3_ACCESS_KEY_ID: "application-only",
        NOTEBOOK_CLOUD_S3_SECRET_ACCESS_KEY: "application-secret",
        NOTEBOOK_CLOUD_S3_BUCKET: "application-data",
        NOTEBOOK_CLOUD_S3_REGION: "us-east-1",
        NOTEBOOK_CLOUD_S3_ENDPOINT: "http://127.0.0.1:19000",
        NOTEBOOK_CLOUD_S3_FORCE_PATH_STYLE: "true",
        NOTEBOOK_CLOUD_DEV_TOKEN: "local-dev-token",
      },
    );

    assert.equal(generated.vars.AWS_ACCESS_KEY_ID, "application-only");
    assert.equal(generated.vars.NOTEBOOK_CLOUD_S3_BUCKET, "application-data");
    assert.equal(generated.vars.NOTEBOOK_CLOUD_TRUST_LOOPBACK_HEADERS, "true");
    assert.throws(
      () =>
        generatedCelldProofConfig(
          { vars: {} },
          {
            AWS_ACCESS_KEY_ID: "shared-key",
            NOTEBOOK_CLOUD_S3_ACCESS_KEY_ID: "shared-key",
          },
        ),
      /must differ/,
    );
  });
});
