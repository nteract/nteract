import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectPreviewAuthHealth,
  formatHealthSummary,
  parseArgs,
  parseEnvFile,
  parseSystemdProperties,
  readApiKeyHealth,
  summarizeSystemd,
  summarizeToken,
} from "../scripts/preview-auth-health.mjs";

describe("preview auth health helpers", () => {
  it("parses preview env files without requiring dotenv", () => {
    assert.deepEqual(
      parseEnvFile(`
        # comment
        export NTERACT_CLOUD_URL="https://preview.runt.run"
        NTERACT_API_KEY='secret value'
        IGNORED LINE
        NOTEBOOK_CLOUD_LIVE_ROOM_AUTH=anonymous # inline comment
      `),
      {
        NTERACT_CLOUD_URL: "https://preview.runt.run",
        NTERACT_API_KEY: "secret value",
        NOTEBOOK_CLOUD_LIVE_ROOM_AUTH: "anonymous",
      },
    );
  });

  it("summarizes token freshness without leaking token or email material", () => {
    const summary = summarizeToken(
      {
        accessToken: "secret-access-token",
        refreshToken: "secret-refresh-token",
        expiresAt: 1_000_000,
        claims: {
          sub: "subject-123",
          email: "agent@example.test",
        },
      },
      {
        mode: 0o600,
        now: new Date(999_000 * 1000),
      },
    );

    assert.equal(summary.status, "ok");
    assert.equal(summary.expires_in_minutes, 17);
    assert.equal(summary.has_access_token, true);
    assert.equal(summary.has_refresh_token, true);
    assert.equal(summary.has_subject_claim, true);
    assert.equal(summary.has_email_claim, true);

    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes("secret-access-token"), false);
    assert.equal(serialized.includes("secret-refresh-token"), false);
    assert.equal(serialized.includes("agent@example.test"), false);
    assert.equal(serialized.includes("subject-123"), false);
  });

  it("marks expired or soon-expiring tokens as unhealthy", () => {
    const freshOptions = { mode: 0o600, now: new Date(1_000 * 1000), minTokenSeconds: 900 };
    const baseToken = {
      accessToken: "access",
      refreshToken: "refresh",
      claims: { sub: "subject" },
    };

    assert.deepEqual(
      summarizeToken({ ...baseToken, expiresAt: 1_100 }, freshOptions).status,
      "warn",
    );
    assert.deepEqual(summarizeToken({ ...baseToken, expiresAt: 999 }, freshOptions).status, "fail");
  });

  it("parses and summarizes systemd user timer state", () => {
    const timer = parseSystemdProperties(`
      ActiveState=active
      UnitFileState=enabled
      NextElapseUSecRealtime=Mon 2026-06-08 16:30:58 UTC
    `);
    const service = parseSystemdProperties(`
      ActiveState=inactive
      Result=success
      ExecMainStatus=0
    `);

    assert.deepEqual(
      summarizeSystemd({
        service,
        serviceUnit: "preview-oidc-refresh.service",
        timer,
        timerUnit: "preview-oidc-refresh.timer",
      }),
      {
        status: "ok",
        reason: "timer_active_last_run_success",
        timer_unit: "preview-oidc-refresh.timer",
        timer_active_state: "active",
        timer_unit_file_state: "enabled",
        timer_next_elapsed: "Mon 2026-06-08 16:30:58 UTC",
        timer_last_trigger: null,
        service_unit: "preview-oidc-refresh.service",
        service_active_state: "inactive",
        service_result: "success",
        service_exec_main_status: "0",
        service_inactive_exit_timestamp: null,
      },
    );

    assert.equal(
      summarizeSystemd({
        service: { Result: "exit-code", ExecMainStatus: "1" },
        serviceUnit: "preview-oidc-refresh.service",
        timer,
        timerUnit: "preview-oidc-refresh.timer",
      }).status,
      "fail",
    );
  });

  it("checks the preview API key without leaking credential material", async () => {
    const health = await readApiKeyHealth({
      cloudUrl: "https://preview.runt.run",
      env: { NTERACT_API_KEY: "secret-api-key" },
      fetchImpl: async (input, init) => {
        assert.equal(String(input), "https://preview.runt.run/api/n?limit=1");
        const headers = new Headers(init.headers);
        assert.equal(headers.get("Authorization"), "Bearer secret-api-key");
        assert.equal(headers.get("X-Notebook-Cloud-Auth-Provider"), "anaconda-api-key");
        return Response.json({ ok: true, notebooks: [{ id: "one" }] });
      },
    });

    assert.deepEqual(health, {
      status: "ok",
      reason: "api_key_smoke_ok",
      cloud_url: "https://preview.runt.run",
      endpoint: "/api/n?limit=1",
      http_status: 200,
      response_ok: true,
      body_ok: true,
      notebook_count: 1,
    });
    assert.equal(JSON.stringify(health).includes("secret-api-key"), false);
  });

  it("collects a non-secret health summary", async () => {
    const health = await collectPreviewAuthHealth({
      env: {},
      envPath: "/missing.env",
      fetchImpl: async () => Response.json({ ok: true, notebooks: [] }),
      network: false,
      now: new Date(999_000 * 1000),
      systemd: false,
      tokenPath: "/missing-token.json",
    });

    assert.equal(health.status, "fail");
    assert.equal(health.checks.token.reason, "missing_token_file");
    assert.equal(health.checks.preview_env.has_api_key, false);
    assert.equal(health.checks.preview_env.values, undefined);
    assert.equal(health.checks.api_key.status, "skipped");
  });

  it("formats a compact one-line status", () => {
    const line = formatHealthSummary(
      {
        status: "ok",
        checks: {
          token: { status: "ok", reason: "fresh", expires_in_minutes: 42 },
          systemd: { status: "ok", reason: "timer_active_last_run_success" },
          api_key: { status: "ok", reason: "api_key_smoke_ok" },
        },
      },
      "/tmp/health.json",
    );

    assert.equal(
      line,
      "[preview-auth-health] overall=ok token=ok:fresh token_expires_in=42m oidc_timer=ok:timer_active_last_run_success api_key=ok:api_key_smoke_ok status=/tmp/health.json",
    );
  });

  it("parses CLI options", () => {
    assert.deepEqual(
      parseArgs(
        [
          "--json",
          "--no-network",
          "--no-systemd",
          "--no-write",
          "--cloud-url=https://preview.runt.run",
          "--env",
          "/tmp/env",
          "--token=/tmp/token.json",
          "--status-path",
          "/tmp/status.json",
          "--min-token-seconds=120",
        ],
        {},
      ),
      {
        cloudUrl: "https://preview.runt.run",
        envPath: "/tmp/env",
        json: true,
        minTokenSeconds: 120,
        network: false,
        serviceUnit: "preview-oidc-refresh.service",
        statusPath: "/tmp/status.json",
        systemd: false,
        timerUnit: "preview-oidc-refresh.timer",
        tokenPath: "/tmp/token.json",
        writeStatus: false,
      },
    );
  });
});
