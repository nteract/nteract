import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  authenticateDevRequest,
  parseActorLabel,
  parseScope,
  principalForDevUser,
  readTrustedIdentity,
  rewriteActorLabelPrincipal,
  stampTrustedIdentity,
  validateOperator,
  validatePrincipal,
} from "../src/identity.ts";

describe("dev identity", () => {
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
      "https://cloud.test/n/demo/sync?user=alice&operator=agent:codex:s1&scope=owner",
    );

    const identity = authenticateDevRequest(request);

    assert.equal(identity.actorLabel, "user:dev:alice/agent:codex:s1");
    assert.equal(identity.scope, "owner");
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
