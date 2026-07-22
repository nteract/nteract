import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectHostedCatalogAuthState } from "../viewer/hosted-catalog-auth";
import type { CloudAppSession } from "../viewer/app-session";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth";

describe("hosted catalog auth projection", () => {
  it("keeps anonymous visitors signed out", () => {
    const projection = projectHostedCatalogAuthState(auth("anonymous"));

    assert.deepEqual(projection, {
      appSessionLoading: false,
      canFetchCatalog: false,
      hasAppSession: false,
      hasExplicitAuth: false,
      showSignIn: true,
      signedIn: false,
      waitingForAppSession: false,
    });
  });

  it("waits for an OIDC browser to exchange an app-session cookie", () => {
    const projection = projectHostedCatalogAuthState(auth("oidc"), {
      appSessionLoading: true,
    });

    assert.equal(projection.signedIn, true);
    assert.equal(projection.canFetchCatalog, false);
    assert.equal(projection.showSignIn, false);
    assert.equal(projection.waitingForAppSession, true);
  });

  it("allows catalog fetches once an app session exists", () => {
    const projection = projectHostedCatalogAuthState(auth("oidc"), {
      appSession: appSession(),
    });

    assert.equal(projection.signedIn, true);
    assert.equal(projection.canFetchCatalog, true);
    assert.equal(projection.hasAppSession, true);
    assert.equal(projection.showSignIn, false);
    assert.equal(projection.waitingForAppSession, false);
  });

  it("keeps an expired OIDC identity in recovery while token renewal is active", () => {
    const projection = projectHostedCatalogAuthState(auth("oidc_expired"), {
      authRenewal: { kind: "refreshing", message: "Refreshing sign-in..." },
    });

    assert.equal(projection.signedIn, false);
    assert.equal(projection.canFetchCatalog, false);
    assert.equal(projection.showSignIn, false);
    assert.equal(projection.waitingForAppSession, true);

    const failed = projectHostedCatalogAuthState(auth("oidc_expired"), {
      authRenewal: { kind: "failed", message: "Sign-in refresh failed." },
    });
    assert.equal(failed.showSignIn, true);
    assert.equal(failed.waitingForAppSession, false);
  });

  it("keeps local dev auth usable without app sessions", () => {
    const projection = projectHostedCatalogAuthState(auth("dev"));

    assert.equal(projection.signedIn, true);
    assert.equal(projection.canFetchCatalog, true);
    assert.equal(projection.hasExplicitAuth, true);
    assert.equal(projection.showSignIn, false);
  });
});

function auth(mode: CloudPrototypeAuthState["mode"]): CloudPrototypeAuthState {
  return {
    mode,
    token: mode === "dev" || mode === "oidc" ? "token" : null,
    user: mode === "dev" ? "local-user" : mode === "oidc" ? "OIDC User" : null,
    oidcClaims: mode === "oidc" ? { sub: "user-a" } : null,
    requestedScope: mode === "anonymous" ? null : "viewer",
    problem: null,
  };
}

function appSession(): CloudAppSession {
  return {
    provider: "oidc",
    expires_at: 1_750_000_000,
    cache_key: "cache-a",
  };
}
