import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cloudNotebookDashboardOpenUrl,
  cloudNotebookDisplayTitle,
  cloudNotebookOpenUrlWithMode,
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
      identityLabel: null,
      notebook: newOwner,
    });
    assert.deepEqual(
      model.notebooks.map((item) => item.notebook_id),
      ["owner-new", "editor-mid", "viewer-old"],
    );
    assert.deepEqual(
      model.filters.map((filter) => [filter.id, filter.label, filter.count, filter.group]),
      [
        ["all", "Recent", 3, "work"],
        ["owned", "Owned", 1, "work"],
        ["shared", "Shared with me", 2, "work"],
        ["published", "Published", 2, "work"],
      ],
    );
    assert.deepEqual(
      model.filterGroups.map((group) => ({
        filters: group.filters.map((filter) => filter.id),
        id: group.id,
        label: group.label,
      })),
      [
        {
          filters: ["all", "owned", "shared", "published"],
          id: "work",
          label: "Notebook views",
        },
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

  it("opens editable notebooks in edit mode while preserving viewer notebooks in view mode", () => {
    const owned = notebook({
      id: "owned-notebook",
      title: "Owned notebook",
      scope: "owner",
      updatedAt: "2026-06-07T15:00:00.000Z",
      latestRevisionId: null,
    });
    const editor = notebook({
      id: "editor-notebook",
      title: "Editor notebook",
      scope: "editor",
      updatedAt: "2026-06-07T15:00:00.000Z",
      latestRevisionId: null,
    });
    const viewer = notebook({
      id: "viewer-notebook",
      title: "Viewer notebook",
      scope: "viewer",
      updatedAt: "2026-06-07T15:00:00.000Z",
      latestRevisionId: null,
    });

    assert.equal(cloudNotebookDashboardOpenUrl(owned), "/n/owned-notebook/notebook?mode=edit");
    assert.equal(cloudNotebookDashboardOpenUrl(editor), "/n/editor-notebook/notebook?mode=edit");
    assert.equal(cloudNotebookDashboardOpenUrl(viewer), "/n/viewer-notebook/notebook?mode=view");
  });

  it("replaces any stale dashboard mode parameter without losing hash anchors", () => {
    const owned = notebook({
      id: "owned-notebook",
      title: "Owned notebook",
      scope: "owner",
      updatedAt: "2026-06-07T15:00:00.000Z",
      latestRevisionId: null,
    });
    owned.viewer_url = "http://localhost/n/owned-notebook/Owned%20notebook?mode=view#section-a";

    assert.equal(
      cloudNotebookDashboardOpenUrl(owned),
      "http://localhost/n/owned-notebook/Owned%20notebook?mode=edit#section-a",
    );
  });

  it("opens newly created notebooks in edit mode on the current browser origin", () => {
    assert.equal(
      cloudNotebookOpenUrlWithMode(
        "https://preview.runt.run/n/new-notebook/Exploration%20Notes",
        "edit",
        { browserOrigin: "http://localhost:45320" },
      ),
      "http://localhost:45320/n/new-notebook/Exploration%20Notes?mode=edit",
    );
  });

  it("projects hosted notebook routes onto the current browser origin", () => {
    const owned = notebook({
      id: "owned-notebook",
      title: "Owned notebook",
      scope: "owner",
      updatedAt: "2026-06-07T15:00:00.000Z",
      latestRevisionId: null,
    });
    owned.viewer_url = "https://preview.runt.run/n/owned-notebook/Owned%20notebook?mode=view";

    assert.equal(
      cloudNotebookDashboardOpenUrl(owned, { browserOrigin: "http://localhost:45316" }),
      "http://localhost:45316/n/owned-notebook/Owned%20notebook?mode=edit",
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

    const model = projectCloudNotebookDashboard([untitled]);
    const view = projectCloudNotebookDashboardView(model);

    assert.deepEqual(
      view.sections.flatMap((section) =>
        section.rows.map((row) => [row.notebook.notebook_id, row.identityLabel]),
      ),
      [["01KTHB58DSJWERSEWHD3EJD74P", "01KTHB58...D74P"]],
    );
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

  it("projects search-first sections and search-aware filter counts without mutating the model", () => {
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
    const oldSearchView = projectCloudNotebookDashboardView(model, { query: "archived" });
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
      searchView.sections.map((section) => [section.id, section.title, section.detail]),
      [["search", "Search results", "1 notebook matching search"]],
    );
    assert.deepEqual(
      oldSearchView.sections.map((section) => [section.id, section.title, section.detail]),
      [["search", "Search results", "1 notebook matching search"]],
    );
    assert.deepEqual(
      searchView.filters.map((filter) => [filter.id, filter.count, filter.group]),
      [
        ["all", 1, "work"],
        ["shared", 1, "work"],
      ],
    );
    assert.deepEqual(
      defaultView.filters.map((filter) => [filter.id, filter.count, filter.group]),
      [
        ["all", 3, "work"],
        ["owned", 1, "work"],
        ["shared", 2, "work"],
        ["published", 1, "work"],
      ],
    );
    assert.deepEqual(
      defaultView.sections.map((section) => [
        section.id,
        section.title,
        section.detail,
        section.notebooks.map((item) => item.notebook_id),
      ]),
      [
        [
          "shared",
          "Shared with me",
          "2 notebooks shared with this account",
          ["renderer-regression", "archive"],
        ],
      ],
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
          row.identityLabel,
        ]),
      ),
      [
        ["renderer-regression", "Shared notebook", [["access", "editor"]], null],
        ["archive", "Shared notebook", [["access", "viewer"]], null],
      ],
    );
  });

  it("does not repeat the continuation notebook in the default recent work list", () => {
    const continued = notebook({
      id: "topic-viz",
      title: "Topic Visualization",
      scope: "owner",
      updatedAt: "2026-06-07T15:00:00.000Z",
      latestRevisionId: "published-topic",
    });
    const followUp = notebook({
      id: "workstation-notes",
      title: "Workstation Notes",
      scope: "owner",
      updatedAt: "2026-06-06T15:00:00.000Z",
      latestRevisionId: null,
    });

    const model = projectCloudNotebookDashboard([followUp, continued]);
    const defaultView = projectCloudNotebookDashboardView(model);
    const ownedView = projectCloudNotebookDashboardView(model, { filterId: "owned" });
    const searchView = projectCloudNotebookDashboardView(model, { query: "topic" });

    assert.equal(model.continueNotebook?.notebook_id, "topic-viz");
    assert.deepEqual(
      defaultView.sections.flatMap((section) =>
        section.rows.map((row) => row.notebook.notebook_id),
      ),
      ["workstation-notes"],
    );
    assert.deepEqual(
      ownedView.sections.flatMap((section) => section.rows.map((row) => row.notebook.notebook_id)),
      ["topic-viz", "workstation-notes"],
    );
    assert.deepEqual(
      searchView.sections.flatMap((section) => section.rows.map((row) => row.notebook.notebook_id)),
      ["topic-viz"],
    );
  });

  it("distinguishes a continue-only dashboard from a truly empty notebook list", () => {
    const continued = notebook({
      id: "solo-notebook",
      title: "Solo Notebook",
      scope: "owner",
      updatedAt: "2026-06-07T15:00:00.000Z",
      latestRevisionId: null,
    });

    const soloModel = projectCloudNotebookDashboard([continued]);
    const soloView = projectCloudNotebookDashboardView(soloModel);
    const emptyModel = projectCloudNotebookDashboard([]);
    const emptyView = projectCloudNotebookDashboardView(emptyModel);

    assert.equal(soloModel.continueNotebook?.notebook_id, "solo-notebook");
    assert.equal(soloView.resultCount, 1);
    assert.deepEqual(soloView.sections, []);
    assert.equal(soloView.emptyMessage, "No other notebooks yet.");
    assert.equal(emptyView.resultCount, 0);
    assert.equal(emptyView.emptyMessage, "No notebooks yet.");
  });

  it("surfaces shared notebooks as their own default dashboard section", () => {
    const owned = notebook({
      id: "owned-notes",
      title: "Owned Notes",
      scope: "owner",
      updatedAt: "2026-06-06T15:00:00.000Z",
      latestRevisionId: null,
    });
    const sharedEditor = notebook({
      id: "shared-editor",
      title: "Shared Editor",
      scope: "editor",
      updatedAt: "2026-06-07T15:00:00.000Z",
      latestRevisionId: null,
    });
    const sharedViewer = notebook({
      id: "shared-viewer",
      title: "Shared Viewer",
      scope: "viewer",
      updatedAt: "2026-06-05T12:00:00.000Z",
      latestRevisionId: null,
    });

    const model = projectCloudNotebookDashboard([sharedViewer, owned, sharedEditor]);
    const view = projectCloudNotebookDashboardView(model);

    assert.equal(model.continueNotebook?.notebook_id, "shared-editor");
    assert.deepEqual(
      view.sections.map((section) => [
        section.id,
        section.title,
        section.notebooks.map((item) => item.notebook_id),
      ]),
      [
        ["named", "Recent work", ["owned-notes"]],
        ["shared", "Shared with me", ["shared-editor", "shared-viewer"]],
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
    const followUp = notebook({
      id: "workstation-notes",
      title: "Workstation Notes",
      scope: "owner",
      updatedAt: "2026-05-31T12:00:00.000Z",
      latestRevisionId: null,
    });

    const model = projectCloudNotebookDashboard([generated, untitled, followUp, realWork]);
    const view = projectCloudNotebookDashboardView(model);

    assert.equal(model.continueNotebook?.notebook_id, "topic-viz");
    assert.deepEqual(
      view.sections.map((section) => [
        section.id,
        section.title,
        section.detail,
        section.notebooks.map((item) => item.notebook_id),
      ]),
      [
        ["named", "Recent work", "1 more notebook to reopen", ["workstation-notes"]],
        ["generated", "Generated runs", "1 notebook from smoke and debug work", ["toolbar-smoke"]],
        [
          "untitled",
          "Needs title",
          "Rename notebooks worth keeping so they stay easy to find.",
          ["untitled-new"],
        ],
      ],
    );
    assert.deepEqual(
      view.sections.flatMap((section) =>
        section.rows.map((row) => [
          row.notebook.notebook_id,
          row.contextLabel,
          row.facts.map((fact) => [fact.kind, fact.label]),
          row.identityLabel,
        ]),
      ),
      [
        ["workstation-notes", null, [], null],
        ["toolbar-smoke", "Generated run", [], null],
        ["untitled-new", "Needs title", [], "untitled-new"],
      ],
    );
  });

  it("does not classify ordinary prose titles as generated runs", () => {
    const smokeResearch = notebook({
      id: "wildfire-smoke",
      title: "Wildfire smoke dispersion",
      scope: "owner",
      updatedAt: "2026-06-08T19:00:00.000Z",
      latestRevisionId: null,
    });
    const debugNotes = notebook({
      id: "debugging-imports",
      title: "Debugging the import pipeline",
      scope: "owner",
      updatedAt: "2026-06-08T18:00:00.000Z",
      latestRevisionId: null,
    });
    const latencyNotes = notebook({
      id: "latency-q2",
      title: "Latency benchmarks Q2",
      scope: "owner",
      updatedAt: "2026-06-08T17:00:00.000Z",
      latestRevisionId: null,
    });
    const generated = notebook({
      id: "toolbar-smoke",
      title: "Toolbar attach smoke 2026-06-08T19:26:35.312Z",
      scope: "owner",
      updatedAt: "2026-06-08T16:00:00.000Z",
      latestRevisionId: null,
    });
    const generatedSync = notebook({
      id: "sync-recovery",
      title: "Sync Recovery Smoke",
      scope: "owner",
      updatedAt: "2026-06-08T15:00:00.000Z",
      latestRevisionId: null,
    });

    const model = projectCloudNotebookDashboard([
      generatedSync,
      generated,
      latencyNotes,
      debugNotes,
      smokeResearch,
    ]);
    const view = projectCloudNotebookDashboardView(model);

    assert.equal(model.continueNotebook?.notebook_id, "wildfire-smoke");
    assert.deepEqual(
      view.sections.map((section) => [
        section.id,
        section.title,
        section.notebooks.map((item) => item.notebook_id),
      ]),
      [
        ["named", "Recent work", ["debugging-imports", "latency-q2"]],
        ["generated", "Generated runs", ["toolbar-smoke", "sync-recovery"]],
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
      model.filters.map((filter) => [filter.id, filter.count, filter.group]),
      [
        ["all", 13, "work"],
        ["owned", 13, "work"],
        ["generated", 7, "cleanup"],
        ["untitled", 6, "cleanup"],
      ],
    );
    assert.deepEqual(
      model.filterGroups.map((group) => ({
        filters: group.filters.map((filter) => filter.id),
        id: group.id,
        label: group.label,
      })),
      [
        { filters: ["all", "owned"], id: "work", label: "Notebook views" },
        { filters: ["generated", "untitled"], id: "cleanup", label: "Cleanup filters" },
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
