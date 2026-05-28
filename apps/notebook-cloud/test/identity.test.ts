import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACCESS_AUTH_TOKEN_PROTOCOL_PREFIX,
  BEARER_AUTH_TOKEN_PROTOCOL_PREFIX,
  AuthError,
  DEV_AUTH_TOKEN_PROTOCOL_PREFIX,
  NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL,
  allowsBlobUpload,
  allowsRuntimeStateWrite,
  authenticateAnonymousViewer,
  authenticateDevRequest,
  authenticateRequest,
  authenticateRequestWithProviders,
  isAnonymousViewer,
  parseActorLabel,
  parseScope,
  principalForDevUser,
  readTrustedIdentity,
  rewriteActorLabelPrincipal,
  stampTrustedIdentity,
  validateOperator,
  validatePrincipal,
} from "../src/identity.ts";
import { accessTokenFixture, base64Url, oidcTokenFixture } from "./access-jwt-fixture.ts";

describe("dev identity", () => {
  it("uses explicit anonymous viewer auth when no dev credential is presented", () => {
    const identity = authenticateRequest(
      new Request("https://cloud.test/n/demo/sync?viewer_session=session/a"),
    );

    assert.deepEqual(identity, {
      principal: "anonymous:session%2Fa",
      operator: "browser:session%2Fa",
      actorLabel: "anonymous:session%2Fa/browser:session%2Fa",
      scope: "viewer",
      metadata: {
        provider: "anonymous",
        transport: "anonymous",
        principalNamespace: "anonymous",
        displayName: "Anonymous",
      },
    });
    assert.equal(isAnonymousViewer(identity), true);
  });

  it("keeps dev auth explicit instead of treating anonymous viewers as system actors", () => {
    const anonymous = authenticateAnonymousViewer(
      new Request("https://cloud.test/n/demo/sync?viewer_session=anon-1"),
    );
    const dev = authenticateRequest(
      new Request("http://localhost:8787/n/demo/sync?user=anonymous&operator=desktop:a"),
      { DEPLOYMENT_ENV: "development" },
    );

    assert.equal(anonymous.principal, "anonymous:anon-1");
    assert.equal(dev.principal, "user:dev:anonymous");
    assert.equal(anonymous.principal.startsWith("system"), false);
  });

  it("does not treat a bare scope parameter as dev authentication", () => {
    const identity = authenticateRequest(
      new Request("https://cloud.test/n/demo/sync?scope=viewer&viewer_session=anon-scope"),
      { DEPLOYMENT_ENV: "prototype" },
    );

    assert.equal(identity.actorLabel, "anonymous:anon-scope/browser:anon-scope");
    assert.equal(identity.scope, "viewer");
  });

  it("maps X-User and X-Operator into a layered actor label", () => {
    const request = new Request("https://cloud.test/n/demo/sync", {
      headers: {
        "X-User": "kyle@example.com",
        "X-Operator": "desktop:test-session",
        "X-Scope": "editor",
      },
    });

    const identity = authenticateDevRequest(request);

    assert.deepEqual(identity, {
      principal: "user:dev:kyle%40example.com",
      operator: "desktop:test-session",
      actorLabel: "user:dev:kyle%40example.com/desktop:test-session",
      scope: "editor",
      metadata: {
        provider: "dev",
        transport: "loopback-dev",
        principalNamespace: "user:dev",
        displayName: "kyle@example.com",
      },
    });
  });

  it("supports browser query params for the local viewer harness", () => {
    const request = new Request(
      "http://localhost:8787/n/demo/sync?user=alice&operator=agent:codex:s1&scope=owner",
    );

    const identity = authenticateRequest(request, { DEPLOYMENT_ENV: "prototype" });

    assert.equal(identity.actorLabel, "user:dev:alice/agent:codex:s1");
    assert.equal(identity.scope, "owner");
  });

  it("rejects remote dev credentials unless the prototype admin token is presented out of band", () => {
    const request = new Request(
      "https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=owner",
    );

    assert.throws(
      () => authenticateRequest(request, { DEPLOYMENT_ENV: "prototype" }),
      (error) => error instanceof AuthError && error.status === 401,
    );

    assert.throws(
      () => authenticateRequest(request, { DEPLOYMENT_ENV: "development" }),
      (error) => error instanceof AuthError && error.status === 401,
    );

    const queryToken = new Request(
      "https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=owner&dev_token=secret",
    );
    assert.throws(
      () =>
        authenticateRequest(queryToken, {
          DEPLOYMENT_ENV: "prototype",
          NOTEBOOK_CLOUD_DEV_TOKEN: "secret",
        }),
      (error) => error instanceof AuthError && error.status === 401,
    );

    const devProtocol = `${DEV_AUTH_TOKEN_PROTOCOL_PREFIX}${base64Url("secret")}`;
    const websocketProtocolToken = authenticateRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=owner", {
        headers: {
          "Sec-WebSocket-Protocol": `${devProtocol}, ${NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL}`,
        },
      }),
      { DEPLOYMENT_ENV: "prototype", NOTEBOOK_CLOUD_DEV_TOKEN: "secret" },
    );
    assert.equal(websocketProtocolToken.actorLabel, "user:dev:alice/desktop:a");
    assert.equal(websocketProtocolToken.scope, "owner");
    assert.equal(websocketProtocolToken.webSocketProtocol, NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL);
    const stamped = stampTrustedIdentity(
      new Request("https://cloud.test/n/demo/sync", {
        headers: {
          "Sec-WebSocket-Protocol": devProtocol,
        },
      }),
      websocketProtocolToken,
    );
    assert.equal(stamped.headers.get("Sec-WebSocket-Protocol"), NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL);
    assert.equal(readTrustedIdentity(stamped).webSocketProtocol, NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL);
  });

  it("does not let DEPLOYMENT_ENV=development bypass deployed dev auth", () => {
    const queryCredential = new Request(
      "https://cloud.test/n/demo/sync?user=alice&operator=desktop:a&scope=owner",
    );
    const headerCredential = new Request("https://cloud.test/n/demo/sync", {
      headers: {
        "X-User": "alice",
        "X-Operator": "desktop:a",
        "X-Scope": "owner",
      },
    });

    for (const request of [queryCredential, headerCredential]) {
      assert.throws(
        () => authenticateRequest(request, { DEPLOYMENT_ENV: "development" }),
        (error) => error instanceof AuthError && error.status === 401,
      );
    }
  });

  it("accepts remote dev token from headers and rejects same-prefix guesses", () => {
    const rejected = new Request("https://cloud.test/n/demo/sync?user=alice", {
      headers: {
        "X-Notebook-Cloud-Dev-Token": "secret-guess",
      },
    });
    assert.throws(
      () =>
        authenticateRequest(rejected, {
          DEPLOYMENT_ENV: "prototype",
          NOTEBOOK_CLOUD_DEV_TOKEN: "secret-token",
        }),
      (error) => error instanceof AuthError && error.status === 401,
    );

    const accepted = new Request("https://cloud.test/n/demo/sync?user=alice", {
      headers: {
        "X-Notebook-Cloud-Dev-Token": "secret-token",
      },
    });
    assert.equal(
      authenticateRequest(accepted, {
        DEPLOYMENT_ENV: "prototype",
        NOTEBOOK_CLOUD_DEV_TOKEN: "secret-token",
      }).principal,
      "user:dev:alice",
    );
  });

  it("allows dev credentials from loopback during wrangler local development", () => {
    const identity = authenticateRequest(
      new Request("http://127.0.0.1:8787/n/demo/sync?user=alice&operator=desktop:a"),
      { DEPLOYMENT_ENV: "prototype" },
    );

    assert.equal(identity.actorLabel, "user:dev:alice/desktop:a");
  });

  it("selects only the non-sensitive app protocol for browser localStorage auth", () => {
    const protocol = `${DEV_AUTH_TOKEN_PROTOCOL_PREFIX}${base64Url("local-dev-token")}`;
    const identity = authenticateRequest(
      new Request("http://127.0.0.1:8787/n/demo/sync?user=alice&scope=owner", {
        headers: {
          "Sec-WebSocket-Protocol": `${protocol}, ${NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL}`,
        },
      }),
      { DEPLOYMENT_ENV: "prototype" },
    );

    assert.equal(identity.principal, "user:dev:alice");
    assert.equal(identity.scope, "owner");
    assert.equal(identity.webSocketProtocol, NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL);
  });

  it("strips dev-token WebSocket subprotocols when no app protocol is offered", () => {
    const protocol = `${DEV_AUTH_TOKEN_PROTOCOL_PREFIX}${base64Url("local-dev-token")}`;
    const identity = authenticateRequest(
      new Request("http://127.0.0.1:8787/n/demo/sync?user=alice&scope=owner", {
        headers: {
          "Sec-WebSocket-Protocol": protocol,
        },
      }),
      { DEPLOYMENT_ENV: "prototype" },
    );

    assert.equal(identity.principal, "user:dev:alice");
    assert.equal(identity.webSocketProtocol, undefined);
    assert.equal(
      stampTrustedIdentity(
        new Request("http://127.0.0.1:8787/n/demo/sync", {
          headers: { "Sec-WebSocket-Protocol": protocol },
        }),
        identity,
      ).headers.has("Sec-WebSocket-Protocol"),
      false,
    );
  });

  it("defaults missing dev scope to viewer", () => {
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=anonymous&operator=desktop:a"),
    );

    assert.equal(identity.scope, "viewer");
  });

  it("stamps and reads trusted upstream identity headers", () => {
    const request = new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a");
    const identity = authenticateDevRequest(request);
    const stamped = stampTrustedIdentity(request, identity);

    assert.deepEqual(readTrustedIdentity(stamped), identity);
  });

  it("sanitizes optional trusted metadata headers", () => {
    const request = new Request(
      "https://cloud.test/n/demo/sync?user=Alice%0D%0ASet-Cookie&operator=desktop:a",
    );
    const identity = authenticateDevRequest(request);
    const stamped = stampTrustedIdentity(request, identity);

    assert.equal(stamped.headers.get("x-nteract-display-name"), "Alice Set-Cookie");
    assert.equal(readTrustedIdentity(stamped).metadata.displayName, "Alice Set-Cookie");
  });

  it("rewrites presence actor principal while preserving the operator suffix", () => {
    const identity = authenticateDevRequest(
      new Request("https://cloud.test/n/demo/sync?user=alice&operator=desktop:a"),
    );

    assert.equal(
      rewriteActorLabelPrincipal("user:dev:mallory/agent:codex:s2", identity),
      "user:dev:alice/agent:codex:s2",
    );
    assert.equal(rewriteActorLabelPrincipal("desktop:b", identity), "user:dev:alice/desktop:b");
  });

  it("validates the same principal and operator shape as nteract-identity", () => {
    for (const value of ["system", "system:anonymous", "local:kylekelley", "user:anaconda:550e"]) {
      assert.doesNotThrow(() => validatePrincipal(value));
    }
    for (const value of ["", "local", "local:", ":alice", "local/foo"]) {
      assert.throws(() => validatePrincipal(value));
    }
    for (const value of ["desktop:7f3a", "agent:codex:s2", "runtime:py-3.12-s4"]) {
      assert.doesNotThrow(() => validateOperator(value));
    }
    for (const value of ["", ":claude:s1", "agent/claude:s1"]) {
      assert.throws(() => validateOperator(value));
    }
  });

  it("parses actor labels and scopes explicitly", () => {
    assert.deepEqual(parseActorLabel("user:dev:alice/desktop:a"), {
      value: "user:dev:alice/desktop:a",
      principal: "user:dev:alice",
      operator: "desktop:a",
    });
    assert.equal(parseScope("runtime_peer"), "runtime_peer");
    assert.throws(() => parseScope("admin"), /unknown connection scope/);
  });

  it("keeps runtime-state write scope distinct from blob upload scope", () => {
    assert.equal(allowsRuntimeStateWrite("editor"), true);
    assert.equal(allowsBlobUpload("editor"), false);
    assert.equal(allowsBlobUpload("runtime_peer"), true);
    assert.equal(allowsBlobUpload("owner"), true);
    assert.equal(allowsBlobUpload("viewer"), false);
  });

  it("percent-encodes dev principal components", () => {
    assert.equal(
      principalForDevUser("alice/bob@example.com"),
      "user:dev:alice%2Fbob%40example.com",
    );
  });
});

