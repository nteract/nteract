import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth";
import {
  cloudBlobAuthStateForBrowserFetch,
  cloudSyncAuthConnectionKey,
} from "../viewer/session-auth-stability";

function authState(overrides: Partial<CloudPrototypeAuthState> = {}): CloudPrototypeAuthState {
  return {
    mode: "oidc",
    token: "token-a",
    user: "user@example.test",
    oidcClaims: null,
    requestedScope: "owner",
    problem: null,
    ...overrides,
  };
}

describe("cloud session auth stability", () => {
  it("keeps cookie-backed blob fetch auth stable across OIDC token churn", () => {
    const first = cloudBlobAuthStateForBrowserFetch(authState({ token: "token-a" }));
    const second = cloudBlobAuthStateForBrowserFetch(authState({ token: "token-b" }));

    assert.equal(first, second);
    assert.deepEqual(first, {
      mode: "anonymous",
      token: null,
      user: null,
      oidcClaims: null,
      requestedScope: null,
      problem: null,
    });
  });

  it("keeps dev-token blob fetch auth keyed by the dev headers", () => {
    const first = cloudBlobAuthStateForBrowserFetch(
      authState({ mode: "dev", token: "dev-a", requestedScope: "owner" }),
    );
    const second = cloudBlobAuthStateForBrowserFetch(
      authState({ mode: "dev", token: "dev-b", requestedScope: "owner" }),
    );

    assert.notEqual(first, second);
    assert.equal(first.mode, "dev");
    assert.equal(first.token, "dev-a");
    assert.equal(second.token, "dev-b");
  });

  it("keeps app-session live room auth keyed to the session transport mode", () => {
    assert.equal(
      cloudSyncAuthConnectionKey(authState({ token: "token-a" }), { hasAppSession: true }),
      "app-session",
    );
    assert.equal(
      cloudSyncAuthConnectionKey(authState({ token: "token-b" }), { hasAppSession: true }),
      "app-session",
    );
  });

  it("keeps token-backed live room auth keyed by effective socket credentials", () => {
    const first = cloudSyncAuthConnectionKey(authState({ token: "token-a" }), {
      hasAppSession: false,
    });
    const second = cloudSyncAuthConnectionKey(authState({ token: "token-b" }), {
      hasAppSession: false,
    });

    assert.notEqual(first, second);
    assert.equal(first, "oidc:token-a:user@example.test:owner");
    assert.equal(second, "oidc:token-b:user@example.test:owner");
  });
});
