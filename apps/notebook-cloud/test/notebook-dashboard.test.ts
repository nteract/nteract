import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cloudNotebookDisplayTitle,
  cloudNotebookShortId,
  projectCloudNotebookDashboard,
  type CloudNotebookListItem,
} from "../viewer/notebook-dashboard";

describe("cloud notebook dashboard projection", () => {
  it("sorts by recency and derives dashboard summary counts", () => {
    const oldViewer = notebook({
      id: "viewer-old",
      scope: "viewer",
      updatedAt: "2026-05-20T00:00:00.000Z",
      latestRevisionId: "published-old",
    });
    const newOwner = notebook({
      id: "owner-new",
      scope: "owner",
      updatedAt: "2026-06-07T15:00:00.000Z",
      latestRevisionId: null,
    });
    const editor = notebook({
      id: "editor-mid",
      scope: "editor",
      updatedAt: "2026-06-01T12:00:00.000Z",
      latestRevisionId: "published-mid",
    });

    const model = projectCloudNotebookDashboard([oldViewer, newOwner, editor]);

    assert.equal(model.continueNotebook?.notebook_id, "owner-new");
    assert.deepEqual(
      model.notebooks.map((item) => item.notebook_id),
      ["owner-new", "editor-mid", "viewer-old"],
    );
    assert.deepEqual(
      model.metrics.map((metric) => [metric.label, metric.value, metric.detail]),
      [
        ["Visible notebooks", "3", "2 editable"],
        ["Owned", "1", "can manage access"],
        ["Published", "2", "revision metadata"],
      ],
    );
  });

  it("keeps notebook identity navigable when titles are missing", () => {
    const untitled = notebook({
      id: "01KTHB58DSJWERSEWHD3EJD74P",
      title: "   ",
      scope: "owner",
      updatedAt: "2026-06-07T15:00:00.000Z",
      latestRevisionId: null,
    });

    assert.equal(cloudNotebookDisplayTitle(untitled), "Untitled notebook");
    assert.equal(cloudNotebookShortId(untitled.notebook_id), "01KTHB58...D74P");
  });
});

function notebook(input: {
  id: string;
  title?: string | null;
  scope: CloudNotebookListItem["scope"];
  updatedAt: string;
  latestRevisionId: string | null;
}): CloudNotebookListItem {
  return {
    notebook_id: input.id,
    title: input.title ?? null,
    owner_principal: "user:dev:alice",
    scope: input.scope,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: input.updatedAt,
    latest_revision_id: input.latestRevisionId,
    viewer_url: `/n/${input.id}/notebook`,
    endpoints: {
      catalog: `/api/n/${input.id}`,
      acl: `/api/n/${input.id}/acl`,
      access_requests: `/api/n/${input.id}/access-requests`,
    },
  };
}
