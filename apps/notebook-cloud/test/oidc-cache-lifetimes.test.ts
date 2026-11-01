// Each isolate-wide auth cache under virtual time: a hung first lookup stops
// blocking later requests at its deadline, a success is still cached, and a
// failure is not cached. See src/settled-lookup.ts.
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { D1Database } from "../src/cloudflare-types.ts";
import {
  ANACONDA_API_KEY_ATTEMPT_MS,
  AuthError,
  authenticateRequestWithProviders,
  OIDC_DISCOVERY_ATTEMPT_MS,
  OIDC_JWKS_ATTEMPT_MS,
  type IdentityEnvironment,
} from "../src/identity.ts";
import {
  loadOidcUserInfo,
  OIDC_USERINFO_FETCH_TIMEOUT_MS,
  OidcUserInfoError,
} from "../src/oidc-userinfo.ts";
import { CATALOG_SCHEMA_ATTEMPT_MS, ensureCatalogSchema } from "../src/storage.ts";
import { base64Url, oidcTokenFixture } from "./oidc-jwt-fixture.ts";
import { tickUntilSettled, track, turns, virtualTime } from "./settled-lookup-helpers.ts";

const POLL_MS = 5;
const hang = () => new Promise<never>(() => {});
/** A response that arrives after `ms` of virtual time. */
const after = (ms: number, respond: () => Response) =>
  new Promise<Response>((resolve) => setTimeout(() => resolve(respond()), ms));

function unavailable(error: unknown): boolean {
  return error instanceof AuthError && error.status === 503;
}

/** Wait for `promise` while advancing virtual time a poll at a time. */
async function settle<T>(t: TestContext, promise: Promise<T>): Promise<T> {
  await tickUntilSettled(t, promise, 1_000, POLL_MS);
  return promise;
}

async function remoteOidc(issuer: string) {
  const fixture = await oidcTokenFixture({ subject: "cache-user", tokenIssuer: issuer });
  const env: IdentityEnvironment = {
    ...fixture.env,
    NOTEBOOK_CLOUD_OIDC_ISSUER: issuer,
    NOTEBOOK_CLOUD_OIDC_JWKS_JSON: undefined,
  };
  return {
    jwks: fixture.env.NOTEBOOK_CLOUD_OIDC_JWKS_JSON,
    authenticate: () =>
      authenticateRequestWithProviders(
        new Request("https://cloud.test/api/auth/session", {
          headers: { Authorization: `Bearer ${fixture.token}` },
        }),
        env,
      ),
  };
}

describe("OIDC discovery cache lifetime", () => {
  it("a hung discovery fetch stops blocking later requests after its attempt deadline", async (t) => {
    const issuer = `https://${crypto.randomUUID()}.discovery.test`;
    const oidc = await remoteOidc(issuer);
    virtualTime(t);
    let discoveryCalls = 0;
    let keyCalls = 0;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      if (String(input).endsWith("openid-configuration")) {
        // The first discovery request never answers and ignores its abort,
        // the way a lost celld timer leaves it.
        if (++discoveryCalls === 1) return hang();
        return Response.json({ issuer, jwks_uri: `${issuer}/jwks` });
      }
      keyCalls++;
      return new Response(oidc.jwks);
    });

    const owner = oidc.authenticate();
    const ownerSettled = track(owner);
    const later = oidc.authenticate();
    const laterSettled = track(later);
    await turns();
    assert.equal(discoveryCalls, 1, "the later request waits instead of fetching");

    t.mock.timers.tick(OIDC_DISCOVERY_ATTEMPT_MS - 1);
    await turns();
    assert.equal(ownerSettled.settled, false);
    assert.equal(laterSettled.settled, false);

    t.mock.timers.tick(1);
    await assert.rejects(owner, unavailable);
    assert.equal((await settle(t, later)).principal, "user:anaconda:cache-user");
    assert.deepEqual([discoveryCalls, keyCalls], [2, 1]);

    assert.equal((await oidc.authenticate()).principal, "user:anaconda:cache-user");
    assert.deepEqual([discoveryCalls, keyCalls], [2, 1], "a success is cached");
  });

  it("does not cache a failed discovery", async (t) => {
    const issuer = `https://${crypto.randomUUID()}.discovery.test`;
    const oidc = await remoteOidc(issuer);
    virtualTime(t);
    let discoveryCalls = 0;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      if (String(input).endsWith("openid-configuration")) {
        if (++discoveryCalls === 1) return new Response("down", { status: 503 });
        return Response.json({ issuer, jwks_uri: `${issuer}/jwks` });
      }
      return new Response(oidc.jwks);
    });
    await assert.rejects(oidc.authenticate(), unavailable);
    assert.equal((await oidc.authenticate()).metadata.provider, "oidc");
    assert.equal(discoveryCalls, 2);
  });
});

