import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  accessAuthHeaders,
  accessAuthProtocols,
  accessEmailFromJwt,
  accessPrincipalFromJwt,
  assertHostedAccessSmokeEnv,
} from "../scripts/hosted-access-smoke-env.mjs";

describe("hosted Access smoke environment helpers", () => {
  it("maps Access subjects to principal rows without using email as the principal", () => {
    const token = jwt({ sub: "access-user-123", email: "alice@example.com" });

    assert.equal(accessPrincipalFromJwt(token), "user:cloudflare-access:access-user-123");
    assert.equal(accessEmailFromJwt(token), "alice@example.com");
  });

  it("builds Access HTTP headers and WebSocket subprotocol auth without URL tokens", () => {
    const token = jwt({ sub: "access-user-123" });

    assert.deepEqual(accessAuthHeaders(token, { operator: "smoke:owner", scope: "owner" }), {
      Authorization: `Bearer ${token}`,
      "CF-Access-Token": token,
      "X-Operator": "smoke:owner",
      "X-Scope": "owner",
    });
    assert.deepEqual(accessAuthProtocols(token), [
      `nteract-access-token.${Buffer.from(token, "utf8").toString("base64url")}`,
    ]);
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
