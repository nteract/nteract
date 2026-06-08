import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLOUD_APP_SESSION_ENDPOINT,
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
          session: { provider: "oidc", expires_at: 1_800 },
        });
      },
    });

    assert.deepEqual(status, {
      ok: true,
      session: { provider: "oidc", expires_at: 1_800 },
    });
  });

  it("accepts a missing app session", async () => {
    const status = await readCloudAppSessionStatus({
      fetchImpl: async () => Response.json({ ok: true, session: null }),
    });

    assert.deepEqual(status, { ok: true, session: null });
  });

  it("rejects identity-bearing status payloads", () => {
    assert.equal(
      isCloudAppSessionStatus({
        ok: true,
        session: {
          provider: "oidc",
          expires_at: 1_800,
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
          fetchImpl: async () => Response.json({ ok: true, session: { provider: "oidc" } }),
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
