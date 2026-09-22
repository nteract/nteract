import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AuthError,
  authenticateRequestWithProviders,
  BEARER_AUTH_TOKEN_PROTOCOL_PREFIX,
  NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
  type IdentityEnvironment,
} from "../src/identity.ts";
import { loadOidcUserInfo, OidcUserInfoError } from "../src/oidc-userinfo.ts";
import { base64Url, oidcTokenFixture } from "./oidc-jwt-fixture.ts";

async function fixture(options: Parameters<typeof oidcTokenFixture>[0] = {}) {
  const issuer = `https://${crypto.randomUUID()}.auth.test`;
  const signed = await oidcTokenFixture({ subject: "person", ...options, tokenIssuer: issuer });
  return {
    token: signed.token,
    env: {
      ...signed.env,
      NOTEBOOK_CLOUD_OIDC_ISSUER: issuer,
      NOTEBOOK_CLOUD_OIDC_USERINFO: "true",
    },
    issuer,
  };
}
function authenticate(token: string, env: IdentityEnvironment, websocket = false) {
  return authenticateRequestWithProviders(
    new Request("https://cloud.test/api/n", {
      headers: websocket
        ? {
            Upgrade: "websocket",
            "Sec-WebSocket-Protocol": `${NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL}, ${BEARER_AUTH_TOKEN_PROTOCOL_PREFIX}${base64Url(token)}`,
          }
        : { Authorization: `Bearer ${token}` },
    }),
    env,
  );
}
function cachedInput() {
  return {
    token: crypto.randomUUID(),
    endpoint: "https://issuer.test/userinfo",
    subject: "person",
    expiresAt: Date.now() + 300_000,
    cacheScope: "test-provider",
  };
}

