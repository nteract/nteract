import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  accessHealthFromPayload,
  accessAuthHeaders,
  accessAuthProtocols,
  accessEmailFromJwt,
  accessPrincipalFromJwt,
  assertAccessHealthConfigured,
  assertHostedAccessSmokeEnv,
  webSocketUpgradeRequestHeaders,
} from "../scripts/hosted-access-smoke-env.mjs";
import { authenticateRequestWithProviders } from "../src/identity.ts";

describe("hosted Access smoke environment helpers", () => {
  it("maps Access subjects to principal rows without using email as the principal", () => {
    const token = jwt({ sub: "access-user-123", email: "alice@example.com" });

    assert.equal(accessPrincipalFromJwt(token), "user:cloudflare-access:access-user-123");
    assert.equal(accessEmailFromJwt(token), "alice@example.com");
  });

  it("builds Access HTTP headers and WebSocket subprotocol auth without URL tokens", async () => {
    const token = jwt({ sub: "access-user-123" });

    assert.deepEqual(accessAuthHeaders(token, { operator: "smoke:owner", scope: "owner" }), {
      "CF-Access-Token": token,
      "X-Operator": "smoke:owner",
      "X-Scope": "owner",
    });
    assert.deepEqual(accessAuthProtocols(token), [
      `nteract-access-token.${Buffer.from(token, "utf8").toString("base64url")}`,
    ]);
    await assert.doesNotReject(() =>
      authenticateRequestWithProviders(
        new Request("https://cloud.test/n/demo/sync", {
          headers: accessAuthHeaders(token),
        }),
      ),
    );
  });

  it("builds raw WebSocket Access upgrade headers with one Worker-visible credential", () => {
    const token = jwt({ sub: "access-user-123" });
    const headers = webSocketUpgradeRequestHeaders(
      new URL("wss://cloud.test/n/access-demo/sync?operator=smoke%3Aowner&scope=owner"),
      {
        key: "test-key",
        origin: "https://cloud.test",
        accessToken: token,
      },
    );

    assert.ok(headers.includes(`CF-Access-Token: ${token}`));
    assert.ok(!headers.some((header) => header.startsWith("Authorization:")));
    assert.equal(
      headers.filter((header) => /^CF-Access-Token:|^Authorization:|^Cookie:/i.test(header)).length,
      1,
    );
    assert.ok(!headers.some((header) => header.includes("nteract-access-token.")));
  });

  it("can build CLI-style Access WebSocket headers without an Origin", () => {
    const token = jwt({ sub: "access-user-123" });
    const headers = webSocketUpgradeRequestHeaders(
      new URL("wss://cloud.test/n/access-demo/sync?operator=cli%3Asmoke&scope=owner"),
      {
        key: "test-key",
        accessToken: token,
      },
    );

    assert.ok(headers.includes(`CF-Access-Token: ${token}`));
    assert.ok(!headers.some((header) => header.toLowerCase().startsWith("origin:")));
    assert.equal(
      headers.filter((header) => /^CF-Access-Token:|^Authorization:|^Cookie:/i.test(header)).length,
      1,
    );
  });

  it("requires an owner Access token", () => {
    assert.throws(
      () => assertHostedAccessSmokeEnv({ ownerToken: "" }),
      /NOTEBOOK_CLOUD_ACCESS_JWT is required/,
    );
  });

  it("parses configured Access health readiness", () => {
    assert.deepEqual(
      accessHealthFromPayload({
        auth: {
          cloudflare_access: {
            status: "configured",
            jwks: "remote",
          },
        },
      }),
      { status: "configured", jwks: "remote" },
    );
    assert.deepEqual(
      assertAccessHealthConfigured({
        auth: {
          cloudflare_access: {
            status: "configured",
            jwks: "pinned",
          },
        },
      }),
      { status: "configured", jwks: "pinned" },
    );
  });

  it("fails hosted Access smoke preflight when Access config is partial or disabled", () => {
    assert.throws(
      () =>
        assertAccessHealthConfigured(
          {
            auth: {
              cloudflare_access: {
                status: "partial",
                jwks: "none",
              },
            },
          },
          { baseUrl: "https://notebooks.example.com" },
        ),
      /Cloudflare Access auth is partial for https:\/\/notebooks\.example\.com; expected configured.*exactly one of NOTEBOOK_CLOUD_ACCESS_TEAM_DOMAIN or NOTEBOOK_CLOUD_ACCESS_AUD is missing.*jwks=none/,
    );
    assert.throws(
      () =>
        assertAccessHealthConfigured({
          auth: {
            cloudflare_access: {
              status: "disabled",
              jwks: "none",
            },
          },
        }),
      /Cloudflare Access auth is disabled; expected configured.*NOTEBOOK_CLOUD_ACCESS_TEAM_DOMAIN and NOTEBOOK_CLOUD_ACCESS_AUD are not set.*jwks=none/,
    );
  });

  it("rejects malformed Access health payloads", () => {
    assert.throws(() => accessHealthFromPayload({ auth: {} }), /missing auth\.cloudflare_access/);
    assert.throws(
      () =>
        accessHealthFromPayload({
          auth: {
            cloudflare_access: {
              status: "ready",
              jwks: "remote",
            },
          },
        }),
      /invalid Cloudflare Access status: ready/,
    );
    assert.throws(
      () =>
        accessHealthFromPayload({
          auth: {
            cloudflare_access: {
              status: "configured",
              jwks: "local",
            },
          },
        }),
      /invalid Cloudflare Access JWKS status: local/,
    );
  });
});

function jwt(payload) {
  return [base64UrlJson({ alg: "RS256", typ: "JWT" }), base64UrlJson(payload), "signature"].join(
    ".",
  );
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
