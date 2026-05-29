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
  refreshStoredOidcToken,
  storedOidcTokenNeedsRefresh,
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
    assert.equal(result.token.refreshToken, "refresh-secret");
    assert.equal(storage.getItem(NOTEBOOK_CLOUD_OIDC_REQUEST_STORAGE_KEY), null);
    assert.equal(readStoredOidcToken(storage).token?.accessToken, accessToken);
  });

  it("refreshes stored OIDC tokens before falling back to anonymous auth", async () => {
    const storage = new MemoryStorage();
    const oldAccessToken = jwt({
      sub: "anaconda-user-123",
      email: "alice@example.com",
      email_verified: true,
      name: "Alice",
    });
    const refreshedAccessToken = jwt({
      sub: "anaconda-user-123",
      email: "alice@example.com",
      email_verified: true,
      name: "Alice Updated",
    });
    storage.setItem(
      NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY,
      JSON.stringify({
        accessToken: oldAccessToken,
        refreshToken: "refresh-secret",
        expiresAt: 100,
        claims: {
          sub: "anaconda-user-123",
          email: "alice@example.com",
          email_verified: true,
          name: "Alice",
        },
      }),
    );
    const seenRequests: string[] = [];

    assert.equal(storedOidcTokenNeedsRefresh(storage, 100), true);

    const token = await refreshStoredOidcToken(authConfig, {
      storage,
      nowSeconds: 200,
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
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("client_id"), "client-id");
        assert.equal(body.get("grant_type"), "refresh_token");
        assert.equal(body.get("refresh_token"), "refresh-secret");
        assert.equal(body.get("scope"), "openid email profile offline_access");
        return Response.json({
          access_token: refreshedAccessToken,
          expires_in: 300,
          refresh_token: "rotated-refresh-secret",
        });
      },
    });

    assert.deepEqual(seenRequests, [
      "https://auth.stage.anaconda.com/api/auth/.well-known/openid-configuration",
      "https://auth.stage.anaconda.com/api/auth/token",
    ]);
    assert.equal(token.accessToken, refreshedAccessToken);
    assert.equal(token.refreshToken, "rotated-refresh-secret");
    assert.equal(token.expiresAt, 500);
    assert.equal(token.claims.name, "Alice Updated");
    assert.equal(storedOidcTokenNeedsRefresh(storage, 450), true);
    assert.equal(storedOidcTokenNeedsRefresh(storage, 100), false);
    assert.equal(readStoredOidcToken(storage, 100).token?.accessToken, refreshedAccessToken);
  });

  it("treats expired non-refreshable OIDC tokens as unusable without invalidating auth", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY,
      JSON.stringify({
        accessToken: jwt({ sub: "anaconda-user-expired", name: "Expired User" }),
        refreshToken: null,
        expiresAt: 100,
        claims: { sub: "anaconda-user-expired", name: "Expired User" },
      }),
    );

    const stored = readStoredOidcToken(storage, 200);

    assert.equal(stored.token, null);
    assert.equal(stored.problem, null);
    assert.equal(stored.expired, true);
    assert.equal(stored.expiredClaims?.name, "Expired User");
    assert.equal(storedOidcTokenNeedsRefresh(storage, 200), false);
  });

  it("coalesces concurrent refreshes for the same stored OIDC session", async () => {
    const storage = new MemoryStorage();
    const refreshedAccessToken = jwt({ sub: "anaconda-user-123", name: "Alice Refreshed" });
    storage.setItem(
      NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY,
      JSON.stringify({
        accessToken: jwt({ sub: "anaconda-user-123", name: "Alice" }),
        refreshToken: "refresh-secret",
        expiresAt: 100,
        claims: { sub: "anaconda-user-123", name: "Alice" },
      }),
    );
    let discoveryRequests = 0;
    let tokenRequests = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        discoveryRequests += 1;
        return Response.json({
          authorization_endpoint: "https://auth.stage.anaconda.com/api/auth/authorize",
          token_endpoint: "https://auth.stage.anaconda.com/api/auth/token",
        });
      }
      tokenRequests += 1;
      return Response.json({
        access_token: refreshedAccessToken,
        expires_in: 300,
      });
    };

    const [first, second] = await Promise.all([
      refreshStoredOidcToken(authConfig, { storage, fetchImpl, nowSeconds: 200 }),
      refreshStoredOidcToken(authConfig, { storage, fetchImpl, nowSeconds: 200 }),
    ]);

    assert.equal(first.accessToken, refreshedAccessToken);
    assert.equal(second.accessToken, refreshedAccessToken);
    assert.equal(discoveryRequests, 1);
    assert.equal(tokenRequests, 1);
  });

  it("preserves refresh token and profile claims when refresh responses omit them", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY,
      JSON.stringify({
        accessToken: jwt({ sub: "anaconda-user-123", email: "alice@example.com", name: "Alice" }),
        refreshToken: "refresh-secret",
        expiresAt: 100,
        claims: {
          sub: "anaconda-user-123",
          email: "alice@example.com",
          email_verified: true,
          name: "Alice",
        },
      }),
    );

    const token = await refreshStoredOidcToken(authConfig, {
      storage,
      nowSeconds: 200,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/.well-known/openid-configuration")) {
          return Response.json({
            authorization_endpoint: "https://auth.stage.anaconda.com/api/auth/authorize",
            token_endpoint: "https://auth.stage.anaconda.com/api/auth/token",
          });
        }
        return Response.json({
          access_token: jwt({ sub: "anaconda-user-123" }),
          expires_in: 300,
        });
      },
    });

    assert.equal(token.refreshToken, "refresh-secret");
    assert.equal(token.claims.email, "alice@example.com");
    assert.equal(token.claims.name, "Alice");
  });

  it("rejects refresh responses for a different subject without replacing stored tokens", async () => {
    const storage = new MemoryStorage();
    const oldAccessToken = jwt({ sub: "anaconda-user-123", name: "Alice" });
    storage.setItem(
      NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY,
      JSON.stringify({
        accessToken: oldAccessToken,
        refreshToken: "refresh-secret",
        expiresAt: 100,
        claims: { sub: "anaconda-user-123", name: "Alice" },
      }),
    );

    await assert.rejects(
      () =>
        refreshStoredOidcToken(authConfig, {
          storage,
          fetchImpl: async (input) => {
            const url = String(input);
            if (url.endsWith("/.well-known/openid-configuration")) {
              return Response.json({
                authorization_endpoint: "https://auth.stage.anaconda.com/api/auth/authorize",
                token_endpoint: "https://auth.stage.anaconda.com/api/auth/token",
              });
            }
            return Response.json({
              access_token: jwt({ sub: "anaconda-user-456" }),
              expires_in: 300,
            });
          },
        }),
      /different subject/,
    );

    assert.equal(readStoredOidcToken(storage, 0).token?.accessToken, oldAccessToken);
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
