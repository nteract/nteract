import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildWorkstationAuthHeaders,
  buildAttachJobSpawnPlan,
  buildRuntimeAgentEnv,
  buildWorkstationRegistrationPayload,
  normalizeWorkstationAuthKind,
  parsePositiveInteger,
  stableWorkstationId,
} from "../scripts/hosted-workstation-agent-core.mjs";

describe("hosted workstation agent launch contract", () => {
  it("launches runtime peers from the workstation cwd by default", () => {
    const plan = buildAttachJobSpawnPlan({
      job: {
        job_id: "Job 123",
        notebook_id: "nb-1",
      },
      pythonPath: "/opt/k/bin/python",
      agentRoot: "/tmp/agent",
      baseUrl: "https://preview.runt.run",
      workingDirectory: "/home/ubuntu/project",
      workstationId: "ws-lab2",
      displayName: "lab2 workstation",
    });

    assert.equal(plan.cwd, "/home/ubuntu/project");
    assert.equal(plan.blobRoot, "/tmp/agent/job-123/blobs");
    assert.equal(plan.logPath, "/tmp/agent/job-123/runtime-peer.log");
    assert.deepEqual(plan.args, [
      "cloud-runtime-agent",
      "--auth-kind",
      "anaconda-key",
      "--cloud-url",
      "https://preview.runt.run",
      "--notebook-id",
      "nb-1",
      "--scope",
      "runtime_peer",
      "--python-path",
      "/opt/k/bin/python",
      "--blob-root",
      "/tmp/agent/job-123/blobs",
      "--working-dir",
      "/home/ubuntu/project",
      "--workstation-id",
      "ws-lab2",
      "--workstation-display-name",
      "lab2 workstation",
    ]);
  });

  it("can launch runtime peers with OIDC bearer auth without an API-key provider header", () => {
    const plan = buildAttachJobSpawnPlan({
      job: {
        job_id: "job-oidc",
        notebook_id: "nb-oidc",
      },
      pythonPath: "/opt/k/bin/python",
      agentRoot: "/tmp/agent",
      baseUrl: "https://preview.runt.run",
      workingDirectory: "/home/ubuntu/project",
      workstationId: "ws-lab2",
      displayName: "lab2 workstation",
      authKind: "oidc",
    });

    assert.deepEqual(plan.args.slice(0, 3), ["cloud-runtime-agent", "--auth-kind", "oidc"]);
    assert.equal(plan.args.includes("oidc-token"), false);
  });

  it("lets an attach job override cwd and notebook path without putting secrets in argv", () => {
    const plan = buildAttachJobSpawnPlan({
      job: {
        job_id: "job-2",
        notebook_id: "nb-2",
        working_directory: "/srv/notebook-project",
        notebook_path: "/srv/notebook-project/report.ipynb",
      },
      pythonPath: "/opt/k/bin/python",
      agentRoot: "/tmp/agent",
      baseUrl: "https://preview.runt.run",
      workingDirectory: "/home/ubuntu/project",
      workstationId: "ws-lab2",
      displayName: "lab2 workstation",
    });

    assert.equal(plan.cwd, "/srv/notebook-project");
    assert.deepEqual(plan.args.slice(-2), [
      "--notebook-path",
      "/srv/notebook-project/report.ipynb",
    ]);
    assert.equal(plan.args.includes("secret-api-key"), false);
  });

  it("passes the cloud credential only through the runtime peer environment", () => {
    const env = buildRuntimeAgentEnv(
      {
        HOME: "/home/ubuntu",
        PATH: "/usr/bin",
        NTERACT_API_KEY: "caller-secret",
        NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN: "fallback-secret",
      },
      "runtime-peer-secret",
    );

    assert.equal(env.RUNT_CLOUD_TOKEN, "runtime-peer-secret");
    assert.equal(env.NTERACT_API_KEY, undefined);
    assert.equal(env.NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN, undefined);
    assert.equal(env.HOME, "/home/ubuntu");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.RUST_LOG, "info");
  });

  it("builds workstation auth headers for API-key and OIDC credentials", () => {
    assert.deepEqual(buildWorkstationAuthHeaders("anaconda-key", "key-secret"), {
      Authorization: "Bearer key-secret",
      "X-Notebook-Cloud-Auth-Provider": "anaconda-api-key",
    });
    assert.deepEqual(buildWorkstationAuthHeaders("oidc", "oidc-secret"), {
      Authorization: "Bearer oidc-secret",
    });
    assert.equal(normalizeWorkstationAuthKind("anaconda-api-key"), "anaconda-key");
    assert.equal(normalizeWorkstationAuthKind("oidc-bearer"), "oidc");
    assert.throws(() => normalizeWorkstationAuthKind("cookie"), /WORKSTATION_AUTH_KIND/);
  });

  it("projects stable registration metadata for the current Python launcher", () => {
    assert.deepEqual(
      buildWorkstationRegistrationPayload({
        workstationId: "ws-lab2",
        displayName: "lab2 workstation",
        workingDirectory: "/home/ubuntu/project",
        pythonPath: "/opt/k/bin/python",
        cpuCount: 8,
        memoryBytes: 16_000_000_000,
      }),
      {
        workstation_id: "ws-lab2",
        display_name: "lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        working_directory: "/home/ubuntu/project",
        cpu_count: 8,
        memory_bytes: 16_000_000_000,
        capabilities: {
          launch_current_python: true,
        },
        runtime: {
          binary: "runtimed",
          python_path: "/opt/k/bin/python",
        },
      },
    );
  });

  it("keeps generated workstation ids and polling intervals bounded", () => {
    assert.equal(stableWorkstationId("lab2.example.internal"), "ws-lab2.example.internal");
    assert.equal(stableWorkstationId("!!!"), "ws-local");
    assert.equal(parsePositiveInteger(undefined, "TEST_INTERVAL", 2000), 2000);
    assert.equal(parsePositiveInteger("15", "TEST_INTERVAL", 2000), 15);
    assert.throws(() => parsePositiveInteger("0", "TEST_INTERVAL", 2000), /positive integer/);
  });
});
