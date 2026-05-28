import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NOTEBOOK_CLOUD_OIDC_REQUEST_STORAGE_KEY,
  NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY,
  buildOidcAuthorizationUrl,
  completeOidcRedirect,
  normalizeOidcAuthConfig,
  oidcDiscoveryUrl,
  readStoredOidcToken,
  type CloudOidcAuthConfig,
  type CloudOidcRequestState,
  type CloudOidcStorage,
} from "../viewer/oidc-auth.ts";

const authConfig: CloudOidcAuthConfig = {
  issuer: "https://auth.stage.anaconda.com/api/auth",
  clientId: "client-id",
  redirectUri: "https://preview.runt.run/oidc",
  scope: "openid email profile offline_access",
};

describe("cloud OIDC browser auth", () => {
  it("normalizes complete runtime OIDC config", () => {
    assert.deepEqual(
      normalizeOidcAuthConfig({
        issuer: " https://auth.stage.anaconda.com/api/auth ",
        clientId: " client-id ",
        redirectUri: " https://preview.runt.run/oidc ",
      }),
      {
        issuer: "https://auth.stage.anaconda.com/api/auth",
        clientId: "client-id",
        redirectUri: "https://preview.runt.run/oidc",
        scope: "openid email profile offline_access",
      },
    );
    assert.equal(normalizeOidcAuthConfig({ issuer: authConfig.issuer }), null);
  });

  it("builds the provider discovery URL under the issuer path", () => {
    assert.equal(
      oidcDiscoveryUrl("https://auth.stage.anaconda.com/api/auth/"),
      "https://auth.stage.anaconda.com/api/auth/.well-known/openid-configuration",
    );
  });

  it("builds an Authorization Code + PKCE login URL", () => {
    const requestState: CloudOidcRequestState = {
      challenge: "challenge",
      verifier: "verifier",
      state: "state-123",
      returnUrl: "https://preview.runt.run/n/demo",
    };

    const url = buildOidcAuthorizationUrl(
      authConfig,
      {
        authorizationEndpoint: "https://auth.stage.anaconda.com/api/auth/authorize",
        tokenEndpoint: "https://auth.stage.anaconda.com/api/auth/token",
      },
      requestState,
    );

    assert.equal(url.searchParams.get("client_id"), "client-id");
    assert.equal(url.searchParams.get("code_challenge"), "challenge");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("redirect_uri"), "https://preview.runt.run/oidc");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("state"), "state-123");
    assert.equal(url.searchParams.get("scope"), "openid email profile offline_access");
  });

  it("exchanges a valid callback for stored tokens and a same-origin return URL", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      NOTEBOOK_CLOUD_OIDC_REQUEST_STORAGE_KEY,
      JSON.stringify({
        challenge: "challenge",
        verifier: "verifier",
        state: "state-123",
        returnUrl: "https://preview.runt.run/n/private-demo",
      } satisfies CloudOidcRequestState),
    );
    const accessToken = jwt({
      sub: "anaconda-user-123",
      email: "alice@example.com",
      email_verified: true,
      name: "Alice",
    });
    const seenRequests: string[] = [];

    const result = await completeOidcRedirect(authConfig, {
      callbackUrl: "https://preview.runt.run/oidc?code=code-123&state=state-123",
      storage,
      fetchImpl: async (input, init) => {
        const url = String(input);
        seenRequests.push(url);
        if (url.endsWith("/.well-known/openid-configuration")) {
          return Response.json({
            authorization_endpoint: "https://auth.stage.anaconda.com/api/auth/authorize",
            token_endpoint: "https://auth.stage.anaconda.com/api/auth/token",
          });
        }
        assert.equal(url, "https://auth.stage.anaconda.com/api/auth/token");
        assert.equal(init?.method, "POST");
        assert.match(String(init?.body), /grant_type=authorization_code/);
        assert.match(String(init?.body), /code=code-123/);
        assert.match(String(init?.body), /code_verifier=verifier/);
        return Response.json({
          access_token: accessToken,
          expires_in: 3600,
          refresh_token: "refresh-secret",
        });
      },
    });

    assert.deepEqual(seenRequests, [
      "https://auth.stage.anaconda.com/api/auth/.well-known/openid-configuration",
      "https://auth.stage.anaconda.com/api/auth/token",
    ]);
    assert.equal(result.returnUrl, "/n/private-demo");
    assert.equal(result.token.claims.sub, "anaconda-user-123");
    assert.equal(storage.getItem(NOTEBOOK_CLOUD_OIDC_REQUEST_STORAGE_KEY), null);
    assert.equal(readStoredOidcToken(storage).token?.accessToken, accessToken);
    assert.doesNotMatch(
      storage.getItem(NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY) ?? "",
      /refresh-secret/,
    );
  });

  it("rejects callback state mismatches without storing token material", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      NOTEBOOK_CLOUD_OIDC_REQUEST_STORAGE_KEY,
      JSON.stringify({
        challenge: "challenge",
        verifier: "verifier",
        state: "state-123",
        returnUrl: "https://preview.runt.run/n/private-demo",
      } satisfies CloudOidcRequestState),
    );

    await assert.rejects(
      () =>
        completeOidcRedirect(authConfig, {
          callbackUrl: "https://preview.runt.run/oidc?code=code-123&state=wrong",
          storage,
          fetchImpl: async () => {
            throw new Error("fetch should not be called");
          },
        }),
      /state does not match/,
    );
    assert.equal(storage.getItem(NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY), null);
  });
});

class MemoryStorage implements CloudOidcStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function jwt(payload: Record<string, unknown>): string {
  return `${base64UrlJson({ alg: "none" })}.${base64UrlJson(payload)}.signature`;
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
