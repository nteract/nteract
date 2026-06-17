import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLOUD_MARKDOWN_DOCUMENT_LIST_CACHE_STORAGE_KEY,
  CLOUD_MARKDOWN_DOCUMENT_LIST_CACHE_TTL_MS,
  clearCachedCloudMarkdownDocumentList,
  readCachedCloudMarkdownDocumentList,
  writeCachedCloudMarkdownDocumentList,
} from "../viewer/markdown-document-list-cache";
import type { CloudPrototypeAuthState } from "../viewer/collaborator-auth";
import type { CloudAppSession } from "../viewer/app-session";
import type { CloudMarkdownDocumentListItem } from "../viewer/markdown-document-dashboard";

describe("cloud Markdown document list cache", () => {
  it("round-trips Markdown documents for the same browser identity", () => {
    const storage = new MemoryStorage();
    const auth = oidcAuth("user-a");
    const documents = [document("doc-a")];

    writeCachedCloudMarkdownDocumentList(storage, auth, null, documents, 1_000);

    assert.deepEqual(readCachedCloudMarkdownDocumentList(storage, auth, null, 2_000), documents);
  });

  it("round-trips Markdown documents for a cookie app-session cache identity", () => {
    const storage = new MemoryStorage();
    const auth = anonymousAuth();
    const appSession = session("session-a");
    const documents = [document("doc-a")];

    writeCachedCloudMarkdownDocumentList(storage, auth, appSession, documents, 1_000);

    assert.deepEqual(
      readCachedCloudMarkdownDocumentList(storage, auth, appSession, 2_000),
      documents,
    );
    assert.doesNotMatch(
      storage.getItem(CLOUD_MARKDOWN_DOCUMENT_LIST_CACHE_STORAGE_KEY) ?? "",
      /user-a|subject|example|anaconda/,
    );
  });

  it("does not reuse cached Markdown documents for another identity", () => {
    const storage = new MemoryStorage();
    writeCachedCloudMarkdownDocumentList(
      storage,
      oidcAuth("user-a"),
      null,
      [document("doc-a")],
      1_000,
    );

    assert.equal(
      readCachedCloudMarkdownDocumentList(storage, oidcAuth("user-b"), null, 2_000),
      null,
    );
  });

  it("does not reuse cached Markdown documents for another app session", () => {
    const storage = new MemoryStorage();
    const auth = anonymousAuth();
    writeCachedCloudMarkdownDocumentList(
      storage,
      auth,
      session("session-a"),
      [document("doc-a")],
      1_000,
    );

    assert.equal(
      readCachedCloudMarkdownDocumentList(storage, auth, session("session-b"), 2_000),
      null,
    );
  });

  it("expires retained Markdown catalog rows", () => {
    const storage = new MemoryStorage();
    const auth = oidcAuth("user-a");
    writeCachedCloudMarkdownDocumentList(storage, auth, null, [document("doc-a")], 1_000);

    assert.equal(
      readCachedCloudMarkdownDocumentList(
        storage,
        auth,
        null,
        1_000 + CLOUD_MARKDOWN_DOCUMENT_LIST_CACHE_TTL_MS + 1,
      ),
      null,
    );
  });

  it("rejects malformed cached Markdown rows", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      CLOUD_MARKDOWN_DOCUMENT_LIST_CACHE_STORAGE_KEY,
      JSON.stringify({
        authKey: "oidc:user-a",
        savedAt: 1_000,
        documents: [{ document_id: "doc-a" }],
      }),
    );

    assert.equal(
      readCachedCloudMarkdownDocumentList(storage, oidcAuth("user-a"), null, 2_000),
      null,
    );
  });

  it("clears retained Markdown catalog rows", () => {
    const storage = new MemoryStorage();
    const auth = oidcAuth("user-a");
    writeCachedCloudMarkdownDocumentList(storage, auth, null, [document("doc-a")], 1_000);

    clearCachedCloudMarkdownDocumentList(storage);

    assert.equal(readCachedCloudMarkdownDocumentList(storage, auth, null, 2_000), null);
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

function document(id: string): CloudMarkdownDocumentListItem {
  return {
    document_id: id,
    title: null,
    owner_principal: "user:dev:alice",
    body_doc_id: `${id}-body`,
    scope: "owner",
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    latest_revision_id: null,
    viewer_url: `/m/${id}/document`,
    endpoints: {
      catalog: `/api/m/${id}`,
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
