import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authenticateRequestWithProviders,
  authenticateOidcRequest,
  BEARER_AUTH_TOKEN_PROTOCOL_PREFIX,
  NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
  AuthError,
} from "../src/identity.ts";
import { oidcTokenFixture, base64Url } from "./oidc-jwt-fixture.ts";
for (const transport of ["http", "websocket"])
  test(`server login rejects a valid provider token replay over ${transport}`, async () => {
    const { env, token } = await oidcTokenFixture({ subject: "alice" });
    const headers: HeadersInit =
      transport === "http"
        ? { Authorization: `Bearer ${token}` }
        : {
            "sec-websocket-protocol": `${NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL}, ${BEARER_AUTH_TOKEN_PROTOCOL_PREFIX}${base64Url(token)}`,
          };
    const request = new Request(
      "https://main.runtimed.run/api/n?operator=browser:test&scope=viewer",
      { headers },
    );
    const accepted = await authenticateRequestWithProviders(request, env);
    assert.equal(accepted.metadata.provider, "oidc");
    await assert.rejects(
      authenticateRequestWithProviders(request, { ...env, NOTEBOOK_CLOUD_OIDC_FLOW: "server" }),
      (e) => e instanceof AuthError && e.status === 401 && /server sign-in/.test(e.message),
    );
  });
test("server callback can still verify the exchanged provider token internally", async () => {
  const { env, token } = await oidcTokenFixture({ subject: "alice" });
  const result = await authenticateOidcRequest(
    new Request("https://main.runtimed.run/oidc?operator=browser:callback&scope=viewer"),
    { ...env, NOTEBOOK_CLOUD_OIDC_FLOW: "server" },
    { token, transport: "oidc-bearer" },
  );
  assert.equal(result.metadata.provider, "oidc");
});
