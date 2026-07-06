import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLOUD_APP_SESSION_ENDPOINT,
  cloudAppSessionIsFresh,
  cloudAppSessionNeedsRenewal,
  establishCloudAppSessionFromOidcTokenWithRetry,
  establishCloudAppSessionWithToken,
  isCloudAppSessionStatus,
  readCloudAppSessionStatus,
} from "../viewer/app-session.ts";
import type { CloudOidcTokenState } from "../viewer/oidc-auth.ts";

describe("cloud app session client", () => {
  it("reads app session status with same-origin credentials", async () => {
    const status = await readCloudAppSessionStatus({
      fetchImpl: async (input, init) => {
        assert.equal(input, CLOUD_APP_SESSION_ENDPOINT);
        assert.equal(init?.credentials, "same-origin");
        assert.deepEqual(init?.headers, { Accept: "application/json" });
        return Response.json({
          ok: true,
          session: { provider: "oidc", expires_at: 1_800, cache_key: "cache-a" },
        });
      },
    });

    assert.deepEqual(status, {
      ok: true,
      session: { provider: "oidc", expires_at: 1_800, cache_key: "cache-a" },
    });
  });

  it("accepts a missing app session", async () => {
    const status = await readCloudAppSessionStatus({
      fetchImpl: async () => Response.json({ ok: true, session: null }),
    });

    assert.deepEqual(status, { ok: true, session: null });
  });

  it("checks app session freshness with the same renewal skew as the viewer", () => {
    assert.equal(cloudAppSessionIsFresh(session(1_300), 1_000), true);
    assert.equal(cloudAppSessionIsFresh(session(1_060), 1_000), false);
    assert.equal(cloudAppSessionIsFresh(null, 1_000), false);
  });

  it("renews app sessions before the browser cookie expires", () => {
    assert.equal(cloudAppSessionNeedsRenewal(session(3_000), 1_000), false);
    assert.equal(cloudAppSessionNeedsRenewal(session(2_700), 1_000), true);
    assert.equal(cloudAppSessionNeedsRenewal(null, 1_000), true);
  });

  it("rejects identity-bearing status payloads", () => {
    assert.equal(
      isCloudAppSessionStatus({
        ok: true,
        session: {
          provider: "oidc",
          expires_at: 1_800,
          cache_key: "cache-a",
          email: "private@example.test",
        },
      }),
      false,
    );
    assert.equal(
      isCloudAppSessionStatus({
        ok: true,
        session: {
          provider: "oidc",
          expires_at: 1_800,
          cache_key: "cache-a",
          display_name: "Private User",
        },
      }),
      false,
    );
  });

  it("fails closed for invalid status responses", async () => {
    await assert.rejects(
      () =>
        readCloudAppSessionStatus({
          fetchImpl: async () =>
            Response.json({ ok: true, session: { provider: "oidc", expires_at: 1_800 } }),
        }),
      /response shape was invalid/,
    );
    await assert.rejects(
      () =>
        readCloudAppSessionStatus({
          fetchImpl: async () => new Response("nope", { status: 500 }),
        }),
      /Unable to read app session: 500/,
    );
  });

  it("retries a failed OIDC app-session POST once and resolves on success", async () => {
    const delays: number[] = [];
    let calls = 0;

    await establishCloudAppSessionFromOidcTokenWithRetry(oidcToken(), {
      fetchImpl: async (input, init) => {
        calls += 1;
        assert.equal(input, CLOUD_APP_SESSION_ENDPOINT);
        assert.equal(init?.credentials, "same-origin");
        assert.equal(init?.method, "POST");
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer access-token");
        return calls === 1 ? new Response("try again", { status: 503 }) : new Response(null);
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
      timeoutSignal: stableTimeoutSignal,
    });

    assert.equal(calls, 2);
    assert.deepEqual(delays, [250]);
  });

  it("rejects after two failed OIDC app-session POST attempts", async () => {
    let calls = 0;

    await assert.rejects(
      () =>
        establishCloudAppSessionFromOidcTokenWithRetry(oidcToken(), {
          fetchImpl: async () => {
            calls += 1;
            return new Response("still down", { status: 503 });
          },
          sleep: async () => {},
          timeoutSignal: stableTimeoutSignal,
        }),
      /Unable to establish app session: 503/,
    );

    assert.equal(calls, 2);
  });

  it("threads an explicit signal through the app-session POST", async () => {
    const controller = new AbortController();

    await establishCloudAppSessionWithToken("access-token", {
      signal: controller.signal,
      fetchImpl: async (_input, init) => {
        assert.equal(init?.signal, controller.signal);
        return new Response(null);
      },
    });
  });
});

function session(expiresAt: number) {
  return { provider: "oidc" as const, expires_at: expiresAt, cache_key: "cache-a" };
}

function oidcToken(): CloudOidcTokenState {
  return {
    accessToken: "access-token",
    refreshToken: null,
    expiresAt: 1_800,
    claims: { sub: "anaconda-user-123" },
  };
}

function stableTimeoutSignal(): AbortSignal {
  return new AbortController().signal;
}
