import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ec2LocalWorkerPlan } from "../scripts/ec2-local-worker.mjs";

describe("EC2 local Worker wrapper", () => {
  it("runs Wrangler local dev with persisted state and same-origin assets by default", () => {
    const plan = ec2LocalWorkerPlan({
      appDir: "/repo/apps/notebook-cloud",
      workspaceRoot: "/repo",
      env: {
        NOTEBOOK_CLOUD_DEV_TOKEN: "dev-secret",
        NOTEBOOK_CLOUD_EC2_PUBLIC_ORIGIN: "https://notebooks.example.test/app",
      },
    });

    assert.equal(plan.publicOrigin, "https://notebooks.example.test");
    assert.equal(plan.generatedDevToken, false);
    assert.deepEqual(plan.args.slice(0, 12), [
      "--workspace-root",
      "exec",
      "wrangler",
      "dev",
      "--config",
      "apps/notebook-cloud/wrangler.toml",
      "--local",
      "--ip",
      "0.0.0.0",
      "--port",
      "8787",
      "--persist-to",
    ]);
    assert.equal(plan.args.includes("/repo/.context/ec2/notebook-cloud-state"), true);
    assert.equal(varValue(plan.args, "DEPLOYMENT_ENV"), "ec2");
    assert.equal(
      varValue(plan.args, "NOTEBOOK_CLOUD_ALLOWED_ORIGINS"),
      "https://notebooks.example.test",
    );
    assert.equal(varValue(plan.args, "NOTEBOOK_CLOUD_DEV_TOKEN"), "dev-secret");
    assert.equal(varValue(plan.args, "RENDERER_ASSETS_BASE_URL"), "");
    assert.equal(varValue(plan.args, "RUNTIMED_WASM_BASE_URL"), "");
    assert.equal(varValue(plan.args, "OUTPUT_DOCUMENT_BASE_URL"), "");
    assert.equal(varValue(plan.args, "NOTEBOOK_CLOUD_OIDC_ISSUER"), "");
    assert.equal(varValue(plan.args, "NOTEBOOK_CLOUD_OIDC_REDIRECT_URI"), "");
  });

  it("can enable OIDC when the deployment has a registered redirect URI", () => {
    const plan = ec2LocalWorkerPlan({
      appDir: "/repo/apps/notebook-cloud",
      workspaceRoot: "/repo",
      env: {
        NOTEBOOK_CLOUD_DEV_TOKEN: "dev-secret",
        NOTEBOOK_CLOUD_EC2_ENABLE_OIDC: "1",
        NOTEBOOK_CLOUD_EC2_PUBLIC_ORIGIN: "https://notebooks.example.test",
      },
    });

    assert.equal(plan.oidcEnabled, true);
    assert.equal(
      varValue(plan.args, "NOTEBOOK_CLOUD_OIDC_REDIRECT_URI"),
      "https://notebooks.example.test/oidc",
    );
    assert.equal(varValue(plan.args, "NOTEBOOK_CLOUD_OIDC_ISSUER"), null);
  });

  it("accepts explicit port, host, persistence path, and extra Wrangler args", () => {
    const plan = ec2LocalWorkerPlan({
      appDir: "/repo/apps/notebook-cloud",
      workspaceRoot: "/repo",
      env: {
        NOTEBOOK_CLOUD_DEV_TOKEN: "dev-secret",
        NOTEBOOK_CLOUD_EC2_HOST: "127.0.0.1",
        NOTEBOOK_CLOUD_EC2_PORT: "9876",
        NOTEBOOK_CLOUD_EC2_PERSIST_TO: "/var/lib/nteract-cloud",
        NOTEBOOK_CLOUD_EC2_WRANGLER_ARGS: "--log-level debug",
      },
    });

    assert.equal(plan.host, "127.0.0.1");
    assert.equal(plan.port, 9876);
    assert.equal(plan.publicOrigin, "http://localhost:9876");
    assert.equal(plan.persistTo, "/var/lib/nteract-cloud");
    assert.deepEqual(plan.args.slice(-2), ["--log-level", "debug"]);
  });
});

function varValue(args, name) {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== "--var") continue;
    const value = args[index + 1];
    if (value.startsWith(`${name}:`)) {
      return value.slice(name.length + 1);
    }
  }
  return null;
}
