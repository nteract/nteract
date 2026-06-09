import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cloudNotebookDisplayTitle,
  cloudNotebookShortId,
  projectCloudNotebookDashboard,
  projectCloudNotebookDashboardView,
  type CloudNotebookListItem,
} from "../viewer/notebook-dashboard";

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
    assert.deepEqual(model.continueRow, {
      contextLabel: null,
      facts: [],
      notebook: newOwner,
    });
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
    assert.deepEqual(
      model.filters.map((filter) => [filter.id, filter.label, filter.count]),
      [
        ["all", "Recent", 3],
        ["owned", "Owned", 1],
        ["shared", "Shared", 2],
        ["published", "Published", 2],
        ["untitled", "Untitled", 0],
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
    const untitledView = projectCloudNotebookDashboardView(model, { filterId: "untitled" });
    assert.deepEqual(
      untitledView.sections.map((section) => ({
        action:
          section.action?.kind === "rename"
            ? [section.action.kind, section.action.label, section.action.notebook.notebook_id]
            : null,
        id: section.id,
        title: section.title,
        notebooks: section.notebooks.map((item) => item.notebook_id),
      })),
      [
        {
          action: ["rename", "Title next", "01KTHB58DSJWERSEWHD3EJD74P"],
          id: "untitled",
          title: "Needs title",
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

    const view = projectCloudNotebookDashboardView(model, { filterId: "untitled" });

    assert.equal(view.sections[0]?.action, null);
  });

  it("projects search-first activity sections without mutating the dashboard model", () => {
    const topic = notebook({
      id: "topic-viz",
      title: "Topic Visualization",
      scope: "owner",
      updatedAt: "2026-06-07T15:00:00.000Z",
      latestRevisionId: "published-topic",
    });
    const renderer = notebook({
      id: "renderer-regression",
      title: "Renderer Regression",
      scope: "editor",
      updatedAt: "2026-06-05T12:00:00.000Z",
      latestRevisionId: null,
    });
    const archive = notebook({
      id: "archive",
      title: "Archived Notes",
      scope: "viewer",
      updatedAt: "2026-05-01T12:00:00.000Z",
      latestRevisionId: null,
    });

    const model = projectCloudNotebookDashboard([archive, renderer, topic]);
    const searchView = projectCloudNotebookDashboardView(model, { query: "render" });
    const sharedView = projectCloudNotebookDashboardView(model, { filterId: "shared" });
    const defaultView = projectCloudNotebookDashboardView(model);

    assert.equal(defaultView.showResultCount, false);
    assert.equal(searchView.showResultCount, true);
    assert.equal(sharedView.showResultCount, true);
    assert.deepEqual(
      searchView.sections.flatMap((section) => section.notebooks.map((item) => item.notebook_id)),
      ["renderer-regression"],
    );
    assert.deepEqual(
      sharedView.sections.map((section) => [section.id, section.title, section.notebooks.length]),
      [
        ["latest", "Latest activity", 1],
        ["earlier", "Earlier", 1],
      ],
    );
    assert.deepEqual(
      sharedView.sections.flatMap((section) =>
        section.rows.map((row) => [
          row.notebook.notebook_id,
          row.contextLabel,
          row.facts.map((fact) => [fact.kind, fact.label]),
        ]),
      ),
      [
        ["renderer-regression", "Shared edit access", [["access", "editor"]]],
        ["archive", "Shared view access", [["access", "viewer"]]],
      ],
    );
  });

  it("keeps generated runs and untitled notebooks below recognizable work by default", () => {
    const generated = notebook({
      id: "toolbar-smoke",
      title: "Toolbar attach smoke 2026-06-08T19:26:35.312Z",
      scope: "owner",
      updatedAt: "2026-06-08T19:26:35.312Z",
      latestRevisionId: null,
    });
    const untitled = notebook({
      id: "untitled-new",
      title: null,
      scope: "owner",
      updatedAt: "2026-06-08T18:00:00.000Z",
      latestRevisionId: null,
    });
    const realWork = notebook({
      id: "topic-viz",
      title: "Topic Visualization",
      scope: "owner",
      updatedAt: "2026-06-01T12:00:00.000Z",
      latestRevisionId: "published-topic",
    });

    const model = projectCloudNotebookDashboard([generated, untitled, realWork]);
    const view = projectCloudNotebookDashboardView(model);

    assert.equal(model.continueNotebook?.notebook_id, "topic-viz");
    assert.deepEqual(
      view.sections.map((section) => [
        section.id,
        section.title,
        section.notebooks.map((item) => item.notebook_id),
      ]),
      [
        ["named", "Recent work", ["topic-viz"]],
        ["generated", "Generated runs", ["toolbar-smoke"]],
        ["untitled", "Needs title", ["untitled-new"]],
      ],
    );
    assert.deepEqual(
      view.sections.flatMap((section) =>
        section.rows.map((row) => [
          row.notebook.notebook_id,
          row.contextLabel,
          row.facts.map((fact) => [fact.kind, fact.label]),
        ]),
      ),
      [
        ["topic-viz", null, [["published", "Published"]]],
        ["toolbar-smoke", "Generated run", []],
        ["untitled-new", "Needs title", []],
      ],
    );
  });

  it("limits cleanup-heavy sections and exposes drill-in filters", () => {
    const generated = Array.from({ length: 7 }, (_, index) =>
      notebook({
        id: `generated-${index}`,
        title: `Toolbar attach smoke 2026-06-08T19:2${index}:35.312Z`,
        scope: "owner",
        updatedAt: `2026-06-08T19:2${index}:35.312Z`,
        latestRevisionId: null,
      }),
    );
    const untitled = Array.from({ length: 6 }, (_, index) =>
      notebook({
        id: `untitled-${index}`,
        title: null,
        scope: "owner",
        updatedAt: `2026-06-08T18:0${index}:00.000Z`,
        latestRevisionId: null,
      }),
    );

    const model = projectCloudNotebookDashboard([...generated, ...untitled]);
    const defaultView = projectCloudNotebookDashboardView(model);
    const generatedSection = defaultView.sections.find((section) => section.id === "generated");
    const untitledSection = defaultView.sections.find((section) => section.id === "untitled");

    assert.deepEqual(
      model.filters.map((filter) => [filter.id, filter.count]),
      [
        ["all", 13],
        ["owned", 13],
        ["shared", 0],
        ["published", 0],
        ["generated", 7],
        ["untitled", 6],
      ],
    );
    assert.equal(generatedSection?.notebooks.length, 5);
    assert.equal(generatedSection?.totalCount, 7);
    assert.deepEqual(generatedSection?.overflowAction, {
      filterId: "generated",
      kind: "filter",
      label: "Review generated",
    });
    assert.equal(untitledSection?.notebooks.length, 5);
    assert.equal(untitledSection?.totalCount, 6);
    assert.deepEqual(untitledSection?.overflowAction, {
      filterId: "untitled",
      kind: "filter",
      label: "Review untitled",
    });

    const generatedView = projectCloudNotebookDashboardView(model, { filterId: "generated" });
    assert.equal(generatedView.resultCount, 7);
    assert.equal(generatedView.sections[0]?.notebooks.length, 7);
    assert.equal(generatedView.sections[0]?.overflowAction, null);
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