describe("OIDC JWKS cache lifetime", () => {
  it("a hung key-set fetch stops blocking later requests after its attempt deadline", async (t) => {
    const issuer = `https://${crypto.randomUUID()}.jwks.test`;
    const oidc = await remoteOidc(issuer);
    virtualTime(t);
    let discoveryCalls = 0;
    let keyCalls = 0;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      if (String(input).endsWith("openid-configuration")) {
        discoveryCalls++;
        return Response.json({ issuer, jwks_uri: `${issuer}/jwks` });
      }
      if (++keyCalls === 1) return hang();
      return new Response(oidc.jwks);
    });

    const owner = oidc.authenticate();
    const later = oidc.authenticate();
    const laterSettled = track(later);
    await turns();
    assert.equal(keyCalls, 1, "the later request waits instead of fetching keys");

    t.mock.timers.tick(OIDC_JWKS_ATTEMPT_MS - 1);
    await turns();
    assert.equal(laterSettled.settled, false);

    t.mock.timers.tick(1);
    await assert.rejects(owner, unavailable);
    assert.equal((await settle(t, later)).principal, "user:anaconda:cache-user");
    // Discovery succeeded, so the retry reuses it and fetches only the keys.
    assert.deepEqual([discoveryCalls, keyCalls], [1, 2]);

    await oidc.authenticate();
    assert.deepEqual([discoveryCalls, keyCalls], [1, 2], "a success is cached");

    t.mock.timers.tick(5 * 60 * 1000);
    await oidc.authenticate();
    assert.deepEqual([discoveryCalls, keyCalls], [2, 3], "the cached keys expire");
  });

  it("does not cache a failed key-set fetch", async (t) => {
    const issuer = `https://${crypto.randomUUID()}.jwks.test`;
    const oidc = await remoteOidc(issuer);
    virtualTime(t);
    let keyCalls = 0;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      if (String(input).endsWith("openid-configuration"))
        return Response.json({ issuer, jwks_uri: `${issuer}/jwks` });
      if (++keyCalls === 1) return new Response("down", { status: 500 });
      return new Response(oidc.jwks);
    });
    await assert.rejects(oidc.authenticate(), unavailable);
    assert.equal((await oidc.authenticate()).metadata.provider, "oidc");
    assert.equal(keyCalls, 2);
  });

  it("measures discovery and key-set expiry from the start of a slow lookup", async (t) => {
    const issuer = `https://${crypto.randomUUID()}.jwks.test`;
    const oidc = await remoteOidc(issuer);
    virtualTime(t);
    const startedAt = Date.now();
    let discoveryCalls = 0;
    let keyCalls = 0;
    let slow = true;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      if (String(input).endsWith("openid-configuration")) {
        discoveryCalls++;
        const respond = () => Response.json({ issuer, jwks_uri: `${issuer}/jwks` });
        return slow ? after(4_000, respond) : respond();
      }
      keyCalls++;
      const respond = () => new Response(oidc.jwks);
      return slow ? after(4_000, respond) : respond();
    });

    const first = oidc.authenticate();
    await tickUntilSettled(t, first, 60_000, 500);
    assert.equal((await first).metadata.provider, "oidc");
    slow = false;
    assert.ok(Date.now() - startedAt >= 8_000, "discovery and keys each took 4 s");

    // Both lookups started at `startedAt`, so both expire 5 minutes after it,
    // not 5 minutes after their responses.
    t.mock.timers.tick(5 * 60 * 1000 - (Date.now() - startedAt) - 1);
    await oidc.authenticate();
    assert.deepEqual([discoveryCalls, keyCalls], [1, 1]);
    t.mock.timers.tick(1);
    await oidc.authenticate();
    assert.deepEqual([discoveryCalls, keyCalls], [2, 2]);
  });
});

