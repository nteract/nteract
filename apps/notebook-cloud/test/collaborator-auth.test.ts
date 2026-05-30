import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY,
  NOTEBOOK_CLOUD_DEFAULT_SCOPE,
  NOTEBOOK_CLOUD_OIDC_REQUEST_STORAGE_KEY,
  NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY,
  NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY,
  NOTEBOOK_CLOUD_USER_STORAGE_KEY,
  cloudHttpHeadersFromPrototypeAuthState,
  cloudNotebookSignInCopy,
  clearCloudPrototypeDevAuth,
  cloudSyncAuthFromPrototypeAuthState,
  isCloudPrototypeAuthStorageKey,
  prepareCloudOidcViewerLogin,
  prototypeAuthDiagnostics,
  prototypeAuthSummary,
  readCloudPrototypeAuth,
  storeCloudPrototypeDevAuth,
  storeCloudRequestedScope,
  validatePrototypeToken,
  type CloudPrototypeAuthStorage,
} from "../viewer/collaborator-auth.ts";

describe("cloud collaborator auth", () => {
  it("uses anonymous viewer auth when no prototype token is stored", () => {
    const state = readCloudPrototypeAuth(new MemoryStorage());

    assert.equal(state.mode, "anonymous");
    assert.deepEqual(cloudSyncAuthFromPrototypeAuthState(state), {
      headers: {},
      protocols: [],
      user: null,
      operator: null,
      requestedScope: null,
    });
  });

  it("identifies auth storage keys that should refresh stale browser tabs", () => {
    assert.equal(isCloudPrototypeAuthStorageKey(NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY), true);
    assert.equal(isCloudPrototypeAuthStorageKey(NOTEBOOK_CLOUD_USER_STORAGE_KEY), true);
    assert.equal(isCloudPrototypeAuthStorageKey(NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY), true);
    assert.equal(isCloudPrototypeAuthStorageKey(NOTEBOOK_CLOUD_OIDC_REQUEST_STORAGE_KEY), true);
    assert.equal(isCloudPrototypeAuthStorageKey(NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY), true);
    assert.equal(isCloudPrototypeAuthStorageKey(null), true);
    assert.equal(isCloudPrototypeAuthStorageKey("nteract:notebook-cloud:theme"), false);
  });

  it("builds WebSocket subprotocol auth without putting the token in the URL", () => {
    const storage = new MemoryStorage();
    storeCloudPrototypeDevAuth(storage, {
      token: "secret",
      user: "alice",
      scope: "editor",
    });

    const state = readCloudPrototypeAuth(storage);
    const auth = cloudSyncAuthFromPrototypeAuthState(state);

    assert.equal(state.mode, "dev");
    assert.equal(auth.user, "alice");
    assert.equal(auth.requestedScope, "editor");
    assert.deepEqual(auth.headers, { "x-notebook-cloud-dev-token": "secret" });
    assert.deepEqual(auth.protocols, ["nteract-dev-token.c2VjcmV0", "nteract.v4"]);
  });

  it("builds OIDC bearer auth for HTTP and WebSocket without putting tokens in the URL", () => {
    const storage = new MemoryStorage();
    const accessToken = jwt({
      sub: "anaconda-user-123",
      email: "alice@example.com",
      email_verified: true,
      name: "Alice",
    });
    storage.setItem(
      NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY,
      JSON.stringify({
        accessToken,
        refreshToken: null,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        claims: {
          sub: "anaconda-user-123",
          email: "alice@example.com",
          email_verified: true,
          name: "Alice",
        },
      }),
    );
    storage.setItem(NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY, "editor");

    const state = readCloudPrototypeAuth(storage);
    const auth = cloudSyncAuthFromPrototypeAuthState(state);

    assert.equal(state.mode, "oidc");
    assert.equal(state.user, "Alice");
    assert.equal(auth.user, null);
    assert.equal(auth.requestedScope, "editor");
    assert.deepEqual(auth.headers, { Authorization: `Bearer ${accessToken}` });
    assert.deepEqual(auth.protocols, [`nteract-bearer.${base64Url(accessToken)}`, "nteract.v4"]);
    assert.deepEqual(cloudHttpHeadersFromPrototypeAuthState(state), {
      Authorization: `Bearer ${accessToken}`,
    });
  });

  it("defaults OIDC browser sessions to viewer scope", () => {
    const storage = new MemoryStorage();
    const accessToken = jwt({
      sub: "anaconda-user-456",
      email: "anil@example.com",
      email_verified: true,
      name: "Anil",
    });
    storage.setItem(
      NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY,
      JSON.stringify({
        accessToken,
        refreshToken: null,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        claims: {
          sub: "anaconda-user-456",
          email: "anil@example.com",
          email_verified: true,
          name: "Anil",
        },
      }),
    );

    const state = readCloudPrototypeAuth(storage);
    const auth = cloudSyncAuthFromPrototypeAuthState(state);

    assert.equal(state.mode, "oidc");
    assert.equal(state.requestedScope, NOTEBOOK_CLOUD_DEFAULT_SCOPE);
    assert.equal(auth.requestedScope, NOTEBOOK_CLOUD_DEFAULT_SCOPE);
    assert.match(prototypeAuthSummary(state), /Anil requesting viewer/);
  });

  it("keeps expired non-refreshable OIDC sessions visible for renewal", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY,
      JSON.stringify({
        accessToken: jwt({
          sub: "anaconda-user-expired",
          email: "expired@example.com",
          name: "Expired User",
        }),
        refreshToken: null,
        expiresAt: Math.floor(Date.now() / 1000) - 3600,
        claims: {
          sub: "anaconda-user-expired",
          email: "expired@example.com",
          name: "Expired User",
        },
      }),
    );
    storage.setItem(NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY, "editor");

    const state = readCloudPrototypeAuth(storage);

    assert.equal(state.mode, "oidc_expired");
    assert.equal(state.token, null);
    assert.equal(state.user, "Expired User");
    assert.equal(state.requestedScope, NOTEBOOK_CLOUD_DEFAULT_SCOPE);
    assert.equal(state.problem, "Stored OIDC session is expired. Sign in again.");
    assert.equal(prototypeAuthSummary(state), "Expired User needs sign-in renewal.");
    assert.deepEqual(cloudSyncAuthFromPrototypeAuthState(state), {
      headers: {},
      protocols: [],
      user: null,
      operator: null,
      requestedScope: null,
    });
  });

  it("diagnoses expired OIDC sessions without exposing stale bearer material", () => {
    const storage = new MemoryStorage();
    const accessToken = jwt({
      sub: "anaconda-user-expired",
      email: "expired@example.com",
      name: "Expired User",
    });
    storage.setItem(
      NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY,
      JSON.stringify({
        accessToken,
        refreshToken: null,
        expiresAt: Math.floor(Date.now() / 1000) - 3600,
        claims: {
          sub: "anaconda-user-expired",
          email: "expired@example.com",
          name: "Expired User",
        },
      }),
    );

    const diagnostics = prototypeAuthDiagnostics(readCloudPrototypeAuth(storage), {
      actorLabel: null,
      connectionError: null,
      connectionScope: "viewer",
    });

    assert.match(diagnostics.copyText, /Stored identity: Expired User/);
    assert.match(diagnostics.copyText, /Sign-in: Stored OIDC session is expired/);
    assert.match(diagnostics.copyText, /Effective auth: No expired bearer token is sent/);
    assert.doesNotMatch(diagnostics.copyText, new RegExp(accessToken.replaceAll(".", "\\.")));
  });

  it("uses state-specific notebook page sign-in copy", () => {
    const anonymous = readCloudPrototypeAuth(new MemoryStorage());
    assert.deepEqual(cloudNotebookSignInCopy(anonymous, "idle"), {
      label: "Sign in",
      title: "Sign in with Anaconda",
    });
    assert.deepEqual(cloudNotebookSignInCopy(anonymous, "starting"), {
      label: "Signing in",
      title: "Starting Anaconda sign-in",
    });
    assert.deepEqual(cloudNotebookSignInCopy(anonymous, "idle", "network failed"), {
      label: "Sign-in failed",
      title: "network failed",
    });

    const storage = new MemoryStorage();
    storage.setItem(
      NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY,
      JSON.stringify({
        accessToken: jwt({ sub: "expired-user", name: "Expired User" }),
        refreshToken: null,
        expiresAt: Math.floor(Date.now() / 1000) - 3600,
        claims: { sub: "expired-user", name: "Expired User" },
      }),
    );

    assert.deepEqual(cloudNotebookSignInCopy(readCloudPrototypeAuth(storage), "idle"), {
      label: "Sign in again",
      title: "Renew your Anaconda sign-in for this notebook",
    });
  });

  it("switches requested scope without replacing stored OIDC token material", () => {
    const storage = new MemoryStorage();
    const accessToken = jwt({
      sub: "anaconda-user-789",
      email: "kyle@example.com",
      email_verified: true,
      name: "Kyle",
    });
    storage.setItem(
      NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY,
      JSON.stringify({
        accessToken,
        refreshToken: "refresh-token",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        claims: {
          sub: "anaconda-user-789",
          email: "kyle@example.com",
          email_verified: true,
          name: "Kyle",
        },
      }),
    );

    storeCloudRequestedScope(storage, "editor");
    assert.equal(readCloudPrototypeAuth(storage).requestedScope, "editor");

    storeCloudRequestedScope(storage, NOTEBOOK_CLOUD_DEFAULT_SCOPE);
    const state = readCloudPrototypeAuth(storage);
    assert.equal(state.mode, "oidc");
    assert.equal(state.requestedScope, NOTEBOOK_CLOUD_DEFAULT_SCOPE);
    assert.equal(state.token, accessToken);
    assert.equal(storage.getItem(NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY), null);
  });

  it("starts OIDC sign-in as a viewer without stale prototype identity", () => {
    const storage = new MemoryStorage();
    storage.setItem(NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY, "secret");
    storage.setItem(NOTEBOOK_CLOUD_USER_STORAGE_KEY, "browser-editor");
    storage.setItem(NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY, "editor");
    storage.setItem(NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY, "stale");

    prepareCloudOidcViewerLogin(storage);

    assert.equal(storage.getItem(NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY), null);
    assert.equal(storage.getItem(NOTEBOOK_CLOUD_USER_STORAGE_KEY), null);
    assert.equal(storage.getItem(NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY), NOTEBOOK_CLOUD_DEFAULT_SCOPE);
    assert.equal(storage.getItem(NOTEBOOK_CLOUD_OIDC_TOKEN_STORAGE_KEY), null);
  });

  it("preserves every explicit connection scope supported by the protocol", () => {
    for (const scope of ["viewer", "editor", "runtime_peer", "owner"] as const) {
      const storage = new MemoryStorage();
      storeCloudPrototypeDevAuth(storage, {
        token: "secret",
        user: "alice",
        scope,
      });

      assert.equal(readCloudPrototypeAuth(storage).requestedScope, scope);
    }
  });

  it("falls back to anonymous auth for placeholder tokens", () => {
    const storage = new MemoryStorage();
    storeCloudPrototypeDevAuth(storage, {
      token: "<NOTEBOOK_CLOUD_DEV_TOKEN>",
      user: "alice",
      scope: "editor",
    });

    const state = readCloudPrototypeAuth(storage);

    assert.equal(state.mode, "invalid");
    assert.match(prototypeAuthSummary(state), /placeholder/);
    assert.deepEqual(cloudSyncAuthFromPrototypeAuthState(state), {
      headers: {},
      protocols: [],
      user: null,
      operator: null,
      requestedScope: null,
    });
  });

  it("clears all prototype collaborator keys", () => {
    const storage = new MemoryStorage();
    storage.setItem(NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY, "secret");
    storage.setItem(NOTEBOOK_CLOUD_USER_STORAGE_KEY, "alice");
    storage.setItem(NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY, "editor");

    clearCloudPrototypeDevAuth(storage);

    assert.equal(storage.getItem(NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY), null);
    assert.equal(storage.getItem(NOTEBOOK_CLOUD_USER_STORAGE_KEY), null);
    assert.equal(storage.getItem(NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY), null);
  });

  it("recognizes common placeholder token shapes", () => {
    assert.match(validatePrototypeToken("<NOTEBOOK_CLOUD_DEV_TOKEN>") ?? "", /placeholder/);
    assert.match(validatePrototypeToken("NOTEBOOK_CLOUD_DEV_TOKEN") ?? "", /placeholder/);
    assert.match(validatePrototypeToken("<paste token here>") ?? "", /placeholder/);
    assert.equal(validatePrototypeToken("real-token"), null);
  });

  it("builds safe diagnostics without exposing token material", () => {
    const storage = new MemoryStorage();
    storeCloudPrototypeDevAuth(storage, {
      token: "secret-token",
      user: "alice@example.com",
      scope: "editor",
    });

    const diagnostics = prototypeAuthDiagnostics(readCloudPrototypeAuth(storage), {
      actorLabel: "user:dev:alice%40example.com/desktop:browser",
      connectionError: null,
      connectionScope: "editor",
    });

    assert.match(diagnostics.copyText, /Requested principal: user:dev:alice%40example\.com/);
    assert.match(diagnostics.copyText, /Connected scope: editor/);
    assert.match(diagnostics.copyText, /Room actor: user:dev:alice%40example\.com/);
    assert.doesNotMatch(diagnostics.copyText, /secret-token/);
  });

  it("diagnoses invalid stored credentials as anonymous fallback", () => {
    const storage = new MemoryStorage();
    storeCloudPrototypeDevAuth(storage, {
      token: "<NOTEBOOK_CLOUD_DEV_TOKEN>",
      user: "alice",
      scope: "owner",
    });

    const diagnostics = prototypeAuthDiagnostics(readCloudPrototypeAuth(storage), {
      actorLabel: null,
      connectionError: "failed to connect",
      connectionScope: null,
    });

    assert.match(diagnostics.copyText, /Effective auth: Anonymous viewer/);
    assert.match(diagnostics.copyText, /Connected scope: Offline/);
    assert.match(diagnostics.copyText, /Last connection error: failed to connect/);
    assert.doesNotMatch(diagnostics.copyText, /<NOTEBOOK_CLOUD_DEV_TOKEN>/);
  });
});

class MemoryStorage implements CloudPrototypeAuthStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function jwt(payload: Record<string, unknown>): string {
  return `${base64UrlJson({ alg: "none" })}.${base64UrlJson(payload)}.signature`;
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
