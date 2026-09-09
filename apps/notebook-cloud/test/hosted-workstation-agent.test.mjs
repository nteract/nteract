import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertWorkstationAuthKindAllowedForBaseUrl,
  buildWorkstationAuthHeaders,
  buildAttachJobSpawnPlan,
  buildRuntimeAgentEnv,
  buildWorkstationRegistrationPayload,
  devPrincipalForUser,
  normalizeWorkstationAuthKind,
  parseHttpResponseBody,
  parsePositiveInteger,
  resolveWorkstationCredential,
  retryAfterMs,
  retryCooldownMs,
  runtimePeerExitMessage,
  STALE_WORKSTATION_RETRYABLE_STATUS_CODES,
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
      "--runtime-session-id",
      "Job 123",
      "--workstation-display-name",
      "lab2 workstation",
    ]);
  });

  it("uses execute launch mode for resume attach jobs", () => {
    const plan = buildAttachJobSpawnPlan({
      job: {
        job_id: "job-resume",
        notebook_id: "nb-resume",
        trigger: "resume",
      },
      pythonPath: "/opt/k/bin/python",
      agentRoot: "/tmp/agent",
      baseUrl: "https://preview.runt.run",
      workingDirectory: "/home/ubuntu/project",
      workstationId: "ws-lab2",
      displayName: "lab2 workstation",
    });

    assert.equal(
      plan.args.some((arg, index) => arg === "--launch-mode" && plan.args[index + 1] === "execute"),
      true,
    );
    assert.equal(plan.args.includes("/opt/k/bin/python"), true);
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
    assert.equal(normalizeWorkstationAuthKind("dev"), "dev");
    assert.throws(() => normalizeWorkstationAuthKind("cookie"), /WORKSTATION_AUTH_KIND/);
  });

  it("sends the loopback dev credential trio instead of a bearer for dev auth", () => {
    assert.deepEqual(
      buildWorkstationAuthHeaders("dev", "local-loopback-dev-token", { devUser: "smoke" }),
      {
        "X-Notebook-Cloud-Dev-Token": "local-loopback-dev-token",
        "X-User": "smoke",
        "X-Scope": "owner",
      },
    );
    assert.deepEqual(
      buildWorkstationAuthHeaders("dev", "tok", { devUser: "smoke", scope: "runtime_peer" })[
        "X-Scope"
      ],
      "runtime_peer",
    );
    assert.throws(
      () => buildWorkstationAuthHeaders("dev", "local-loopback-dev-token"),
      /NOTEBOOK_CLOUD_DEV_USER/,
    );
    assert.equal(devPrincipalForUser("smoke"), "user:dev:smoke");
    assert.equal(devPrincipalForUser("smoke user"), "user:dev:smoke%20user");
  });

  it("passes the dev user label to the runtime peer only for dev auth", () => {
    const devEnv = buildRuntimeAgentEnv({ HOME: "/home/dev", PATH: "/usr/bin" }, "dev-token", {
      authKind: "dev",
      devUser: "smoke",
    });
    assert.equal(devEnv.RUNT_CLOUD_TOKEN, "dev-token");
    assert.equal(devEnv.RUNT_CLOUD_DEV_USER, "smoke");

    const bearerEnv = buildRuntimeAgentEnv({ HOME: "/home/dev", PATH: "/usr/bin" }, "key", {
      authKind: "anaconda-key",
      devUser: "smoke",
    });
    assert.equal(bearerEnv.RUNT_CLOUD_TOKEN, "key");
    assert.equal(bearerEnv.RUNT_CLOUD_DEV_USER, undefined);
  });

  it("spawns dev-auth runtime peers only against loopback Workers", () => {
    const spawn = (baseUrl) =>
      buildAttachJobSpawnPlan({
        job: { job_id: "job-dev", notebook_id: "nb-dev" },
        pythonPath: "/opt/k/bin/python",
        agentRoot: "/tmp/agent",
        baseUrl,
        workingDirectory: "/home/dev/project",
        workstationId: "ws-dev",
        displayName: "dev workstation",
        authKind: "dev",
      });

    for (const baseUrl of [
      "http://127.0.0.1:45123",
      "http://localhost:8787",
      "http://[::1]:8787",
    ]) {
      const plan = spawn(baseUrl);
      assert.deepEqual(plan.args.slice(0, 3), ["cloud-runtime-agent", "--auth-kind", "dev"]);
      assert.equal(plan.args.includes("local-loopback-dev-token"), false);
    }

    assert.throws(() => spawn("https://preview.runt.run"), /only allowed against a loopback/);
    assert.throws(
      () => assertWorkstationAuthKindAllowedForBaseUrl("dev", "https://preview.runt.run"),
      /refusing https:\/\/preview\.runt\.run/,
    );
    assert.equal(
      assertWorkstationAuthKindAllowedForBaseUrl("anaconda-key", "https://preview.runt.run"),
      "anaconda-key",
    );
  });

  it("resolves the dev credential from NOTEBOOK_CLOUD_DEV_TOKEN and NOTEBOOK_CLOUD_DEV_USER", () => {
    assert.deepEqual(
      resolveWorkstationCredential(
        {
          NOTEBOOK_CLOUD_DEV_TOKEN: "local-loopback-dev-token",
          NOTEBOOK_CLOUD_DEV_USER: "smoke",
          NTERACT_API_KEY: "ignored-for-dev",
        },
        "dev",
      ),
      { authKind: "dev", credential: "local-loopback-dev-token", devUser: "smoke" },
    );
    assert.deepEqual(
      resolveWorkstationCredential({ NOTEBOOK_CLOUD_DEV_TOKEN: "tok" }, "dev", {
        defaultDevUser: "runtime-peer-smoke",
      }),
      { authKind: "dev", credential: "tok", devUser: "runtime-peer-smoke" },
    );
    assert.throws(
      () => resolveWorkstationCredential({ NOTEBOOK_CLOUD_DEV_USER: "smoke" }, "dev"),
      /NOTEBOOK_CLOUD_DEV_TOKEN/,
    );
    assert.throws(
      () => resolveWorkstationCredential({ NOTEBOOK_CLOUD_DEV_TOKEN: "tok" }, "dev"),
      /NOTEBOOK_CLOUD_DEV_USER/,
    );
    assert.deepEqual(
      resolveWorkstationCredential(
        { NTERACT_API_KEY: "key-secret", NOTEBOOK_CLOUD_DEV_TOKEN: "unused" },
        "anaconda-key",
      ),
      { authKind: "anaconda-key", credential: "key-secret", devUser: null },
    );
    assert.throws(() => resolveWorkstationCredential({}, "oidc"), /NTERACT_API_KEY/);
  });

  it("projects stable registration metadata for the current Python launcher", () => {
    assert.deepEqual(
      buildWorkstationRegistrationPayload({
        workstationId: "ws-lab2",
        displayName: "lab2 workstation",
        workingDirectory: "/home/ubuntu/project",
        pythonPath: "/opt/k/bin/python",
        installedBuild: "0.1.0+abc123",
        channel: "nightly",
        cpuCount: 8,
        memoryBytes: 16_000_000_000,
      }),
      {
        workstation_id: "ws-lab2",
        display_name: "lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        installed_build: "0.1.0+abc123",
        channel: "nightly",
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

  it("omits hosted agent build metadata when no detector supplies it", () => {
    const payload = buildWorkstationRegistrationPayload({
      workstationId: "ws-hosted",
      displayName: "hosted workstation",
      workingDirectory: "/home/ubuntu/project",
      pythonPath: "/opt/k/bin/python",
      cpuCount: 8,
      memoryBytes: 16_000_000_000,
    });

    assert.equal(Object.hasOwn(payload, "installed_build"), false);
    assert.equal(Object.hasOwn(payload, "channel"), false);
  });

  it("keeps generated workstation ids and polling intervals bounded", () => {
    assert.equal(stableWorkstationId("lab2.example.internal"), "ws-lab2.example.internal");
    assert.equal(stableWorkstationId("!!!"), "ws-local");
    assert.equal(parsePositiveInteger(undefined, "TEST_INTERVAL", 2000), 2000);
    assert.equal(parsePositiveInteger("15", "TEST_INTERVAL", 2000), 15);
    assert.throws(() => parsePositiveInteger("0", "TEST_INTERVAL", 2000), /positive integer/);
  });

  it("parses response bodies once and preserves non-json error pages", async () => {
    assert.deepEqual(await parseHttpResponseBody(new Response(null, { status: 204 })), {});
    assert.deepEqual(
      await parseHttpResponseBody(
        new Response(JSON.stringify({ jobs: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
      { jobs: [] },
    );

    const body = await parseHttpResponseBody(
      new Response("<html><title>Error 1027</title>Please check back later</html>", {
        status: 429,
        headers: { "Content-Type": "text/html" },
      }),
    );
    assert.match(body.error, /Error 1027/);
  });

  it("backs off workstation polling when the cloud asks for retry", () => {
    assert.equal(retryAfterMs(new Response("ok", { status: 200 })), 0);
    assert.equal(
      retryAfterMs(new Response("slow down", { status: 429, headers: { "Retry-After": "7" } })),
      7_000,
    );
    const retryDate = new Date(Date.now() + 8_000).toUTCString();
    const retryDateDelay = retryAfterMs(
      new Response("slow down", { status: 429, headers: { "Retry-After": retryDate } }),
    );
    assert.ok(
      retryDateDelay >= 1_000 && retryDateDelay <= 8_500,
      `date retry delay should be bounded, got ${retryDateDelay}`,
    );
    assert.equal(retryAfterMs(new Response("no hint", { status: 503 }), 12_345), 12_345);
    assert.equal(retryAfterMs(new Response("missing", { status: 404 })), 0);
    assert.equal(
      retryAfterMs(
        new Response("missing", {
          status: 404,
          headers: { "Retry-After": "900" },
        }),
        undefined,
        STALE_WORKSTATION_RETRYABLE_STATUS_CODES,
      ),
      900_000,
    );
    assert.equal(
      retryAfterMs(
        new Response("gone", { status: 410 }),
        undefined,
        STALE_WORKSTATION_RETRYABLE_STATUS_CODES,
      ),
      900_000,
    );
  });

  it("expands retry cooldowns for repeated rate-limit responses", () => {
    assert.equal(
      retryCooldownMs({
        retryAfterMs: 60_000,
        failureCount: 1,
        random: () => 0,
      }),
      60_000,
    );
    assert.equal(
      retryCooldownMs({
        retryAfterMs: 60_000,
        failureCount: 2,
        random: () => 0,
      }),
      120_000,
    );
    assert.equal(
      retryCooldownMs({
        retryAfterMs: 60_000,
        failureCount: 8,
        random: () => 0,
      }),
      900_000,
    );
    assert.equal(
      retryCooldownMs({
        retryAfterMs: 10_000,
        failureCount: 1,
        jitterRatio: 0.2,
        random: () => 0.5,
      }),
      11_000,
    );
  });

  it("formats runtime peer exit messages without empty signal details", () => {
    assert.equal(runtimePeerExitMessage(1, null), "Runtime peer exited with code=1");
    assert.equal(
      runtimePeerExitMessage(null, "SIGTERM"),
      "Runtime peer exited with signal=SIGTERM",
    );
    assert.equal(
      runtimePeerExitMessage(1, "SIGTERM"),
      "Runtime peer exited with code=1, signal=SIGTERM",
    );
    assert.equal(runtimePeerExitMessage(null, null), "Runtime peer exited");
  });
});