describe("Cloudflare Access identity", () => {
  it("validates Access JWT assertions and maps sub to a room principal", async () => {
    const { env, token } = await accessTokenFixture({
      subject: "user/123",
      email: "alice@example.com",
      name: "Alice Demo",
    });

    const identity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/demo/sync?operator=desktop:a&scope=editor", {
        headers: {
          "Cf-Access-Jwt-Assertion": token,
        },
      }),
      env,
    );

    assert.deepEqual(identity, {
      principal: "user:cloudflare-access:user%2F123",
      operator: "desktop:a",
      actorLabel: "user:cloudflare-access:user%2F123/desktop:a",
      scope: "editor",
      metadata: {
        provider: "cloudflare-access",
        transport: "access-assertion",
        principalNamespace: "user:cloudflare-access",
        displayName: "Alice Demo",
        email: "alice@example.com",
      },
    });
  });

  it("accepts browser WebSocket Access tokens through subprotocols without echoing credentials", async () => {
    const { env, token } = await accessTokenFixture({ subject: "alice" });
    const protocol = `${ACCESS_AUTH_TOKEN_PROTOCOL_PREFIX}${base64Url(token)}`;

    const identity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/demo/sync?operator=browser:tab&scope=viewer", {
        headers: {
          "Sec-WebSocket-Protocol": `other-proto, ${protocol}, ${NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL}`,
        },
      }),
      env,
    );

    assert.equal(identity.actorLabel, "user:cloudflare-access:alice/browser:tab");
    assert.equal(identity.metadata.transport, "access-subprotocol");
    assert.equal(identity.webSocketProtocol, NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL);
  });

  it("rejects requests with multiple Access credential transports", async () => {
    const { env, token } = await accessTokenFixture({ subject: "alice" });
    const protocol = `${ACCESS_AUTH_TOKEN_PROTOCOL_PREFIX}${base64Url(token)}`;

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              Authorization: `Bearer ${token}`,
              "Sec-WebSocket-Protocol": protocol,
            },
          }),
          env,
        ),
      (error) =>
        error instanceof AuthError &&
        error.status === 400 &&
        /multiple identity credentials/.test(error.message),
    );
  });

  it("rejects mixed Access and dev identity credentials", async () => {
    const { env, token } = await accessTokenFixture({ subject: "alice" });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              "Cf-Access-Jwt-Assertion": token,
              "X-User": "alice",
            },
          }),
          env,
        ),
      (error) =>
        error instanceof AuthError &&
        error.status === 400 &&
        /multiple identity credentials/.test(error.message),
    );
  });

  it("accepts an Access assertion accompanied by its ambient Access cookie", async () => {
    const { env, token } = await accessTokenFixture({ subject: "alice" });

    const identity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/demo/sync?operator=browser:tab", {
        headers: {
          "Cf-Access-Jwt-Assertion": token,
          Cookie: `CF_Authorization=${token}`,
        },
      }),
      env,
    );

    assert.equal(identity.actorLabel, "user:cloudflare-access:alice/browser:tab");
    assert.equal(identity.scope, "viewer");
  });

  it("prefers forwarded Access assertions over client-carried header credentials", async () => {
    const { env, token } = await accessTokenFixture({ subject: "alice" });

    const identity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/demo/sync?operator=smoke:owner&scope=owner", {
        headers: {
          "Cf-Access-Jwt-Assertion": token,
          "CF-Access-Token": "not-a-jwt",
          Authorization: "Bearer not-a-jwt",
        },
      }),
      env,
    );

    assert.equal(identity.actorLabel, "user:cloudflare-access:alice/smoke:owner");
    assert.equal(identity.scope, "owner");
    assert.equal(identity.metadata.transport, "access-assertion");
  });

  it("rejects browser Access subprotocols when an Access assertion is already forwarded", async () => {
    const { env, token } = await accessTokenFixture({ subject: "alice" });
    const protocol = `${ACCESS_AUTH_TOKEN_PROTOCOL_PREFIX}${base64Url(token)}`;

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              "Cf-Access-Jwt-Assertion": token,
              "Sec-WebSocket-Protocol": protocol,
            },
          }),
          env,
        ),
      (error) =>
        error instanceof AuthError &&
        error.status === 400 &&
        /multiple identity credentials/.test(error.message),
    );
  });

  it("accepts Cloudflare Access CLI tokens from the cf-access-token header", async () => {
    const { env, token } = await accessTokenFixture({ subject: "alice" });

    const identity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/demo/sync?operator=smoke:owner&scope=owner", {
        headers: {
          "CF-Access-Token": token,
        },
      }),
      env,
    );

    assert.equal(identity.actorLabel, "user:cloudflare-access:alice/smoke:owner");
    assert.equal(identity.scope, "owner");
    assert.equal(identity.metadata.transport, "access-token-header");
  });

  it("prefers explicit Access token headers over ambient Access cookies", async () => {
    const { env, token } = await accessTokenFixture({ subject: "alice" });

    const identity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/demo/sync?operator=smoke:owner&scope=owner", {
        headers: {
          "CF-Access-Token": token,
          Cookie: `CF_Authorization=${token}`,
        },
      }),
      env,
    );

    assert.equal(identity.actorLabel, "user:cloudflare-access:alice/smoke:owner");
    assert.equal(identity.metadata.transport, "access-token-header");
  });

  it("prefers bearer Access tokens over ambient Access cookies", async () => {
    const { env, token } = await accessTokenFixture({ subject: "alice" });

    const identity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/demo/sync?operator=cli:smoke&scope=owner", {
        headers: {
          Authorization: `Bearer ${token}`,
          Cookie: `CF_Authorization=${token}`,
        },
      }),
      env,
    );

    assert.equal(identity.actorLabel, "user:cloudflare-access:alice/cli:smoke");
    assert.equal(identity.metadata.transport, "access-bearer");
  });

  it("rejects multiple explicit Access token credentials", async () => {
    const { env, token } = await accessTokenFixture({ subject: "alice" });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync?operator=cli:smoke&scope=owner", {
            headers: {
              "CF-Access-Token": token,
              Authorization: `Bearer ${token}`,
            },
          }),
          env,
        ),
      (error) =>
        error instanceof AuthError &&
        error.status === 400 &&
        /multiple identity credentials/.test(error.message),
    );
  });

  it("rejects Access token headers mixed with Access subprotocol credentials", async () => {
    const { env, token } = await accessTokenFixture({ subject: "alice" });
    const protocol = `${ACCESS_AUTH_TOKEN_PROTOCOL_PREFIX}${base64Url(token)}`;

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync?operator=cli:smoke&scope=owner", {
            headers: {
              "CF-Access-Token": token,
              "Sec-WebSocket-Protocol": protocol,
            },
          }),
          env,
        ),
      (error) =>
        error instanceof AuthError &&
        error.status === 400 &&
        /multiple identity credentials/.test(error.message),
    );
  });

  it("rejects Access tokens with the wrong audience", async () => {
    const { env, token } = await accessTokenFixture({
      audience: "wrong-audience",
      subject: "alice",
    });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }),
          env,
        ),
      (error) =>
        error instanceof AuthError && error.status === 401 && /audience/.test(error.message),
    );
  });

  it("ignores bearer tokens when Access auth is not configured", async () => {
    const { token } = await accessTokenFixture({ subject: "alice" });

    const identity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/demo/sync?viewer_session=anon-bearer", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      {},
    );

    assert.equal(identity.actorLabel, "anonymous:anon-bearer/browser:anon-bearer");
    assert.equal(identity.scope, "viewer");
  });

  it("rejects Access credentials when Access env is only partially configured", async () => {
    const { token } = await accessTokenFixture({ subject: "alice" });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              "Cf-Access-Jwt-Assertion": token,
            },
          }),
          { NOTEBOOK_CLOUD_ACCESS_AUD: "notebook-cloud-aud" },
        ),
      (error) =>
        error instanceof AuthError &&
        error.status === 503 &&
        /not fully configured/.test(error.message),
    );
  });

  it("rejects Access credentials when only a pinned JWKS is configured", async () => {
    const { env, token } = await accessTokenFixture({ subject: "alice" });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              "Cf-Access-Jwt-Assertion": token,
            },
          }),
          { NOTEBOOK_CLOUD_ACCESS_JWKS_JSON: env.NOTEBOOK_CLOUD_ACCESS_JWKS_JSON },
        ),
      (error) =>
        error instanceof AuthError &&
        error.status === 503 &&
        /not fully configured/.test(error.message),
    );
  });

  it("tries matching RSA keys when a rotating Access JWT omits kid", async () => {
    const { env, token } = await accessTokenFixture({
      includeKid: false,
      includeUnmatchedKey: true,
      subject: "alice",
    });

    const identity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/demo/sync?operator=desktop:a", {
        headers: {
          "Cf-Access-Jwt-Assertion": token,
        },
      }),
      env,
    );

    assert.equal(identity.actorLabel, "user:cloudflare-access:alice/desktop:a");
  });

  it("rejects Access JWKS candidates marked for encryption use", async () => {
    const { env, token } = await accessTokenFixture({
      matchingKeyUse: "enc",
      subject: "alice",
    });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync?operator=desktop:a", {
            headers: {
              "Cf-Access-Jwt-Assertion": token,
            },
          }),
          env,
        ),
      (error) =>
        error instanceof AuthError &&
        error.status === 401 &&
        /signing key was not found/.test(error.message),
    );
  });

  it("rejects Access JWKS candidates without verify key operations", async () => {
    const { env, token } = await accessTokenFixture({
      matchingKeyOps: ["encrypt"],
      subject: "alice",
    });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync?operator=desktop:a", {
            headers: {
              "Cf-Access-Jwt-Assertion": token,
            },
          }),
          env,
        ),
      (error) =>
        error instanceof AuthError &&
        error.status === 401 &&
        /signing key was not found/.test(error.message),
    );
  });

  it("skips malformed Access JWKS candidates and tries the next matching key", async () => {
    const { env, token } = await accessTokenFixture({
      includeKid: false,
      includeMalformedKey: true,
      subject: "alice",
    });

    const identity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/demo/sync?operator=desktop:a", {
        headers: {
          "Cf-Access-Jwt-Assertion": token,
        },
      }),
      env,
    );

    assert.equal(identity.actorLabel, "user:cloudflare-access:alice/desktop:a");
  });

  it("does not treat URL-carried Access tokens as credentials", async () => {
    const { env, token } = await accessTokenFixture({ subject: "alice" });

    const identity = await authenticateRequestWithProviders(
      new Request(`https://cloud.test/n/demo/sync?access_token=${encodeURIComponent(token)}`),
      env,
    );

    assert.equal(identity.principal.startsWith("anonymous:"), true);
    assert.equal(identity.scope, "viewer");
  });
});

