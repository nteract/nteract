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
import type { CloudAppSession } from "../viewer/app-session";
import type { CloudNotebookListItem } from "../viewer/notebook-dashboard";

describe("cloud notebook list cache", () => {
  it("round-trips notebooks for the same browser identity", () => {
    const storage = new MemoryStorage();
    const auth = oidcAuth("user-a");
    const notebooks = [notebook("nb-a")];

    writeCachedCloudNotebookList(storage, auth, null, notebooks, 1_000);

    assert.deepEqual(readCachedCloudNotebookList(storage, auth, null, 2_000), notebooks);
  });

  it("round-trips notebooks for a cookie app-session cache identity", () => {
    const storage = new MemoryStorage();
    const auth = anonymousAuth();
    const appSession = session("session-a");
    const notebooks = [notebook("nb-a")];

    writeCachedCloudNotebookList(storage, auth, appSession, notebooks, 1_000);

    assert.deepEqual(readCachedCloudNotebookList(storage, auth, appSession, 2_000), notebooks);
    assert.doesNotMatch(
      storage.getItem(CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY) ?? "",
      /user-a|subject|example|anaconda/,
    );
  });

  it("does not reuse cached catalog rows for another identity", () => {
    const storage = new MemoryStorage();
    writeCachedCloudNotebookList(storage, oidcAuth("user-a"), null, [notebook("nb-a")], 1_000);

    assert.equal(readCachedCloudNotebookList(storage, oidcAuth("user-b"), null, 2_000), null);
  });

  it("does not reuse cached catalog rows for another app session", () => {
    const storage = new MemoryStorage();
    const auth = anonymousAuth();
    writeCachedCloudNotebookList(storage, auth, session("session-a"), [notebook("nb-a")], 1_000);

    assert.equal(readCachedCloudNotebookList(storage, auth, session("session-b"), 2_000), null);
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

function anonymousAuth(): CloudPrototypeAuthState {
  return {
    mode: "anonymous",
    token: null,
    user: null,
    oidcClaims: null,
    requestedScope: "viewer",
    problem: null,
  };
}

function session(cacheKey: string): CloudAppSession {
  return {
    provider: "oidc",
    expires_at: 4_102_444_800,
    cache_key: cacheKey,
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
