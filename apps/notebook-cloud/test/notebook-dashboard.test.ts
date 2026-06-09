import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cloudNotebookDisplayTitle,
  cloudNotebookShortId,
  projectCloudNotebookDashboard,
  type CloudNotebookListItem,
} from "@/components/notebook/workspace/notebook-dashboard";

describe("cloud notebook dashboard projection", () => {
  it("sorts by recency and derives dashboard summary counts", () => {
    const oldViewer = notebook({
      id: "viewer-old",
      title: "Viewer Old",
      scope: "viewer",
      updatedAt: "2026-05-20T00:00:00.000Z",
      latestRevisionId: "published-old",
    });
    const newOwner = notebook({
      id: "owner-new",
      title: "Owner New",
      scope: "owner",
      updatedAt: "2026-06-07T15:00:00.000Z",
      latestRevisionId: null,
    });
    const editor = notebook({
      id: "editor-mid",
      title: "Editor Mid",
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
        ["Visible notebooks", "3", "3 titled, 2 editable"],
        ["Owned", "1", "can manage access"],
        ["Published", "2", "revision metadata"],
      ],
    );
  });

  it("keeps titled notebooks prominent while grouping untitled rooms", () => {
    const recentUntitled = notebook({
      id: "01KTHB58DSJWERSEWHD3EJD74P",
      title: null,
      scope: "owner",
      updatedAt: "2026-06-07T15:00:00.000Z",
      latestRevisionId: null,
    });
    const titled = notebook({
      id: "topic-viz",
      title: "Topic Visualization",
      scope: "owner",
      updatedAt: "2026-06-01T12:00:00.000Z",
      latestRevisionId: "published-topic",
    });
    const olderUntitled = notebook({
      id: "01KSQKEPFJVHV4T4ZDYS9V7T80",
      title: "   ",
      scope: "editor",
      updatedAt: "2026-05-20T00:00:00.000Z",
      latestRevisionId: null,
    });

    const model = projectCloudNotebookDashboard([recentUntitled, titled, olderUntitled]);

    assert.equal(model.continueNotebook?.notebook_id, "topic-viz");
    assert.deepEqual(
      model.notebooks.map((item) => item.notebook_id),
      ["01KTHB58DSJWERSEWHD3EJD74P", "topic-viz", "01KSQKEPFJVHV4T4ZDYS9V7T80"],
    );
    assert.deepEqual(
      model.sections.map((section) => ({
        action: section.action
          ? [section.action.kind, section.action.label, section.action.notebook.notebook_id]
          : null,
        id: section.id,
        title: section.title,
        notebooks: section.notebooks.map((item) => item.notebook_id),
      })),
      [
        {
          action: null,
          id: "titled",
          title: "Named notebooks",
          notebooks: ["topic-viz"],
        },
        {
          action: ["rename", "Title next", "01KTHB58DSJWERSEWHD3EJD74P"],
          id: "untitled",
          title: "Untitled notebooks",
          notebooks: ["01KTHB58DSJWERSEWHD3EJD74P", "01KSQKEPFJVHV4T4ZDYS9V7T80"],
        },
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

  it("does not recommend renaming read-only untitled notebooks", () => {
    const viewer = notebook({
      id: "viewer-untitled",
      title: null,
      scope: "viewer",
      updatedAt: "2026-06-07T15:00:00.000Z",
      latestRevisionId: null,
    });

    const model = projectCloudNotebookDashboard([viewer]);

    assert.equal(model.sections[0]?.action, null);
  });

  it("projects published previews and an access-role breakdown for the sidebar", () => {
    const ownerPublished = notebook({
      id: "owner-pub",
      title: "Owner Published",
      scope: "owner",
      updatedAt: "2026-06-07T15:00:00.000Z",
      latestRevisionId: "rev-1",
    });
    const editorDraft = notebook({
      id: "editor-draft",
      title: "Editor Draft",
      scope: "editor",
      updatedAt: "2026-06-05T12:00:00.000Z",
      latestRevisionId: null,
    });
    const viewerPublished = notebook({
      id: "viewer-pub",
      title: "Viewer Published",
      scope: "viewer",
      updatedAt: "2026-06-06T12:00:00.000Z",
      latestRevisionId: "rev-2",
    });

    const model = projectCloudNotebookDashboard([editorDraft, viewerPublished, ownerPublished]);

    assert.deepEqual(
      model.sidebar.published.map((item) => item.notebook_id),
      ["owner-pub", "viewer-pub"],
    );
    assert.deepEqual(model.sidebar.access, { owned: 1, editable: 1, viewOnly: 1 });
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