describe("Anaconda API key identity", () => {
  it("validates Anaconda API key bearer tokens through whoami", async (t) => {
    const token = anacondaApiKeyToken();
    const calls: Array<{ url: string; authorization: string | null; userAgent: string | null }> =
      [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        userAgent: request.headers.get("user-agent"),
      });
      return jsonResponse(
        anacondaWhoami({
          userId: "fdb3dc7d-c369-4a39-bf7d-e35b77a0bdd0",
          email: "rgbkrk@gmail.com",
          firstName: "Kyle",
          lastName: "Kelley",
          scopes: ["cloud:read", "cloud:write"],
        }),
      );
    });

    const identity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/topic-viz/sync?operator=agent:runt-publish&scope=owner", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      anacondaApiKeyEnv(),
    );

    assert.deepEqual(identity, {
      principal: "user:anaconda:fdb3dc7d-c369-4a39-bf7d-e35b77a0bdd0",
      operator: "agent:runt-publish",
      actorLabel: "user:anaconda:fdb3dc7d-c369-4a39-bf7d-e35b77a0bdd0/agent:runt-publish",
      scope: "owner",
      metadata: {
        provider: "anaconda-api-key",
        transport: "api-key-bearer",
        principalNamespace: "user:anaconda",
        displayName: "Kyle Kelley",
        email: "rgbkrk@gmail.com",
      },
    });
    assert.deepEqual(calls, [
      {
        url: "https://anaconda.com/api/auth/sessions/whoami",
        authorization: `Bearer ${token}`,
        userAgent: "nteract-notebook-cloud/1.0",
      },
    ]);
  });

  it("routes API-key-shaped bearer tokens ahead of OIDC bearer handling", async (t) => {
    const token = anacondaApiKeyToken();
    const { env: oidcEnv } = await oidcTokenFixture({ subject: "browser-user" });
    t.mock.method(globalThis, "fetch", async () =>
      jsonResponse(
        anacondaWhoami({
          userId: "api-key-user",
          scopes: ["cloud:write"],
        }),
      ),
    );

    const identity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/topic-viz/sync?operator=agent:runt-publish&scope=owner", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      {
        ...oidcEnv,
        ...anacondaApiKeyEnv(),
      },
    );

    assert.equal(identity.actorLabel, "user:anaconda:api-key-user/agent:runt-publish");
    assert.equal(identity.metadata.provider, "anaconda-api-key");
  });

  it("keeps issuer-bearing OIDC tokens on the OIDC path even with an API-key version claim", async (t) => {
    const { env: oidcEnv, token } = await oidcTokenFixture({
      extraPayload: { ver: "api:1" },
      subject: "browser-user",
    });
    t.mock.method(globalThis, "fetch", async () => {
      throw new Error("Anaconda whoami should not be called for OIDC tokens");
    });

    const identity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/topic-viz/sync?operator=browser:tab&scope=viewer", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      {
        ...oidcEnv,
        ...anacondaApiKeyEnv(),
      },
    );

    assert.equal(identity.actorLabel, "user:anaconda:browser-user/browser:tab");
    assert.equal(identity.metadata.provider, "oidc");
  });

  it("caches successful API key whoami lookups during publish batches", async (t) => {
    const token = anacondaApiKeyToken();
    const calls: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request.headers.get("authorization") ?? "");
      return jsonResponse(
        anacondaWhoami({
          userId: "cached-api-key-user",
          scopes: ["cloud:write"],
        }),
      );
    });

    const first = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/topic-viz/runtime-snapshots/latest?scope=owner", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      anacondaApiKeyEnv(),
    );
    const second = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/topic-viz/blobs/blob-a?scope=owner", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      anacondaApiKeyEnv(),
    );

    assert.equal(first.principal, "user:anaconda:cached-api-key-user");
    assert.equal(second.principal, "user:anaconda:cached-api-key-user");
    assert.deepEqual(calls, [`Bearer ${token}`]);
  });

  it("rejects API keys without write scope for owner requests", async (t) => {
    const token = anacondaApiKeyToken();
    t.mock.method(globalThis, "fetch", async () =>
      jsonResponse(
        anacondaWhoami({
          userId: "read-only-user",
          scopes: ["cloud:read"],
        }),
      ),
    );

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request(
            "https://cloud.test/n/topic-viz/sync?operator=agent:runt-publish&scope=owner",
            {
              headers: {
                Authorization: `Bearer ${token}`,
              },
            },
          ),
          anacondaApiKeyEnv(),
        ),
      (error) =>
        error instanceof AuthError &&
        error.status === 403 &&
        /scopes do not allow/.test(error.message),
    );
  });

  it("accepts read-scoped API keys for viewer requests", async (t) => {
    const token = anacondaApiKeyToken();
    t.mock.method(globalThis, "fetch", async () =>
      jsonResponse(
        anacondaWhoami({
          userId: "read-only-user",
          scopes: ["cloud:read"],
        }),
      ),
    );

    const identity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/topic-viz/sync?operator=browser:viewer&scope=viewer", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      anacondaApiKeyEnv(),
    );

    assert.equal(identity.actorLabel, "user:anaconda:read-only-user/browser:viewer");
    assert.equal(identity.scope, "viewer");
  });

  it("rejects API-key-shaped bearer tokens when API key auth is not configured", async () => {
    const token = anacondaApiKeyToken();

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/topic-viz/sync", {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }),
          {},
        ),
      (error) =>
        error instanceof AuthError &&
        error.status === 503 &&
        /API key auth is not configured/.test(error.message),
    );
  });

  it("rejects non-API-key Anaconda whoami responses", async (t) => {
    const token = anacondaApiKeyToken();
    t.mock.method(globalThis, "fetch", async () =>
      jsonResponse(
        anacondaWhoami({
          source: "oauth",
          userId: "oauth-user",
          scopes: ["cloud:write"],
        }),
      ),
    );

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/topic-viz/sync", {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }),
          anacondaApiKeyEnv(),
        ),
      (error) =>
        error instanceof AuthError && error.status === 401 && /not an API key/.test(error.message),
    );
  });

  it("maps upstream Anaconda validation failures to auth failures", async (t) => {
    const token = anacondaApiKeyToken();
    t.mock.method(globalThis, "fetch", async () => new Response("invalid", { status: 401 }));

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/topic-viz/sync", {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }),
          anacondaApiKeyEnv(),
        ),
      (error) =>
        error instanceof AuthError &&
        error.status === 401 &&
        /validation failed/.test(error.message),
    );
  });
});

