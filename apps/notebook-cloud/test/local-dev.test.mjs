import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_LOCAL_BROWSER_AUTH_SCOPE,
  DEFAULT_LOCAL_BROWSER_AUTH_USER,
  WRANGLER_HTTP_PORT_BASE,
  WRANGLER_INSPECTOR_PORT_BASE,
  WRANGLER_PORT_RANGE,
  notebookCloudBaseUrl,
  notebookCloudDevPorts,
  notebookCloudLocalAuthUrl,
  notebookCloudLoopbackUrl,
} from "../scripts/local-dev.mjs";

test("derives stable Wrangler ports from the workspace root", () => {
  const workspaceRoot = "/tmp/nteract/worktrees/cloud-a/desktop";
  const first = notebookCloudDevPorts({ env: {}, workspaceRoot });
  const second = notebookCloudDevPorts({ env: {}, workspaceRoot });

  assert.equal(first.port, second.port);
  assert.equal(first.inspectorPort, second.inspectorPort);
  assert.equal(first.host, "127.0.0.1");
  assert.ok(first.port >= WRANGLER_HTTP_PORT_BASE);
  assert.ok(first.port < WRANGLER_HTTP_PORT_BASE + WRANGLER_PORT_RANGE);
  assert.ok(first.inspectorPort >= WRANGLER_INSPECTOR_PORT_BASE);
  assert.ok(first.inspectorPort < WRANGLER_INSPECTOR_PORT_BASE + WRANGLER_PORT_RANGE);
});

test("honors explicit local port and host overrides", () => {
  const env = {
    NOTEBOOK_CLOUD_WRANGLER_HOST: "localhost",
    NOTEBOOK_CLOUD_WRANGLER_PORT: "45123",
    NOTEBOOK_CLOUD_WRANGLER_INSPECTOR_PORT: "46123",
  };

  const ports = notebookCloudDevPorts({
    env,
    workspaceRoot: "/tmp/nteract/worktrees/cloud-b/desktop",
  });

  assert.equal(ports.host, "localhost");
  assert.equal(ports.port, 45123);
  assert.equal(ports.inspectorPort, 46123);
  assert.equal(
    notebookCloudLoopbackUrl({ env, workspaceRoot: "/tmp/nteract/worktrees/cloud-b/desktop" }),
    "http://localhost:45123",
  );
});

test("prefers NTERACT_CLOUD_URL when a script targets a deployed host", () => {
  const baseUrl = notebookCloudBaseUrl({
    env: { NTERACT_CLOUD_URL: "https://preview.runt.run" },
    workspaceRoot: "/tmp/nteract/worktrees/cloud-c/desktop",
  });

  assert.equal(baseUrl, "https://preview.runt.run");
});

test("keeps NOTEBOOK_CLOUD_URL as a deployed host alias", () => {
  const baseUrl = notebookCloudBaseUrl({
    env: { NOTEBOOK_CLOUD_URL: "https://preview.runt.run" },
    workspaceRoot: "/tmp/nteract/worktrees/cloud-c/desktop",
  });

  assert.equal(baseUrl, "https://preview.runt.run");
});

test("builds a loopback Browser auth bootstrap URL", () => {
  const url = new URL(
    notebookCloudLocalAuthUrl({
      env: {
        NOTEBOOK_CLOUD_WRANGLER_HOST: "localhost",
        NOTEBOOK_CLOUD_WRANGLER_PORT: "45124",
      },
      workspaceRoot: "/tmp/nteract/worktrees/cloud-browser/desktop",
    }),
  );

  assert.equal(url.origin, "http://localhost:45124");
  assert.equal(url.pathname, "/local-auth");
  assert.equal(url.searchParams.get("user"), DEFAULT_LOCAL_BROWSER_AUTH_USER);
  assert.equal(url.searchParams.get("scope"), DEFAULT_LOCAL_BROWSER_AUTH_SCOPE);
  assert.equal(url.searchParams.get("next"), "/n");
});

test("rejects invalid port overrides", () => {
  assert.throws(
    () =>
      notebookCloudDevPorts({
        env: { NOTEBOOK_CLOUD_WRANGLER_PORT: "nope" },
        workspaceRoot: "/tmp/nteract/worktrees/cloud-d/desktop",
      }),
    /NOTEBOOK_CLOUD_WRANGLER_PORT must be an integer TCP port/,
  );
});