describe("OIDC UserInfo cache lifetime", () => {
  const input = () => ({
    token: crypto.randomUUID(),
    endpoint: "https://issuer.test/userinfo",
    subject: "person",
    expiresAt: Date.now() + 300_000,
    cacheScope: "lifetime-test",
  });

  it("a hung UserInfo request stops blocking later requests after its deadline", async (t) => {
    virtualTime(t);
    const lookup = input();
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      if (++calls === 1) return hang();
      return Response.json({ sub: "person", name: "Second try" });
    });

    const owner = loadOidcUserInfo(lookup);
    const later = loadOidcUserInfo(lookup);
    const laterSettled = track(later);
    await turns();
    assert.equal(calls, 1, "the later request waits instead of fetching");

    t.mock.timers.tick(OIDC_USERINFO_FETCH_TIMEOUT_MS - 1);
    await turns();
    assert.equal(laterSettled.settled, false);

    // The request's own deadline fails the hung attempt and frees the key.
    t.mock.timers.tick(1);
    await assert.rejects(owner, OidcUserInfoError);
    assert.equal((await settle(t, later)).name, "Second try");
    assert.equal(calls, 2);

    assert.equal((await loadOidcUserInfo(lookup)).name, "Second try");
    assert.equal(calls, 2, "a success is cached");
  });

  it("does not cache a failed UserInfo request", async (t) => {
    virtualTime(t);
    const lookup = input();
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () =>
      ++calls === 1
        ? new Response(null, { status: 500 })
        : Response.json({ sub: "person", name: "Recovered" }),
    );
    await assert.rejects(loadOidcUserInfo(lookup), OidcUserInfoError);
    assert.equal((await loadOidcUserInfo(lookup)).name, "Recovered");
    assert.equal(calls, 2);
  });

  it("measures expiry from the start of a slow UserInfo request", async (t) => {
    virtualTime(t);
    const lookup = input();
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      const respond = () => Response.json({ sub: "person" });
      return calls === 1 ? after(4_000, respond) : respond();
    });
    const startedAt = Date.now();
    const first = loadOidcUserInfo(lookup);
    await tickUntilSettled(t, first, 60_000, 500);
    await first;
    assert.ok(Date.now() - startedAt >= 4_000);

    t.mock.timers.tick(60_000 - (Date.now() - startedAt) - 1);
    await loadOidcUserInfo(lookup);
    assert.equal(calls, 1, "still fresh just before 60 s from the start");
    t.mock.timers.tick(1);
    await loadOidcUserInfo(lookup);
    assert.equal(calls, 2, "expired 60 s from the start, not from the response");
  });

  it("still caps a slow UserInfo response at the access token's expiry", async (t) => {
    virtualTime(t);
    const lookup = { ...input(), expiresAt: Date.now() + 30_000 };
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      const respond = () => Response.json({ sub: "person" });
      return calls === 1 ? after(4_000, respond) : respond();
    });
    const startedAt = Date.now();
    const first = loadOidcUserInfo(lookup);
    await tickUntilSettled(t, first, 60_000, 500);
    await first;
    t.mock.timers.tick(30_000 - (Date.now() - startedAt) - 1);
    await loadOidcUserInfo(lookup);
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await assert.rejects(
      loadOidcUserInfo(lookup),
      (error: unknown) => error instanceof OidcUserInfoError && error.status === 401,
    );
  });
});