describe("OIDC identity", () => {
  it("validates direct OIDC bearer tokens and maps sub to a namespaced principal", async () => {
    const { env, token } = await oidcTokenFixture({
      subject: "user/123",
      email: "alice@example.com",
      name: "Alice Demo",
    });

    const identity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/demo/sync?operator=desktop:a&scope=editor", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      env,
    );

    assert.deepEqual(identity, {
      principal: "user:anaconda:user%2F123",
      operator: "desktop:a",
      actorLabel: "user:anaconda:user%2F123/desktop:a",
      scope: "editor",
      metadata: {
        provider: "oidc",
        transport: "oidc-bearer",
        principalNamespace: "user:anaconda",
        displayName: "Alice Demo",
        email: "alice@example.com",
      },
    });
  });

  it("accepts browser OIDC tokens through bearer subprotocols without echoing credentials", async () => {
    const { env, token } = await oidcTokenFixture({ subject: "alice" });
    const protocol = `${BEARER_AUTH_TOKEN_PROTOCOL_PREFIX}${base64Url(token)}`;

    const identity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/demo/sync?operator=browser:tab&scope=viewer", {
        headers: {
          "Sec-WebSocket-Protocol": `other-proto, ${protocol}, ${NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL}`,
        },
      }),
      env,
    );

    assert.equal(identity.actorLabel, "user:anaconda:alice/browser:tab");
    assert.equal(identity.metadata.provider, "oidc");
    assert.equal(identity.metadata.transport, "oidc-subprotocol");
    assert.equal(identity.webSocketProtocol, NOTEBOOK_CLOUD_WEBSOCKET_PROTOCOL);
  });

  it("rejects mixed OIDC and Access credentials", async () => {
    const { env: oidcEnv, token: oidcToken } = await oidcTokenFixture({ subject: "alice" });
    const { token: accessToken } = await accessTokenFixture({ subject: "alice" });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              Authorization: `Bearer ${oidcToken}`,
              "Cf-Access-Jwt-Assertion": accessToken,
            },
          }),
          oidcEnv,
        ),
      (error) =>
        error instanceof AuthError &&
        error.status === 400 &&
        /multiple identity credentials/.test(error.message),
    );
  });

  it("rejects OIDC credentials when OIDC env is partially configured", async () => {
    const { env, token } = await oidcTokenFixture({ subject: "alice" });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }),
          { NOTEBOOK_CLOUD_OIDC_ISSUER: env.NOTEBOOK_CLOUD_OIDC_ISSUER },
        ),
      (error) =>
        error instanceof AuthError &&
        error.status === 503 &&
        /not fully configured/.test(error.message),
    );
  });

  it("rejects OIDC tokens with the wrong audience", async () => {
    const { env, token } = await oidcTokenFixture({
      audience: "wrong-audience",
      subject: "alice",
    });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }),
          env,
        ),
      (error) =>
        error instanceof AuthError && error.status === 401 && /audience/.test(error.message),
    );
  });

  it("keeps Access bearer auth working when OIDC config is only partially set", async () => {
    const { env: accessEnv, token } = await accessTokenFixture({ subject: "alice" });

    const identity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/demo/sync?operator=cli:smoke&scope=owner", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      {
        ...accessEnv,
        NOTEBOOK_CLOUD_OIDC_ISSUER: "https://auth.stage.anaconda.com/api/auth",
      },
    );

    assert.equal(identity.actorLabel, "user:cloudflare-access:alice/cli:smoke");
    assert.equal(identity.metadata.transport, "access-bearer");
  });

  it("routes bearer tokens by issuer when Access and OIDC are both configured", async () => {
    const { env: accessEnv, token: accessToken } = await accessTokenFixture({ subject: "alice" });
    const { env: oidcEnv, token: oidcToken } = await oidcTokenFixture({ subject: "bob" });
    const env = { ...accessEnv, ...oidcEnv };

    const accessIdentity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/demo/sync?operator=cli:access&scope=owner", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }),
      env,
    );
    const oidcIdentity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/demo/sync?operator=browser:oidc&scope=editor", {
        headers: {
          Authorization: `Bearer ${oidcToken}`,
        },
      }),
      env,
    );

    assert.equal(accessIdentity.actorLabel, "user:cloudflare-access:alice/cli:access");
    assert.equal(accessIdentity.metadata.transport, "access-bearer");
    assert.equal(oidcIdentity.actorLabel, "user:anaconda:bob/browser:oidc");
    assert.equal(oidcIdentity.metadata.transport, "oidc-bearer");
  });

  it("rejects non-JWT bearer tokens when Access and OIDC are both configured", async () => {
    const { env: accessEnv } = await accessTokenFixture({ subject: "alice" });
    const { env: oidcEnv } = await oidcTokenFixture({ subject: "bob" });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              Authorization: "Bearer not-a-jwt",
            },
          }),
          { ...accessEnv, ...oidcEnv },
        ),
      (error) =>
        error instanceof AuthError && error.status === 401 && /JWT with issuer/.test(error.message),
    );
  });

  it("rejects bearer JWTs without issuer when Access and OIDC are both configured", async () => {
    const { env: accessEnv } = await accessTokenFixture({ subject: "alice" });
    const { env: oidcEnv, token } = await oidcTokenFixture({
      subject: "bob",
      tokenIssuer: null,
    });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }),
          { ...accessEnv, ...oidcEnv },
        ),
      (error) =>
        error instanceof AuthError && error.status === 401 && /JWT with issuer/.test(error.message),
    );
  });

  it("rejects bearer JWTs from neither provider when Access and OIDC are both configured", async () => {
    const { env: accessEnv } = await accessTokenFixture({ subject: "alice" });
    const { env: oidcEnv, token } = await oidcTokenFixture({
      subject: "bob",
      tokenIssuer: "https://neither-provider.example.test",
    });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }),
          { ...accessEnv, ...oidcEnv },
        ),
      (error) => error instanceof AuthError && error.status === 401 && /issuer/.test(error.message),
    );
  });

  it("rejects OIDC tokens with the wrong issuer", async () => {
    const { env, token } = await oidcTokenFixture({
      subject: "alice",
      tokenIssuer: "https://evil.example.test",
    });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }),
          env,
        ),
      (error) => error instanceof AuthError && error.status === 401 && /issuer/.test(error.message),
    );
  });

  it("rejects expired OIDC tokens", async () => {
    const { env, token } = await oidcTokenFixture({
      expiresInSeconds: -300,
      subject: "alice",
    });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }),
          env,
        ),
      (error) =>
        error instanceof AuthError && error.status === 401 && /expired/.test(error.message),
    );
  });

  it("rejects not-yet-valid OIDC tokens", async () => {
    const { env, token } = await oidcTokenFixture({
      notBeforeSecondsFromNow: 300,
      subject: "alice",
    });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }),
          env,
        ),
      (error) =>
        error instanceof AuthError && error.status === 401 && /not valid yet/.test(error.message),
    );
  });

  it("rejects OIDC tokens without a subject", async () => {
    const { env, token } = await oidcTokenFixture({ subject: null });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }),
          env,
        ),
      (error) =>
        error instanceof AuthError && error.status === 401 && /missing sub/.test(error.message),
    );
  });

  it("rejects OIDC tokens with oversized subjects", async () => {
    const { env, token } = await oidcTokenFixture({
      subject: "a".repeat(257),
    });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }),
          env,
        ),
      (error) =>
        error instanceof AuthError && error.status === 401 && /sub is too long/.test(error.message),
    );
  });

  it("rejects OIDC tokens with invalid signatures", async () => {
    const { env, token } = await oidcTokenFixture({ subject: "alice" });
    const parts = token.split(".");
    const signature = parts[2];
    assert.ok(signature);
    const tamperedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    const tamperedToken = `${parts[0]}.${parts[1]}.${tamperedSignature}`;

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              Authorization: `Bearer ${tamperedToken}`,
            },
          }),
          env,
        ),
      (error) =>
        error instanceof AuthError && error.status === 401 && /signature/.test(error.message),
    );
  });

  it("rejects OIDC tokens signed by unpublished keys", async () => {
    const { env, token } = await oidcTokenFixture({
      excludeMatchingKey: true,
      includeUnmatchedKey: true,
      subject: "alice",
    });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }),
          env,
        ),
      (error) =>
        error instanceof AuthError && error.status === 401 && /signing key/.test(error.message),
    );
  });

  it("rejects non-RS256 OIDC tokens before signature validation", async () => {
    const { env, token } = await oidcTokenFixture({
      algorithm: "HS256",
      subject: "alice",
    });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }),
          env,
        ),
      (error) => error instanceof AuthError && error.status === 401 && /RS256/.test(error.message),
    );
  });

  it("rejects multi-audience OIDC tokens without a matching authorized party", async () => {
    const { env, token } = await oidcTokenFixture({
      audience: ["notebook-cloud-oidc-client", "other-client"],
      subject: "alice",
    });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }),
          env,
        ),
      (error) =>
        error instanceof AuthError &&
        error.status === 401 &&
        /authorized party/.test(error.message),
    );
  });

  it("accepts multi-audience OIDC tokens with a matching authorized party", async () => {
    const { env, token } = await oidcTokenFixture({
      audience: ["notebook-cloud-oidc-client", "other-client"],
      authorizedParty: "notebook-cloud-oidc-client",
      subject: "alice",
    });

    const identity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/demo/sync?operator=browser:tab", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      env,
    );

    assert.equal(identity.actorLabel, "user:anaconda:alice/browser:tab");
  });

  it("rejects OIDC tokens with extra JWT segments", async () => {
    const { env, token } = await oidcTokenFixture({ subject: "alice" });

    await assert.rejects(
      () =>
        authenticateRequestWithProviders(
          new Request("https://cloud.test/n/demo/sync", {
            headers: {
              Authorization: `Bearer ${token}.extra`,
            },
          }),
          env,
        ),
      (error) =>
        error instanceof AuthError && error.status === 401 && /must be a JWT/.test(error.message),
    );
  });
});

