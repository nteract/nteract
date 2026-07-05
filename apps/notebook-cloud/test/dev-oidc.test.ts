import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { authenticateRequestWithProviders } from "../src/identity.ts";
import type { Env, ExecutionContext } from "../src/cloudflare-types.ts";
import { createLocalOidcIssuer, type LocalOidcIssuer } from "@nteract/local-oidc";

const MOUNT_ORIGIN = "http://127.0.0.1:8787";
const ISSUER_URL = `${MOUNT_ORIGIN}/dev/oidc`;
const CLIENT_ID = "local-oidc-client";
const REDIRECT_URI = "http://127.0.0.1:8787/oidc";
const DISCOVERY_PATH = "/dev/oidc/.well-known/openid-configuration";

// The gate handler runs before any binding-backed route, so a partial env cast
// is enough for the discovery path and the not-found fallthrough.
function gateEnv(overrides: Partial<Env> = {}): Env {
  return overrides as Env;
}

function fakeContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  };
}

async function mintIssuedAccessToken(issuer: LocalOidcIssuer): Promise<string> {
  const authorizeUrl = new URL(`${ISSUER_URL}/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  const authorizeResponse = await issuer.handle(new Request(authorizeUrl));
  assert.ok(authorizeResponse, "authorize should be handled by the issuer");
  const code = new URL(authorizeResponse.headers.get("location") ?? "").searchParams.get("code");
  assert.ok(code, "authorize should return a code");

  const tokenResponse = await issuer.handle(
    new Request(`${ISSUER_URL}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      }).toString(),
    }),
  );
  assert.ok(tokenResponse, "token exchange should be handled by the issuer");
  const tokens = JSON.parse(await tokenResponse.text()) as { access_token?: string };
  assert.ok(tokens.access_token, "token exchange should return an access token");
  return tokens.access_token;
}

describe("dev OIDC mount gate", () => {
  it("404s the discovery path exactly like an unknown route when the flag is off", async () => {
    const response = await worker.fetch(
      new Request(`${MOUNT_ORIGIN}${DISCOVERY_PATH}`),
      gateEnv(),
      fakeContext(),
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not found" });
  });

  it("serves the discovery document when NOTEBOOK_CLOUD_LOCAL_OIDC is true", async () => {
    const response = await worker.fetch(
      new Request(`${MOUNT_ORIGIN}${DISCOVERY_PATH}`),
      gateEnv({ NOTEBOOK_CLOUD_LOCAL_OIDC: "true" }),
      fakeContext(),
    );
    assert.equal(response.status, 200);
    const doc = (await response.json()) as Record<string, unknown>;
    assert.equal(doc.issuer, ISSUER_URL);
    assert.equal(doc.jwks_uri, `${ISSUER_URL}/.well-known/jwks.json`);
    assert.equal(doc.token_endpoint, `${ISSUER_URL}/token`);
  });

  it("derives the issuer from the request origin", async () => {
    const response = await worker.fetch(
      new Request(`http://127.0.0.1:45999${DISCOVERY_PATH}`),
      gateEnv({ NOTEBOOK_CLOUD_LOCAL_OIDC: "true" }),
      fakeContext(),
    );
    assert.equal(response.status, 200);
    const doc = (await response.json()) as Record<string, unknown>;
    assert.equal(doc.issuer, "http://127.0.0.1:45999/dev/oidc");
  });
});

describe("dev OIDC issuer verification", () => {
  it("mints a token that passes the worker OIDC verifier", async () => {
    const issuer = createLocalOidcIssuer({
      issuerUrl: ISSUER_URL,
      clientId: CLIENT_ID,
      users: [{ email: "dev@localhost", givenName: "Local", familyName: "Developer" }],
    });
    const accessToken = await mintIssuedAccessToken(issuer);

    // Pin the ephemeral JWKS so verification never leaves the process; the live
    // dev worker instead fetches it from the mounted issuer's jwks endpoint.
    const env = {
      NOTEBOOK_CLOUD_OIDC_ISSUER: ISSUER_URL,
      NOTEBOOK_CLOUD_OIDC_CLIENT_ID: CLIENT_ID,
      NOTEBOOK_CLOUD_OIDC_JWKS_JSON: JSON.stringify(await issuer.jwks()),
      NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "user:local",
    };

    const identity = await authenticateRequestWithProviders(
      new Request(`${MOUNT_ORIGIN}/n/demo/sync`, {
        headers: { authorization: `Bearer ${accessToken}`, "x-scope": "owner" },
      }),
      env,
    );

    assert.equal(identity.metadata.provider, "oidc");
    assert.equal(identity.metadata.principalNamespace, "user:local");
    assert.ok(identity.principal.startsWith("user:local:"));
    assert.equal(identity.metadata.email, "dev@localhost");
    assert.equal(identity.scope, "owner");
  });

  it("rejects a token from a different issuer key", async () => {
    const issuer = createLocalOidcIssuer({ issuerUrl: ISSUER_URL, clientId: CLIENT_ID });
    const otherIssuer = createLocalOidcIssuer({ issuerUrl: ISSUER_URL, clientId: CLIENT_ID });
    const accessToken = await mintIssuedAccessToken(issuer);

    const env = {
      NOTEBOOK_CLOUD_OIDC_ISSUER: ISSUER_URL,
      NOTEBOOK_CLOUD_OIDC_CLIENT_ID: CLIENT_ID,
      // A different instance's JWKS: same issuer URL, different signing key.
      NOTEBOOK_CLOUD_OIDC_JWKS_JSON: JSON.stringify(await otherIssuer.jwks()),
      NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "user:local",
    };

    await assert.rejects(
      authenticateRequestWithProviders(
        new Request(`${MOUNT_ORIGIN}/n/demo/sync`, {
          headers: { authorization: `Bearer ${accessToken}` },
        }),
        env,
      ),
      /signing key was not found|signature is invalid/,
    );
  });
});