describe("optional OIDC UserInfo", () => {
  it("leaves existing JWT-only and pinned-key authentication offline when disabled", async (t) => {
    const { token, env } = await fixture({ email: "jwt@example.test", name: "JWT Name" });
    const fetch = t.mock.method(globalThis, "fetch", async () => {
      throw new Error("unexpected network");
    });
    const identity = await authenticate(token, { ...env, NOTEBOOK_CLOUD_OIDC_USERINFO: undefined });
    assert.equal(identity.metadata.displayName, "JWT Name");
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("enriches HTTP and WebSocket identity after verification and coalesces token lookups", async (t) => {
    const { token, env, issuer } = await fixture();
    const remoteEnv = { ...env, NOTEBOOK_CLOUD_OIDC_JWKS_JSON: undefined };
    const calls: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      assert.equal(init?.redirect, "manual");
      if (String(input).endsWith("openid-configuration"))
        return Response.json({
          issuer,
          jwks_uri: `${issuer}/oauth2/jwks`,
          userinfo_endpoint: `${issuer}/oauth2/userinfo`,
        });
      if (String(input).endsWith("/jwks"))
        return Response.json(JSON.parse(env.NOTEBOOK_CLOUD_OIDC_JWKS_JSON));
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token}`);
      return Response.json({
        sub: "person",
        email: "person@example.test",
        email_verified: true,
        given_name: "Test",
        family_name: "Person",
        picture: "https://images.test/avatar.png",
        access_token: "must-not-be-retained",
        groups: ["admin"],
      });
    });
    const identities = await Promise.all([
      authenticate(token, remoteEnv),
      authenticate(token, remoteEnv, true),
    ]);
    for (const identity of identities) {
      assert.equal(identity.principal, "user:anaconda:person");
      assert.equal(identity.metadata.displayName, "Test Person");
      assert.equal(identity.metadata.email, "person@example.test");
      assert.equal(identity.metadata.emailVerified, true);
      assert.equal(identity.metadata.avatarUrl, "https://images.test/avatar.png");
      assert.doesNotMatch(JSON.stringify(identity), /must-not-be-retained|admin/);
    }
    assert.deepEqual(calls, [
      `${issuer}/.well-known/openid-configuration`,
      `${issuer}/oauth2/jwks`,
      `${issuer}/oauth2/userinfo`,
    ]);
    await authenticate(token, remoteEnv);
    assert.equal(calls.length, 3);
  });

  it("never requests UserInfo for a rejected signed client or invalid JWT", async (t) => {
    const { token, env } = await fixture({ extraPayload: { client_id: "other-client" } });
    const fetch = t.mock.method(globalThis, "fetch", async () => {
      throw new Error("unexpected network");
    });
    await assert.rejects(
      authenticate(token, { ...env, NOTEBOOK_CLOUD_OIDC_REQUIRED_CLIENT_ID: "this-client" }),
      (error: unknown) => error instanceof AuthError && error.status === 401,
    );
    await assert.rejects(authenticate("bad-token", env), AuthError);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("does not inherit verified status for a different UserInfo email", async (t) => {
    const { token, env, issuer } = await fixture({
      email: "old@example.test",
      extraPayload: { email_verified: true },
    });
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) =>
      Response.json(
        String(input).endsWith("openid-configuration")
          ? { issuer, userinfo_endpoint: `${issuer}/userinfo` }
          : { sub: "person", email: "new@example.test" },
      ),
    );
    const identity = await authenticate(token, env);
    assert.equal(identity.metadata.email, "new@example.test");
    assert.equal(identity.metadata.emailVerified, false);
  });

  for (const endpoint of [
    undefined,
    "http://evil.test/userinfo",
    "https://evil.test/userinfo",
    "/userinfo",
    "https://user:password@issuer.test/userinfo",
    "https://issuer.test/userinfo#fragment",
  ]) {
    it(`rejects an untrusted discovered endpoint: ${endpoint}`, async (t) => {
      const { token, env, issuer } = await fixture();
      const fetch = t.mock.method(globalThis, "fetch", async () =>
        Response.json({ issuer, userinfo_endpoint: endpoint }),
      );
      await assert.rejects(
        authenticate(token, env),
        (error: unknown) => error instanceof AuthError && error.status === 503,
      );
      assert.equal(fetch.mock.callCount(), 1);
    });
  }

  it("requires an explicitly trusted HTTPS origin for cross-origin UserInfo", async (t) => {
    const { token, env, issuer } = await fixture();
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) =>
      Response.json(
        String(input).endsWith("openid-configuration")
          ? { issuer, userinfo_endpoint: "https://accounts.test/userinfo" }
          : { sub: "person" },
      ),
    );
    const identity = await authenticate(token, {
      ...env,
      NOTEBOOK_CLOUD_OIDC_USERINFO_ORIGIN: "https://accounts.test",
    });
    assert.equal(identity.principal, "user:anaconda:person");
    await assert.rejects(
      authenticate(token, {
        ...env,
        NOTEBOOK_CLOUD_OIDC_USERINFO_ORIGIN: "https://accounts.test/path",
      }),
      AuthError,
    );
  });

  it("retries discovery immediately after an invalid UserInfo endpoint is repaired", async (t) => {
    const { token, env, issuer } = await fixture();
    let discoveryCalls = 0;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      if (String(input).endsWith("openid-configuration")) {
        discoveryCalls++;
        return Response.json({
          issuer,
          ...(discoveryCalls > 1 ? { userinfo_endpoint: `${issuer}/userinfo` } : {}),
        });
      }
      return Response.json({ sub: "person" });
    });
    await assert.rejects(
      authenticate(token, env),
      (error: unknown) => error instanceof AuthError && error.status === 503,
    );
    assert.equal((await authenticate(token, env)).principal, "user:anaconda:person");
    assert.equal(discoveryCalls, 2);
  });

  it("sanitizes unexpected failures before the UserInfo fetch", async (t) => {
    const { token, env, issuer } = await fixture();
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({ issuer, userinfo_endpoint: `${issuer}/userinfo` }),
    );
    t.mock.method(crypto.subtle, "digest", async () => {
      throw new Error("private crypto details");
    });
    await assert.rejects(
      authenticate(token, env),
      (error: unknown) =>
        error instanceof AuthError &&
        error.status === 503 &&
        error.message === "OIDC UserInfo request failed",
    );
  });
});

describe("UserInfo validation and bounded cache", () => {
  it("accepts a GET-only provider while keeping credentials and the deadline on the same endpoint", async (t) => {
    const input = cachedInput();
    const methods: string[] = [];
    let signal: AbortSignal | null | undefined;
    t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(url), input.endpoint);
      assert.equal(init?.redirect, "manual");
      assert.equal(init?.body, undefined);
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${input.token}`);
      methods.push(init?.method ?? "");
      if (init?.method === "POST") {
        signal = init.signal;
        return new Response(null, { status: 405, headers: { Allow: "HEAD, GET" } });
      }
      assert.equal(init?.signal, signal);
      return Response.json({ sub: "person", name: "GET provider" });
    });
    assert.equal((await loadOidcUserInfo(input)).name, "GET provider");
    assert.equal((await loadOidcUserInfo(input)).name, "GET provider");
    assert.deepEqual(methods, ["POST", "GET"]);
  });

  it("does not retry authentication errors, outages, redirects or a 405 without GET permission", async (t) => {
    for (const [status, allow] of [
      [401, "GET"],
      [403, "GET"],
      [500, "GET"],
      [307, "GET"],
      [405, ""],
      [405, "POST"],
    ] as const) {
      const fetch = t.mock.method(
        globalThis,
        "fetch",
        async () => new Response(null, { status, headers: { Allow: allow } }),
      );
      await assert.rejects(loadOidcUserInfo(cachedInput()), OidcUserInfoError);
      assert.equal(fetch.mock.callCount(), 1);
      fetch.mock.restore();
    }
  });

  it("still rejects redirects and mismatched subjects after a GET retry", async (t) => {
    for (const response of [
      new Response(null, { status: 302, headers: { Location: "https://untrusted.test/" } }),
      Response.json({ sub: "other-person" }),
    ]) {
      const input = cachedInput();
      const fetch = t.mock.method(
        globalThis,
        "fetch",
        async (url: RequestInfo | URL, init?: RequestInit) => {
          assert.equal(String(url), input.endpoint);
          assert.equal(init?.redirect, "manual");
          return init?.method === "POST"
            ? new Response(null, { status: 405, headers: { Allow: "GET" } })
            : response;
        },
      );
      await assert.rejects(loadOidcUserInfo(input), OidcUserInfoError);
      assert.equal(fetch.mock.callCount(), 2);
      fetch.mock.restore();
    }
  });

  it("rejects provider redirects without forwarding bearer credentials or caching their bodies", async (t) => {
    for (const status of [301, 302, 303, 307, 308]) {
      const input = cachedInput();
      const requests: string[] = [];
      let repaired = false;
      const fetchMock = t.mock.method(
        globalThis,
        "fetch",
        async (url: RequestInfo | URL, init?: RequestInit) => {
          requests.push(String(url));
          assert.equal(String(url), input.endpoint);
          assert.equal(
            init?.redirect,
            "manual",
            "celld must not forward the bearer token on redirects",
          );
          assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${input.token}`);
          return new Response(JSON.stringify({ sub: "person", name: "Expected User" }), {
            status: repaired ? 200 : status,
            headers: {
              "Content-Type": "application/json",
              ...(!repaired ? { Location: "https://untrusted.test/userinfo" } : {}),
            },
          });
        },
      );
      await assert.rejects(
        loadOidcUserInfo(input),
        (error: unknown) =>
          error instanceof OidcUserInfoError &&
          error.status === 503 &&
          error.message === "OIDC UserInfo request failed",
      );
      assert.deepEqual(requests, [input.endpoint]);
      repaired = true;
      assert.equal((await loadOidcUserInfo(input)).name, "Expected User");
      assert.deepEqual(requests, [input.endpoint, input.endpoint]);
      fetchMock.mock.restore();
    }
  });

  for (const sub of [undefined, "other", " person", 7]) {
    it(`requires exact verified subject: ${sub}`, async (t) => {
      t.mock.method(globalThis, "fetch", async () =>
        Response.json({ sub, email: "person@example.test", email_verified: true }),
      );
      await assert.rejects(
        loadOidcUserInfo(cachedInput()),
        (error: unknown) => error instanceof OidcUserInfoError && error.status === 401,
      );
    });
  }
  for (const claim of [
    { email_verified: "true" },
    { name: {} },
    { email: "invalid" },
    { name: "x".repeat(257) },
    { name: "bad\nname" },
    { picture: "javascript:alert(1)" },
  ]) {
    it(`rejects malformed profile fields: ${JSON.stringify(claim).slice(0, 80)}`, async (t) => {
      t.mock.method(globalThis, "fetch", async () => Response.json({ sub: "person", ...claim }));
      await assert.rejects(
        loadOidcUserInfo(cachedInput()),
        (error: unknown) => error instanceof OidcUserInfoError && error.status === 503,
      );
    });
  }

  it("keys the cache by token and provider configuration, and retries failures", async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ sub: "person" }));
    const input = cachedInput();
    await Promise.all([loadOidcUserInfo(input), loadOidcUserInfo(input)]);
    assert.equal(fetch.mock.callCount(), 1);
    await loadOidcUserInfo({ ...input, cacheScope: "another-provider" });
    await loadOidcUserInfo({ ...input, token: "another-token" });
    assert.equal(fetch.mock.callCount(), 3);
    const retry = { ...input, token: "retry-token" };
    fetch.mock.mockImplementation(
      async () => new Response("private provider error", { status: 500 }),
    );
    await assert.rejects(loadOidcUserInfo(retry), /OIDC UserInfo request failed/);
    fetch.mock.mockImplementation(async () => Response.json({ sub: "person" }));
    await loadOidcUserInfo(retry);
    assert.equal(fetch.mock.callCount(), 5);
  });

  it("expires cached profiles after 60 seconds and never serves an expired token", async (t) => {
    const start = Date.now();
    let now = start;
    t.mock.method(Date, "now", () => now);
    const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ sub: "person" }));
    const input = cachedInput();
    await loadOidcUserInfo(input);
    now += 59_999;
    await loadOidcUserInfo(input);
    assert.equal(fetch.mock.callCount(), 1);
    now += 1;
    await loadOidcUserInfo(input);
    assert.equal(fetch.mock.callCount(), 2);
    now = input.expiresAt;
    await assert.rejects(
      loadOidcUserInfo(input),
      (error: unknown) => error instanceof OidcUserInfoError && error.status === 401,
    );
    assert.equal(fetch.mock.callCount(), 2);
  });

  it("bounds cache entries and evicts old tokens", async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ sub: "person" }));
    const first = cachedInput();
    await loadOidcUserInfo(first);
    for (let index = 0; index < 256; index++)
      await loadOidcUserInfo({ ...first, token: `bounded-${index}` });
    await loadOidcUserInfo(first);
    assert.equal(fetch.mock.callCount(), 258);
  });

  it("bounds streamed bytes regardless of Content-Length and rejects non-JSON", async (t) => {
    const fetch = t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(" ".repeat(16_385), {
          headers: { "Content-Type": "application/json", "Content-Length": "1" },
        }),
    );
    await assert.rejects(loadOidcUserInfo(cachedInput()), /too large/);
    fetch.mock.mockImplementation(
      async () => new Response("{}", { headers: { "Content-Type": "text/html" } }),
    );
    await assert.rejects(loadOidcUserInfo(cachedInput()), /must be JSON/);
    fetch.mock.mockImplementation(
      async () => new Response("invalid", { headers: { "Content-Type": "application/json" } }),
    );
    await assert.rejects(loadOidcUserInfo(cachedInput()), /response is invalid/);
  });

  it("times out while reading the body and cancels it without leaking credentials", async (t) => {
    let fireTimeout: (() => void) | undefined;
    t.mock.method(globalThis, "setTimeout", (callback: () => void) => {
      fireTimeout = callback;
      return 1;
    });
    let bodyCancelled = false;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    t.mock.method(globalThis, "fetch", async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull() {
          started();
        },
        cancel() {
          bodyCancelled = true;
        },
      });
      return new Response(stream, { headers: { "Content-Type": "application/json" } });
    });
    const pending = loadOidcUserInfo(cachedInput());
    await reading;
    fireTimeout!();
    await assert.rejects(pending, /OIDC UserInfo request timed out/);
    assert.equal(bodyCancelled, true);
  });

  it("sanitizes fetch errors and maps provider token rejection separately from outages", async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async () => {
      throw new Error("Bearer secret-token at https://private.test");
    });
    await assert.rejects(
      loadOidcUserInfo(cachedInput()),
      (error: unknown) =>
        error instanceof OidcUserInfoError &&
        error.message === "OIDC UserInfo request failed" &&
        error.status === 503,
    );
    fetch.mock.mockImplementation(async () => new Response(null, { status: 401 }));
    await assert.rejects(
      loadOidcUserInfo(cachedInput()),
      (error: unknown) => error instanceof OidcUserInfoError && error.status === 401,
    );
  });
});
