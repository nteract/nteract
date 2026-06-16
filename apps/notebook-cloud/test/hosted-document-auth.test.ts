import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectHostedDocumentAuthState } from "../viewer/hosted-document-auth.ts";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth.ts";

describe("hosted document auth projection", () => {
  it("lets app-session cookies drive catalog access when localStorage auth is stale", () => {
    const projection = projectHostedDocumentAuthState(authState("oidc_expired"), {
      appSession: { provider: "oidc", expires_at: 4_102_444_800 },
    });

    assert.equal(projection.hasAppSession, true);
    assert.equal(projection.signedIn, true);
    assert.equal(projection.canFetchCatalog, true);
    assert.equal(projection.waitingForAppSession, false);
    assert.equal(projection.showSignIn, false);
  });

  it("suppresses signed-out chrome while checking for an app-session cookie", () => {
    const projection = projectHostedDocumentAuthState(authState("anonymous"), {
      appSessionLoading: true,
    });

    assert.equal(projection.signedIn, false);
    assert.equal(projection.canFetchCatalog, false);
    assert.equal(projection.waitingForAppSession, true);
    assert.equal(projection.showSignIn, false);
  });

  it("waits for the browser app session before using OIDC-backed catalog APIs", () => {
    const projection = projectHostedDocumentAuthState(authState("oidc", { token: "token" }));

    assert.equal(projection.signedIn, true);
    assert.equal(projection.canFetchCatalog, false);
    assert.equal(projection.waitingForAppSession, true);
    assert.equal(projection.showSignIn, false);
  });

  it("keeps local dev auth as an immediate catalog authority", () => {
    const projection = projectHostedDocumentAuthState(authState("dev"));

    assert.equal(projection.signedIn, true);
    assert.equal(projection.canFetchCatalog, true);
    assert.equal(projection.waitingForAppSession, false);
    assert.equal(projection.showSignIn, false);
  });

  it("surfaces sign-in only after the anonymous session check resolves empty", () => {
    const projection = projectHostedDocumentAuthState(authState("anonymous"));

    assert.equal(projection.signedIn, false);
    assert.equal(projection.canFetchCatalog, false);
    assert.equal(projection.waitingForAppSession, false);
    assert.equal(projection.showSignIn, true);
  });
});

function authState(
  mode: CloudPrototypeAuthState["mode"],
  overrides: Partial<CloudPrototypeAuthState> = {},
): CloudPrototypeAuthState {
  return {
    mode,
    token: null,
    user: null,
    oidcClaims: null,
    requestedScope: null,
    problem: null,
    ...overrides,
  };
}
