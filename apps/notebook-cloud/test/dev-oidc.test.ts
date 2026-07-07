import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { authenticateRequestWithProviders } from "../src/identity.ts";
import { handleLocalOidcRequest } from "../src/dev-oidc.ts";
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

  it("does not let a configured issuer path shadow real auth routes", async () => {
    const env = gateEnv({
      NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
      NOTEBOOK_CLOUD_OIDC_ISSUER: "http://127.0.0.1:9797/api/auth",
    });

    const shadowedAuthResponse = await handleLocalOidcRequest(
      new Request("http://127.0.0.1:9797/api/auth/session"),
      env,
    );
    assert.equal(shadowedAuthResponse, null);

    const discoveryResponse = await handleLocalOidcRequest(
      new Request("http://127.0.0.1:9797/dev/oidc/.well-known/openid-configuration"),
      env,
    );
    assert.ok(discoveryResponse);
    assert.equal(discoveryResponse.status, 200);
    const doc = (await discoveryResponse.json()) as Record<string, unknown>;
    assert.equal(doc.issuer, "http://127.0.0.1:9797/api/auth");
  });

  it("completes a code exchange through the fixed mount when the issuer path diverges", async () => {
    // The remap hands the issuer a rewritten Request built from the original;
    // this pins that a POST body survives that construction, and that the mount
    // keeps working when NOTEBOOK_CLOUD_OIDC_ISSUER's path is not /dev/oidc.
    const origin = "http://127.0.0.1:9798";
    const env = gateEnv({
      NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
      NOTEBOOK_CLOUD_OIDC_ISSUER: `${origin}/custom-issuer`,
    });
    const redirectUri = `${origin}/oidc`;

    const authorizeUrl = new URL(`${origin}/dev/oidc/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    const authorizeResponse = await handleLocalOidcRequest(new Request(authorizeUrl), env);
    assert.ok(authorizeResponse, "authorize should be served at the fixed mount");
    const code = new URL(authorizeResponse.headers.get("location") ?? "").searchParams.get("code");
    assert.ok(code, "authorize should return a code");

    const tokenResponse = await handleLocalOidcRequest(
      new Request(`${origin}/dev/oidc/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: CLIENT_ID,
          redirect_uri: redirectUri,
        }).toString(),
      }),
      env,
    );
    assert.ok(tokenResponse, "token exchange should be served at the fixed mount");
    assert.equal(tokenResponse.status, 200);
    const tokens = (await tokenResponse.json()) as { access_token?: string };
    assert.ok(tokens.access_token, "token exchange should return an access token");
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

describe("dev OIDC token delay", () => {
  const delayEnv = gateEnv({
    NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
    NOTEBOOK_CLOUD_OIDC_ISSUER: ISSUER_URL,
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: CLIENT_ID,
    NOTEBOOK_CLOUD_LOCAL_OIDC_DELAY_MS: "80",
  });

  it("delays only the token endpoint so a sign-in reaches the callback before hanging", async () => {
    const discoveryStart = performance.now();
    const discovery = await handleLocalOidcRequest(
      new Request(`${MOUNT_ORIGIN}${DISCOVERY_PATH}`),
      delayEnv,
    );
    const discoveryElapsed = performance.now() - discoveryStart;
    assert.equal(discovery?.status, 200);
    assert.ok(discoveryElapsed < 80, `discovery must not be delayed (took ${discoveryElapsed}ms)`);

    const tokenStart = performance.now();
    const token = await handleLocalOidcRequest(
      new Request(`${ISSUER_URL}/token`, { method: "POST" }),
      delayEnv,
    );
    const tokenElapsed = performance.now() - tokenStart;
    assert.ok(token, "token path is handled by the issuer");
    assert.ok(tokenElapsed >= 80, `token endpoint honors the delay (took ${tokenElapsed}ms)`);
  });

  it("ignores non-numeric and non-positive delay values", async () => {
    for (const raw of ["", "abc", "0", "-5"]) {
      const start = performance.now();
      const response = await handleLocalOidcRequest(
        new Request(`${ISSUER_URL}/token`, { method: "POST" }),
        gateEnv({
          NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
          NOTEBOOK_CLOUD_OIDC_ISSUER: ISSUER_URL,
          NOTEBOOK_CLOUD_OIDC_CLIENT_ID: CLIENT_ID,
          NOTEBOOK_CLOUD_LOCAL_OIDC_DELAY_MS: raw,
        }),
      );
      assert.ok(response, `token path handled for delay value ${JSON.stringify(raw)}`);
      assert.ok(performance.now() - start < 50, `no delay for ${JSON.stringify(raw)}`);
    }
  });
});

describe("dev OIDC multi-user selection", () => {
  const env = gateEnv({ NOTEBOOK_CLOUD_LOCAL_OIDC: "true" });

  async function signInEmail(loginHint?: string): Promise<string> {
    const authorizeUrl = new URL(`${ISSUER_URL}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    if (loginHint) {
      authorizeUrl.searchParams.set("login_hint", loginHint);
    }
    const authorizeResponse = await handleLocalOidcRequest(new Request(authorizeUrl), env);
    assert.ok(authorizeResponse, "authorize handled by the mount");
    const code = new URL(authorizeResponse.headers.get("location") ?? "").searchParams.get("code");
    assert.ok(code, "authorize returns a code");

    const tokenResponse = await handleLocalOidcRequest(
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
      env,
    );
    assert.ok(tokenResponse, "token handled by the mount");
    const { id_token } = JSON.parse(await tokenResponse.text()) as { id_token: string };
    const claims = JSON.parse(Buffer.from(id_token.split(".")[1] ?? "", "base64url").toString());
    return claims.email as string;
  }

  it("defaults to the first dev user when no login_hint is sent", async () => {
    assert.equal(await signInEmail(), "dev@localhost");
  });

  it("selects the additional dev users by login_hint", async () => {
    assert.equal(await signInEmail("alice@localhost"), "alice@localhost");
    assert.equal(await signInEmail("bob@localhost"), "bob@localhost");
  });
});
