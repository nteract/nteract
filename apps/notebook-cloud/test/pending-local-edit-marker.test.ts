import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NotebookDocPersistenceMeta } from "runtimed";
import {
  CLOUD_PENDING_LOCAL_EDIT_MARKER_STORAGE_KEY,
  clearPendingLocalEditMarker,
  readPendingLocalEditMarker,
  writePendingLocalEditMarker,
} from "../viewer/pending-local-edit-marker";

describe("pending local edit marker", () => {
  it("restores a marker for the same notebook, principal, and persisted heads", () => {
    const storage = new MemoryStorage();

    writePendingLocalEditMarker(storage, {
      headsHex: ["head-a"],
      notebookId: "nb-1",
      now: 1_000,
      principal: "user:oidc:alice",
    });

    assert.equal(
      readPendingLocalEditMarker(storage, {
        notebookId: "nb-1",
        principal: "user:oidc:alice",
        seedMeta: meta({ headsHex: ["head-a"], principal: "user:oidc:alice" }),
      }),
      true,
    );
  });

  it("refuses markers from another principal or notebook", () => {
    const storage = new MemoryStorage();

    writePendingLocalEditMarker(storage, {
      headsHex: ["head-a"],
      notebookId: "nb-1",
      principal: "user:oidc:alice",
    });

    assert.equal(
      readPendingLocalEditMarker(storage, {
        notebookId: "nb-1",
        principal: "user:oidc:bob",
        seedMeta: meta({ headsHex: ["head-a"], principal: "user:oidc:bob" }),
      }),
      false,
    );
    assert.equal(
      readPendingLocalEditMarker(storage, {
        notebookId: "nb-2",
        principal: "user:oidc:alice",
        seedMeta: meta({ headsHex: ["head-a"], principal: "user:oidc:alice" }),
      }),
      false,
    );
  });

  it("clears a marker that no longer matches the restored persistence record", () => {
    const storage = new MemoryStorage();

    writePendingLocalEditMarker(storage, {
      headsHex: ["pending-head"],
      notebookId: "nb-1",
      principal: "user:oidc:alice",
    });

    assert.equal(
      readPendingLocalEditMarker(storage, {
        notebookId: "nb-1",
        principal: "user:oidc:alice",
        seedMeta: meta({ headsHex: ["different-head"], principal: "user:oidc:alice" }),
      }),
      false,
    );
    assert.equal(storage.getItem(CLOUD_PENDING_LOCAL_EDIT_MARKER_STORAGE_KEY), null);
  });

  it("drops malformed JSON without throwing", () => {
    const storage = new MemoryStorage();
    storage.setItem(CLOUD_PENDING_LOCAL_EDIT_MARKER_STORAGE_KEY, "{");

    assert.equal(
      readPendingLocalEditMarker(storage, {
        notebookId: "nb-1",
        principal: "user:oidc:alice",
        seedMeta: meta({ headsHex: ["head-a"], principal: "user:oidc:alice" }),
      }),
      false,
    );
    assert.equal(storage.getItem(CLOUD_PENDING_LOCAL_EDIT_MARKER_STORAGE_KEY), null);
  });

  it("rejects malformed marker rows", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      CLOUD_PENDING_LOCAL_EDIT_MARKER_STORAGE_KEY,
      JSON.stringify({
        entries: [{ notebookId: "nb-1", principal: "user:oidc:alice", savedAt: 1_000 }],
        v: 1,
      }),
    );

    assert.equal(
      readPendingLocalEditMarker(storage, {
        notebookId: "nb-1",
        principal: "user:oidc:alice",
        seedMeta: meta({ headsHex: ["head-a"], principal: "user:oidc:alice" }),
      }),
      false,
    );
  });

  it("clears only the matching notebook and principal entry", () => {
    const storage = new MemoryStorage();

    writePendingLocalEditMarker(storage, {
      headsHex: ["head-a"],
      notebookId: "nb-1",
      principal: "user:oidc:alice",
    });
    writePendingLocalEditMarker(storage, {
      headsHex: ["head-b"],
      notebookId: "nb-2",
      principal: "user:oidc:alice",
    });

    clearPendingLocalEditMarker(storage, {
      notebookId: "nb-1",
      principal: "user:oidc:alice",
    });

    assert.equal(
      readPendingLocalEditMarker(storage, {
        notebookId: "nb-1",
        principal: "user:oidc:alice",
        seedMeta: meta({ headsHex: ["head-a"], principal: "user:oidc:alice" }),
      }),
      false,
    );
    assert.equal(
      readPendingLocalEditMarker(storage, {
        notebookId: "nb-2",
        principal: "user:oidc:alice",
        seedMeta: meta({ headsHex: ["head-b"], principal: "user:oidc:alice" }),
      }),
      true,
    );
  });
});

function meta(overrides: Partial<NotebookDocPersistenceMeta> = {}): NotebookDocPersistenceMeta {
  return {
    headsHex: overrides.headsHex ?? ["head-a"],
    principal: overrides.principal ?? "user:oidc:alice",
    savedAt: overrides.savedAt ?? 1_000,
    schemaVersion: 1,
    ...(overrides.generation !== undefined ? { generation: overrides.generation } : {}),
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
