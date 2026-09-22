import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AuthError, authenticateRequestWithProviders } from "../src/identity.ts";
import { oidcTokenFixture } from "./oidc-jwt-fixture.ts";

async function remoteFixture(issuer: string) {
  const fixture = await oidcTokenFixture({ subject: "discovery-user", tokenIssuer: issuer });
  const env = {
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

function unavailable(error: unknown): boolean {
  return error instanceof AuthError && error.status === 503;
}

describe("OIDC signing key discovery", () => {
  it("uses advertised HTTPS keys on another origin and coalesces discovery with the key cache", async (t) => {
    const issuer = "https://discovery-cache.test/tenant";
    const keyUrl = "https://keys.discovery-cache.test/oauth2/jwks";
    const fixture = await remoteFixture(issuer);
    const calls: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request.url);
      assert.equal(request.redirect, "manual");
      assert.ok(init?.signal instanceof AbortSignal);
      if (request.url === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({ issuer, jwks_uri: keyUrl });
      }
      assert.equal(request.url, keyUrl);
      return new Response(fixture.jwks);
    });

    const identities = await Promise.all([fixture.authenticate(), fixture.authenticate()]);
    assert.equal(identities[0].principal, "user:anaconda:discovery-user");
    await fixture.authenticate();
    assert.deepEqual(calls, [`${issuer}/.well-known/openid-configuration`, keyUrl]);

    const afterExpiry = Date.now() + 5 * 60 * 1000 + 1;
    t.mock.method(Date, "now", () => afterExpiry);
    await fixture.authenticate();
    assert.deepEqual(calls, [
      `${issuer}/.well-known/openid-configuration`,
      keyUrl,
      `${issuer}/.well-known/openid-configuration`,
      keyUrl,
    ]);
  });

  it("keeps HTTP discovery restricted to the configured loopback origin", async (t) => {
    const issuer = "http://127.0.0.1:9797/dev/oidc";
    const fixture = await remoteFixture(issuer);
    const calls: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return url.endsWith("openid-configuration")
        ? Response.json({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json` })
        : new Response(fixture.jwks);
    });
    assert.equal((await fixture.authenticate()).metadata.provider, "oidc");
    assert.deepEqual(calls, [
      `${issuer}/.well-known/openid-configuration`,
      `${issuer}/.well-known/jwks.json`,
    ]);
  });

  it("does not fetch discovery when signing keys are pinned", async (t) => {
    const fixture = await oidcTokenFixture({ subject: "pinned-user" });
    t.mock.method(globalThis, "fetch", async () => {
      assert.fail("pinned signing keys must not use the network");
    });
    const identity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/api/auth/session", {
        headers: { Authorization: `Bearer ${fixture.token}` },
      }),
      fixture.env,
    );
    assert.equal(identity.principal, "user:anaconda:pinned-user");
  });

  it("rejects malformed metadata and issuer mismatches without fetching keys", async (t) => {
    const issuer = "https://discovery-invalid-metadata.test/tenant";
    const fixture = await remoteFixture(issuer);
    const invalidDocuments = [
      "not json",
      "null",
      "[]",
      JSON.stringify({ jwks_uri: "https://keys.test/jwks" }),
      JSON.stringify({ issuer: `${issuer}/`, jwks_uri: "https://keys.test/jwks" }),
      JSON.stringify({ issuer: "https://other-issuer.test", jwks_uri: "https://keys.test/jwks" }),
      JSON.stringify({ issuer }),
    ];
    let document = "";
    const calls: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(document);
    });
    for (const invalid of invalidDocuments) {
      document = invalid;
      await assert.rejects(fixture.authenticate, unavailable);
    }
    assert.deepEqual(
      calls,
      invalidDocuments.map(() => `${issuer}/.well-known/openid-configuration`),
    );
  });

  it("rejects unsafe advertised key URLs before following them", async (t) => {
    const issuer = "https://discovery-unsafe-keys.test";
    const fixture = await remoteFixture(issuer);
    const invalidUrls = [
      "/oauth2/jwks",
      "http://keys.test/jwks",
      "http://127.0.0.1:9797/jwks",
      "file:///tmp/jwks.json",
      "https://user:password@keys.test/jwks",
      "https://keys.test/jwks#fragment",
      null,
    ];
    let jwksUrl: unknown;
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      calls += 1;
      assert.equal(String(input), `${issuer}/.well-known/openid-configuration`);
      return Response.json({ issuer, jwks_uri: jwksUrl });
    });
    for (const invalid of invalidUrls) {
      jwksUrl = invalid;
      await assert.rejects(fixture.authenticate, unavailable);
    }
    assert.equal(calls, invalidUrls.length);
  });

  it("does not let a loopback issuer advertise another HTTP origin", async (t) => {
    const issuer = "http://localhost:9798/dev/oidc";
    const fixture = await remoteFixture(issuer);
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      assert.equal(String(input), `${issuer}/.well-known/openid-configuration`);
      return Response.json({ issuer, jwks_uri: "http://localhost:9799/keys" });
    });
    await assert.rejects(fixture.authenticate, unavailable);
  });

  for (const stage of ["discovery", "keys"]) {
    it(`retries discovery after a failed ${stage} request`, async (t) => {
      const issuer = `https://discovery-retry-${stage}.test`;
      const fixture = await remoteFixture(issuer);
      let fail = true;
      let discoveryCalls = 0;
      t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
        const discovery = String(input).endsWith("openid-configuration");
        if (discovery) discoveryCalls += 1;
        if (fail && discovery === (stage === "discovery")) {
          return new Response("unavailable", { status: 503 });
        }
        return discovery
          ? Response.json({ issuer, jwks_uri: `${issuer}/oauth2/jwks` })
          : new Response(fixture.jwks);
      });
      await assert.rejects(fixture.authenticate, unavailable);
      fail = false;
      assert.equal((await fixture.authenticate()).metadata.provider, "oidc");
      assert.equal(discoveryCalls, 2);
    });
  }

  it("maps timeout and redirect failures to unavailable authentication", async (t) => {
    const issuer = "https://discovery-fetch-error.test";
    const fixture = await remoteFixture(issuer);
    const timeouts: number[] = [];
    t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
      timeouts.push(milliseconds);
      return AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
    });
    let failure: Error = new DOMException("timed out", "TimeoutError");
    t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(init?.redirect, "manual");
      assert.equal(init?.signal?.aborted, true);
      throw failure;
    });
    await assert.rejects(fixture.authenticate, unavailable);
    failure = new TypeError("unexpected redirect");
    await assert.rejects(fixture.authenticate, unavailable);
    assert.deepEqual(timeouts, [10_000, 10_000]);
  });
});
