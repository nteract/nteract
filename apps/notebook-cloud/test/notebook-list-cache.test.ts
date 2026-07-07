import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY,
  clearCachedCloudNotebookList,
  readCachedCloudNotebookList,
  writeCachedCloudNotebookList,
} from "../viewer/notebook-list-cache";
import type { CloudAppSession } from "../viewer/app-session";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth";
import type { CloudNotebookListItem } from "../viewer/notebook-dashboard";

describe("cloud notebook list cache", () => {
  it("seeds notebooks and total count for a matching OIDC principal", () => {
    const storage = new MemoryStorage();
    const auth = oidcAuth("alice@example.test");
    const notebooks = [notebook("nb-a")];

    writeCachedCloudNotebookList(storage, auth, null, notebooks, {
      now: 1_000,
      principal: "user:anaconda:alice%40example.test",
      totalCount: 342,
    });

    assert.deepEqual(readCachedCloudNotebookList(storage, auth, null), {
      notebooks,
      totalCount: 342,
    });
  });

  it("refuses cached rows from a mismatched principal", () => {
    const storage = new MemoryStorage();
    writeCachedCloudNotebookList(
      storage,
      oidcAuth("alice@example.test"),
      null,
      [notebook("nb-a")],
      {
        now: 1_000,
        principal: "user:anaconda:alice%40example.test",
      },
    );

    assert.equal(readCachedCloudNotebookList(storage, oidcAuth("bob@example.test"), null), null);
  });

  it("lets an expired OIDC token seed only when an app session backs the subject", () => {
    const storage = new MemoryStorage();
    const auth = oidcExpiredAuth("alice@example.test");
    const notebooks = [notebook("nb-a")];

    writeCachedCloudNotebookList(storage, auth, appSession(), notebooks, {
      now: 1_000,
      principal: "user:anaconda:alice%40example.test",
    });

    assert.deepEqual(readCachedCloudNotebookList(storage, auth, appSession()), {
      notebooks,
      totalCount: notebooks.length,
    });
    assert.equal(readCachedCloudNotebookList(storage, auth, null), null);
  });

  it("clears retained rows on sign-out", () => {
    const storage = new MemoryStorage();
    const auth = oidcAuth("alice@example.test");
    writeCachedCloudNotebookList(storage, auth, null, [notebook("nb-a")], {
      now: 1_000,
      principal: "user:anaconda:alice%40example.test",
    });

    clearCachedCloudNotebookList(storage);

    assert.equal(readCachedCloudNotebookList(storage, auth, null), null);
    assert.equal(storage.getItem(CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY), null);
  });

  it("drops malformed JSON without throwing", () => {
    const storage = new MemoryStorage();
    storage.setItem(CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY, "{");

    assert.equal(readCachedCloudNotebookList(storage, oidcAuth("alice@example.test"), null), null);
    assert.equal(storage.getItem(CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY), null);
  });

  it("rejects malformed cached rows", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY,
      JSON.stringify({
        entries: [
          {
            notebooks: [{ notebook_id: "nb-a" }],
            principal: "user:anaconda:alice%40example.test",
            savedAt: 1_000,
          },
        ],
        v: 2,
      }),
    );

    assert.equal(readCachedCloudNotebookList(storage, oidcAuth("alice@example.test"), null), null);
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

function oidcExpiredAuth(subject: string): CloudPrototypeAuthState {
  return {
    ...oidcAuth(subject),
    mode: "oidc_expired",
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

function appSession(): CloudAppSession {
  return {
    provider: "oidc",
    expires_at: 1_750_000_000,
    cache_key: "cache-a",
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
