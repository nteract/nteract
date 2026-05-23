import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACCESS_AUTH_TOKEN_PROTOCOL_PREFIX,
  AuthError,
  DEV_AUTH_TOKEN_PROTOCOL_PREFIX,
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
          "Sec-WebSocket-Protocol": devProtocol,
        },
      }),
      { DEPLOYMENT_ENV: "prototype", NOTEBOOK_CLOUD_DEV_TOKEN: "secret" },
    );
    assert.equal(websocketProtocolToken.actorLabel, "user:dev:alice/desktop:a");
    assert.equal(websocketProtocolToken.scope, "owner");
    assert.equal(websocketProtocolToken.webSocketProtocol, devProtocol);
    assert.equal(
      readTrustedIdentity(
        stampTrustedIdentity(new Request("https://cloud.test/n/demo/sync"), websocketProtocolToken),
      ).webSocketProtocol,
      devProtocol,
    );
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

  it("percent-encodes dev principal components", () => {
    assert.equal(
      principalForDevUser("alice/bob@example.com"),
      "user:dev:alice%2Fbob%40example.com",
    );
  });
});

describe("Cloudflare Access identity", () => {
  it("validates Access JWT assertions and maps sub to a room principal", async () => {
    const { env, token } = await accessTokenFixture({ subject: "user/123" });

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
    });
  });

  it("accepts browser WebSocket Access tokens through subprotocols", async () => {
    const { env, token } = await accessTokenFixture({ subject: "alice" });
    const protocol = `${ACCESS_AUTH_TOKEN_PROTOCOL_PREFIX}${base64Url(token)}`;

    const identity = await authenticateRequestWithProviders(
      new Request("https://cloud.test/n/demo/sync?operator=browser:tab&scope=viewer", {
        headers: {
          "Sec-WebSocket-Protocol": `other-proto, ${protocol}`,
        },
      }),
      env,
    );

    assert.equal(identity.actorLabel, "user:cloudflare-access:alice/browser:tab");
    assert.equal(identity.webSocketProtocol, protocol);
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
