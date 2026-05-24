import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  accessAuthHeaders,
  accessAuthProtocols,
  accessEmailFromJwt,
  accessPrincipalFromJwt,
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
});

function jwt(payload) {
  return [base64UrlJson({ alg: "RS256", typ: "JWT" }), base64UrlJson(payload), "signature"].join(
    ".",
  );
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
