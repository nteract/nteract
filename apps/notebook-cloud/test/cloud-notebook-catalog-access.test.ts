import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cloudNotebookAccessScopeForShell,
  cloudNotebookCatalogScopeFromList,
  cloudNotebookScopeCanEditDocument,
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
