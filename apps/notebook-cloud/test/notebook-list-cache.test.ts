import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY,
  CLOUD_NOTEBOOK_LIST_CACHE_TTL_MS,
  clearCachedCloudNotebookList,
  readCachedCloudNotebookList,
  writeCachedCloudNotebookList,
} from "../viewer/notebook-list-cache";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth";
import type { CloudNotebookListItem } from "../viewer/notebook-dashboard";

describe("cloud notebook list cache", () => {
  it("round-trips notebooks for the same browser identity", () => {
    const storage = new MemoryStorage();
    const auth = oidcAuth("user-a");
    const notebooks = [notebook("nb-a")];

    writeCachedCloudNotebookList(storage, auth, null, notebooks, 1_000);

    assert.deepEqual(readCachedCloudNotebookList(storage, auth, null, 2_000), notebooks);
  });

  it("does not reuse cached catalog rows for another identity", () => {
    const storage = new MemoryStorage();
    writeCachedCloudNotebookList(storage, oidcAuth("user-a"), null, [notebook("nb-a")], 1_000);

    assert.equal(readCachedCloudNotebookList(storage, oidcAuth("user-b"), null, 2_000), null);
  });

  it("prefers the app session cache key over local OIDC claims", () => {
    const storage = new MemoryStorage();
    const notebooks = [notebook("nb-a")];

    writeCachedCloudNotebookList(
      storage,
      oidcAuth("user-a"),
      appSession("session-a"),
      notebooks,
      1_000,
    );

    assert.deepEqual(
      readCachedCloudNotebookList(storage, oidcAuth("user-b"), appSession("session-a"), 2_000),
      notebooks,
    );
    assert.equal(
      readCachedCloudNotebookList(storage, oidcAuth("user-a"), appSession("session-b"), 2_000),
      null,
    );
  });

  it("expires retained catalog rows", () => {
    const storage = new MemoryStorage();
    const auth = oidcAuth("user-a");
    writeCachedCloudNotebookList(storage, auth, null, [notebook("nb-a")], 1_000);

    assert.equal(
      readCachedCloudNotebookList(
        storage,
        auth,
        null,
        1_000 + CLOUD_NOTEBOOK_LIST_CACHE_TTL_MS + 1,
      ),
      null,
    );
  });

  it("rejects malformed cached rows", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY,
      JSON.stringify({
        authKey: "oidc:user-a",
        savedAt: 1_000,
        notebooks: [{ notebook_id: "nb-a" }],
      }),
    );

    assert.equal(readCachedCloudNotebookList(storage, oidcAuth("user-a"), null, 2_000), null);
  });

  it("clears retained catalog rows", () => {
    const storage = new MemoryStorage();
    const auth = oidcAuth("user-a");
    writeCachedCloudNotebookList(storage, auth, null, [notebook("nb-a")], 1_000);

    clearCachedCloudNotebookList(storage);

    assert.equal(readCachedCloudNotebookList(storage, auth, null, 2_000), null);
  });
});

function oidcAuth(subject: string): CloudPrototypeAuthState {
  return {
    mode: "oidc",
    token: "token",
    user: subject,
    oidcClaims: {
      sub: subject,
    },
    requestedScope: "viewer",
    problem: null,
  };
}

function notebook(id: string): CloudNotebookListItem {
  return {
    notebook_id: id,
    title: null,
    owner_principal: "user:dev:alice",
    scope: "owner",
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    latest_revision_id: null,
    viewer_url: `/n/${id}/notebook`,
    endpoints: {
      catalog: `/api/n/${id}`,
      acl: `/api/n/${id}/acl`,
      access_requests: `/api/n/${id}/access-requests`,
    },
  };
}

function appSession(cacheKey: string) {
  return {
    provider: "oidc" as const,
    expires_at: 1_750_000_000,
    cache_key: cacheKey,
  };
}

class MemoryStorage {
  private values = new Map<string, string>();

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