describe("Anaconda API key cache lifetime", () => {
  const env: IdentityEnvironment = {
    NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE: "user:anaconda",
    NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL: "https://anaconda.com/api/auth/sessions/whoami",
  };
  const apiKey = () =>
    [
      base64Url(JSON.stringify({ alg: "RS256", kid: "api-key-test", typ: "JWT" })),
      base64Url(JSON.stringify({ jti: crypto.randomUUID(), kid: "api-key-test", ver: "api:1" })),
      "signature",
    ].join(".");
  const whoami = () =>
    Response.json({
      passport: { user_id: "api-key-user", scopes: ["cloud:write"], source: "api_key" },
    });
  const authenticate = (token: string) =>
    authenticateRequestWithProviders(
      new Request("https://cloud.test/api/n?scope=owner", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    );

  it("a hung whoami lookup stops blocking later requests after its attempt deadline", async (t) => {
    virtualTime(t);
    const token = apiKey();
    let calls = 0;
    let firstSignal: AbortSignal | null | undefined;
    t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (++calls === 1) {
        firstSignal = init?.signal;
        return hang();
      }
      return whoami();
    });

    const owner = authenticate(token);
    const later = authenticate(token);
    const laterSettled = track(later);
    await turns();
    assert.equal(calls, 1, "the later request waits instead of fetching");

    t.mock.timers.tick(ANACONDA_API_KEY_ATTEMPT_MS - 1);
    await turns();
    assert.equal(laterSettled.settled, false);

    t.mock.timers.tick(1);
    await assert.rejects(owner, unavailable);
    assert.equal(firstSignal?.aborted, true, "the abandoned lookup is aborted");
    assert.equal((await settle(t, later)).principal, "user:anaconda:api-key-user");
    assert.equal(calls, 2);

    await authenticate(token);
    assert.equal(calls, 2, "a success is cached");
  });

  it("does not cache a failed whoami lookup", async (t) => {
    virtualTime(t);
    const token = apiKey();
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () =>
      ++calls === 1 ? new Response(null, { status: 502 }) : whoami(),
    );
    await assert.rejects(authenticate(token), AuthError);
    assert.equal((await authenticate(token)).principal, "user:anaconda:api-key-user");
    assert.equal(calls, 2);
  });

  it("measures expiry from the start of a slow whoami lookup", async (t) => {
    virtualTime(t);
    const token = apiKey();
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () =>
      ++calls === 1 ? after(9_000, whoami) : whoami(),
    );
    const startedAt = Date.now();
    const first = authenticate(token);
    await tickUntilSettled(t, first, 60_000, 500);
    assert.equal((await first).principal, "user:anaconda:api-key-user");
    assert.ok(Date.now() - startedAt >= 9_000);

    // A 9 s lookup is reusable until 60 s after it started, not until 69 s.
    t.mock.timers.tick(60_000 - (Date.now() - startedAt) - 1);
    await authenticate(token);
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await authenticate(token);
    assert.equal(calls, 2);
  });
});

describe("catalog schema readiness lifetime", () => {
  /** A D1 stand-in whose statements hang, fail or succeed on demand. */
  function fakeD1() {
    let mode: "hang" | "fail" | "ok" = "ok";
    let statements = 0;
    const result = () => {
      statements++;
      if (mode === "hang") return hang();
      if (mode === "fail") return Promise.reject(new Error("D1 is unavailable"));
      return Promise.resolve({ results: [], success: true, meta: {} });
    };
    const statement = {
      bind: () => statement,
      run: result,
      all: result,
      first: async () => null,
    };
    const db = {
      prepare: () => statement,
      batch: async (batch: (typeof statement)[]) => Promise.all(batch.map((entry) => entry.run())),
    } as unknown as D1Database;
    return {
      db,
      setMode: (next: typeof mode) => (mode = next),
      statements: () => statements,
    };
  }

  it("a hung schema setup stops blocking later requests after its attempt deadline", async (t) => {
    virtualTime(t);
    const d1 = fakeD1();
    d1.setMode("hang");
    const owner = ensureCatalogSchema({ DB: d1.db });
    const later = ensureCatalogSchema({ DB: d1.db });
    const laterSettled = track(later);
    await turns();
    assert.equal(d1.statements(), 1, "the later request waits instead of running the schema");

    t.mock.timers.tick(CATALOG_SCHEMA_ATTEMPT_MS - 1);
    await turns();
    assert.equal(laterSettled.settled, false);

    d1.setMode("ok");
    t.mock.timers.tick(1);
    await assert.rejects(owner, /timed out/);
    await settle(t, later);
    const afterSetup = d1.statements();
    assert.ok(afterSetup > 1);

    await ensureCatalogSchema({ DB: d1.db });
    assert.equal(d1.statements(), afterSetup, "settled readiness is cached");
  });

  it("does not cache a failed schema setup", async (t) => {
    virtualTime(t);
    const d1 = fakeD1();
    d1.setMode("fail");
    await assert.rejects(ensureCatalogSchema({ DB: d1.db }), /D1 is unavailable/);
    d1.setMode("ok");
    await ensureCatalogSchema({ DB: d1.db });
    const afterSetup = d1.statements();
    await ensureCatalogSchema({ DB: d1.db });
    assert.equal(d1.statements(), afterSetup);
  });
});
