import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACCESS_AUTH_TOKEN_PROTOCOL_PREFIX,
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
import { accessTokenFixture, base64Url } from "./access-jwt-fixture.ts";

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
