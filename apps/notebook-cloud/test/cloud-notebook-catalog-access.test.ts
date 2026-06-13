import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cloudNotebookAccessScopeForShell,
  cloudNotebookCatalogAccessFromList,
  cloudNotebookCatalogScopeFromList,
  cloudNotebookScopeCanEditDocument,
  cloudNotebookSyncScopeForCatalogAccess,
  createCloudNotebookCatalogAccessLoader,
} from "../viewer/cloud-notebook-catalog-access";
import type { CloudNotebookListItem } from "../viewer/notebook-dashboard";

describe("cloud notebook catalog access projection", () => {
  it("projects the current notebook scope from the authenticated list", () => {
    assert.equal(
      cloudNotebookCatalogScopeFromList(
        [notebook({ id: "other", scope: "viewer" }), notebook({ id: "owned", scope: "owner" })],
        "owned",
      ),
      "owner",
    );
  });

  it("ignores runtime-peer catalog rows for browser access chrome", () => {
    assert.equal(
      cloudNotebookCatalogScopeFromList([notebook({ id: "room", scope: "runtime_peer" })], "room"),
      null,
    );
  });

  it("projects resolved catalog access from the authenticated notebook list", () => {
    assert.deepEqual(
      cloudNotebookCatalogAccessFromList(
        [notebook({ id: "room", scope: "editor" }), notebook({ id: "other", scope: "owner" })],
        "room",
      ),
      {
        catalogResolved: true,
        catalogScope: "editor",
      },
    );
  });

  it("coalesces concurrent catalog access loads for one notebook open", async () => {
    let loadCount = 0;
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const loader = createCloudNotebookCatalogAccessLoader({
      notebookId: "room",
      loadNotebooks: async () => {
        loadCount += 1;
        await loadGate;
        return [notebook({ id: "room", scope: "owner" })];
      },
    });

    const first = loader.load();
    const second = loader.load();
    assert.equal(loadCount, 1);
    releaseLoad();

    assert.deepEqual(await Promise.all([first, second]), [
      { catalogResolved: true, catalogScope: "owner" },
      { catalogResolved: true, catalogScope: "owner" },
    ]);
    assert.equal(loadCount, 1);
  });

  it("retries catalog access loads after a failed request", async () => {
    let loadCount = 0;
    const loader = createCloudNotebookCatalogAccessLoader({
      notebookId: "room",
      loadNotebooks: async () => {
        loadCount += 1;
        if (loadCount === 1) {
          throw new Error("temporary catalog failure");
        }
        return [notebook({ id: "room", scope: "viewer" })];
      },
    });

    await assert.rejects(loader.load(), /temporary catalog failure/);
    assert.deepEqual(await loader.load(), { catalogResolved: true, catalogScope: "viewer" });
    assert.equal(loadCount, 2);
  });

  it("uses catalog scope only while the live room scope is not ready", () => {
    assert.equal(
      cloudNotebookAccessScopeForShell({
        catalogScope: "owner",
        connectionReady: false,
        connectionScope: "viewer",
      }),
      "owner",
    );
    assert.equal(
      cloudNotebookAccessScopeForShell({
        catalogScope: "owner",
        connectionReady: true,
        connectionScope: "viewer",
      }),
      "viewer",
    );
  });

  it("classifies editor and owner as document-edit scopes", () => {
    assert.equal(cloudNotebookScopeCanEditDocument("owner"), true);
    assert.equal(cloudNotebookScopeCanEditDocument("editor"), true);
    assert.equal(cloudNotebookScopeCanEditDocument("viewer"), false);
    assert.equal(cloudNotebookScopeCanEditDocument("runtime_peer"), false);
    assert.equal(cloudNotebookScopeCanEditDocument(null), false);
  });

  it("requests the catalog scope for app-session room sync when available", () => {
    assert.equal(
      cloudNotebookSyncScopeForCatalogAccess({
        catalogResolved: true,
        catalogScope: "editor",
        selectedMode: "view",
      }),
      "editor",
    );
  });

  it("does not escalate edit-mode URLs when the authenticated catalog excludes the notebook", () => {
    assert.equal(
      cloudNotebookSyncScopeForCatalogAccess({
        catalogResolved: true,
        catalogScope: null,
        selectedMode: "edit",
      }),
      "viewer",
    );
  });

  it("keeps the existing edit-mode fallback when the catalog could not be resolved", () => {
    assert.equal(
      cloudNotebookSyncScopeForCatalogAccess({
        catalogResolved: false,
        catalogScope: null,
        selectedMode: "edit",
      }),
      "owner",
    );
  });
});

function notebook({
  id,
  scope,
}: {
  id: string;
  scope: CloudNotebookListItem["scope"];
}): CloudNotebookListItem {
  return {
    notebook_id: id,
    title: "Notebook",
    owner_principal: "user:dev:owner",
    scope,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    latest_revision_id: null,
    viewer_url: `/n/${id}/Notebook`,
    endpoints: {
      catalog: `/api/n/${id}`,
      acl: `/api/n/${id}/acl`,
      access_requests: `/api/n/${id}/access-requests`,
    },
  };
}
