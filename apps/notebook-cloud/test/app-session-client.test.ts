import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLOUD_APP_SESSION_ENDPOINT,
  cloudAppSessionIsFresh,
  cloudAppSessionNeedsRenewal,
  isCloudAppSessionStatus,
  readCloudAppSessionStatus,
} from "../viewer/app-session.ts";

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
    assert.equal(
      cloudAppSessionIsFresh({ provider: "oidc", expires_at: 1_300, cache_key: "cache-a" }, 1_000),
      true,
    );
    assert.equal(
      cloudAppSessionIsFresh({ provider: "oidc", expires_at: 1_060, cache_key: "cache-a" }, 1_000),
      false,
    );
    assert.equal(cloudAppSessionIsFresh(null, 1_000), false);
  });

  it("renews app sessions before the browser cookie expires", () => {
    assert.equal(
      cloudAppSessionNeedsRenewal(
        { provider: "oidc", expires_at: 3_000, cache_key: "cache-a" },
        1_000,
      ),
      false,
    );
    assert.equal(
      cloudAppSessionNeedsRenewal(
        { provider: "oidc", expires_at: 2_700, cache_key: "cache-a" },
        1_000,
      ),
      true,
    );
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
});