function anacondaApiKeyEnv(): {
  NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE: string;
  NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL: string;
} {
  return {
    NOTEBOOK_CLOUD_ANACONDA_API_KEY_PRINCIPAL_NAMESPACE: "user:anaconda",
    NOTEBOOK_CLOUD_ANACONDA_API_KEY_USERINFO_URL: "https://anaconda.com/api/auth/sessions/whoami",
  };
}

function anacondaApiKeyToken(payload: Record<string, unknown> = {}): string {
  return [
    base64Url(JSON.stringify({ alg: "RS256", kid: "api-key-test", typ: "JWT" })),
    base64Url(
      JSON.stringify({ jti: crypto.randomUUID(), kid: "api-key-test", ver: "api:1", ...payload }),
    ),
    "signature",
  ].join(".");
}

function anacondaWhoami(options: {
  email?: string;
  firstName?: string;
  lastName?: string;
  scopes: string[];
  source?: string;
  userId: string;
}): unknown {
  return {
    passport: {
      user_id: options.userId,
      profile: {
        email: options.email ?? "user@example.com",
        first_name: options.firstName ?? "",
        last_name: options.lastName ?? "",
      },
      scopes: options.scopes,
      source: options.source ?? "api_key",
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      "Content-Type": "application/json",
    },
  });
}
