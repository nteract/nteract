import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NOTEBOOK_CLOUD_DEV_TOKEN_STORAGE_KEY,
  NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY,
  NOTEBOOK_CLOUD_USER_STORAGE_KEY,
  clearCloudPrototypeDevAuth,
  cloudSyncAuthFromPrototypeAuthState,
  prototypeAuthSummary,
  readCloudPrototypeAuth,
  storeCloudPrototypeDevAuth,
  validatePrototypeToken,
  type CloudPrototypeAuthStorage,
} from "../viewer/collaborator-auth.ts";

describe("cloud collaborator auth", () => {
  it("uses anonymous viewer auth when no prototype token is stored", () => {
    const state = readCloudPrototypeAuth(new MemoryStorage());

    assert.equal(state.mode, "anonymous");
    assert.deepEqual(cloudSyncAuthFromPrototypeAuthState(state), {
      protocols: [],
      user: null,
      operator: null,
      requestedScope: null,
    });
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
    assert.deepEqual(auth.protocols, ["nteract-dev-token.c2VjcmV0"]);
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
