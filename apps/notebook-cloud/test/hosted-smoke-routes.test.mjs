import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  catalogApiUrlForViewer,
  expectedRenderSourceForViewer,
  hostedNotebookRequestKind,
  notebookViewerUrl,
  pinnedNotebookViewerUrl,
  renderApiUrlForViewer,
} from "../scripts/hosted-render-smoke-routes.mjs";

describe("hosted render smoke routes", () => {
  it("derives the pinned render API URL from a hosted notebook viewer URL", () => {
    assert.equal(
      renderApiUrlForViewer(
        "https://nteract-notebook-cloud.rgbkrk.workers.dev/n/nteract-cloud-live-mathnet",
        "heads-latest",
      ),
      "https://nteract-notebook-cloud.rgbkrk.workers.dev/api/n/nteract-cloud-live-mathnet/renders/heads-latest",
    );
  });

  it("derives the pinned render API URL from a hosted vanity notebook viewer URL", () => {
    assert.equal(
      renderApiUrlForViewer(
        "https://preview.runt.run/n/01KSQKEPFJVHV4T4ZDYS9V7T80/lets-edit",
        "heads-edit",
      ),
      "https://preview.runt.run/api/n/01KSQKEPFJVHV4T4ZDYS9V7T80/renders/heads-edit",
    );
  });

  it("derives the render API URL directly from a pinned snapshot viewer URL", () => {
    assert.equal(
      renderApiUrlForViewer("https://preview.runt.run/n/topic-viz/r/heads-pinned", null),
      "https://preview.runt.run/api/n/topic-viz/renders/heads-pinned",
    );
  });

  it("derives the catalog API URL from a hosted notebook viewer URL", () => {
    assert.equal(
      catalogApiUrlForViewer(
        "https://nteract-notebook-cloud.rgbkrk.workers.dev/n/nteract-cloud-live-mathnet",
      ),
      "https://nteract-notebook-cloud.rgbkrk.workers.dev/api/n/nteract-cloud-live-mathnet",
    );
    assert.equal(
      catalogApiUrlForViewer("https://example.com/n/foo/"),
      "https://example.com/api/n/foo",
    );
    assert.equal(
      catalogApiUrlForViewer("https://preview.runt.run/n/01KSQKEPFJVHV4T4ZDYS9V7T80/lets-edit"),
      "https://preview.runt.run/api/n/01KSQKEPFJVHV4T4ZDYS9V7T80",
    );
    assert.equal(
      catalogApiUrlForViewer("https://preview.runt.run/n/topic-viz/r/heads-pinned"),
      "https://preview.runt.run/api/n/topic-viz",
    );
  });

  it("summarizes plain and vanity viewer URLs", () => {
    assert.deepEqual(notebookViewerUrl("https://example.com/n/foo"), {
      origin: "https://example.com",
      notebookId: "foo",
      vanityName: null,
    });
    assert.deepEqual(notebookViewerUrl("https://example.com/n/foo/lets-edit"), {
      origin: "https://example.com",
      notebookId: "foo",
      vanityName: "lets-edit",
    });
  });

  it("decodes viewer URL path segments before matching hosted requests", () => {
    assert.deepEqual(notebookViewerUrl("https://example.com/n/folder%2Fdemo/lets%20edit"), {
      origin: "https://example.com",
      notebookId: "folder/demo",
      vanityName: "lets edit",
    });
    assert.deepEqual(pinnedNotebookViewerUrl("https://example.com/n/folder%2Fdemo/r/heads%2F1"), {
      origin: "https://example.com",
      notebookId: "folder/demo",
      headsHash: "heads/1",
    });
    assert.deepEqual(
      hostedNotebookRequestKind(
        "https://example.com/n/folder%2Fdemo/lets%20edit",
        "wss://example.com/n/folder%2Fdemo/sync",
      ),
      { kind: "live-sync" },
    );
    assert.equal(
      catalogApiUrlForViewer("https://example.com/n/folder%2Fdemo/lets%20edit"),
      "https://example.com/api/n/folder%2Fdemo",
    );
    assert.equal(
      renderApiUrlForViewer("https://example.com/n/folder%2Fdemo/lets%20edit", "heads/2"),
      "https://example.com/api/n/folder%2Fdemo/renders/heads%2F2",
    );
  });

  it("summarizes pinned viewer URLs separately from live viewer URLs", () => {
    assert.equal(notebookViewerUrl("https://example.com/n/foo/r/heads"), null);
    assert.deepEqual(pinnedNotebookViewerUrl("https://example.com/n/foo/r/heads"), {
      origin: "https://example.com",
      notebookId: "foo",
      headsHash: "heads",
    });
  });

  it("treats render API checks as opt-in for latest URLs and default-on for pinned URLs", () => {
    assert.equal(expectedRenderSourceForViewer("https://example.com/n/foo", undefined), null);
    assert.equal(
      expectedRenderSourceForViewer("https://example.com/n/foo/r/heads", undefined),
      "snapshot-pair",
    );
    assert.equal(
      expectedRenderSourceForViewer("https://example.com/n/foo", "snapshot-pair"),
      "snapshot-pair",
    );
    assert.equal(expectedRenderSourceForViewer("https://example.com/n/foo/r/heads", ""), null);
  });

  it("classifies live notebook route requests for hosted smoke assertions", () => {
    const viewerUrl = "https://preview.runt.run/n/01KSQKEPFJVHV4T4ZDYS9V7T80/lets-edit";

    assert.deepEqual(
      hostedNotebookRequestKind(
        viewerUrl,
        "wss://preview.runt.run/n/01KSQKEPFJVHV4T4ZDYS9V7T80/sync?viewer_session=abc",
      ),
      { kind: "live-sync" },
    );
    assert.deepEqual(
      hostedNotebookRequestKind(
        viewerUrl,
        "https://preview.runt.run/api/n/01KSQKEPFJVHV4T4ZDYS9V7T80",
      ),
      { kind: "catalog" },
    );
    assert.deepEqual(
      hostedNotebookRequestKind(
        viewerUrl,
        "https://preview.runt.run/api/n/01KSQKEPFJVHV4T4ZDYS9V7T80/renders/heads-edit",
      ),
      { kind: "render-cache", headsHash: "heads-edit" },
    );
    assert.deepEqual(
      hostedNotebookRequestKind(
        viewerUrl,
        "https://preview.runt.run/api/n/01KSQKEPFJVHV4T4ZDYS9V7T80/render",
      ),
      { kind: "legacy-render" },
    );
  });

  it("ignores route requests for other origins or notebooks", () => {
    const viewerUrl = "https://preview.runt.run/n/topic-viz";

    assert.equal(
      hostedNotebookRequestKind(viewerUrl, "https://preview.runt.run/api/n/other/render"),
      null,
    );
    assert.equal(
      hostedNotebookRequestKind(viewerUrl, "https://example.com/api/n/topic-viz/render"),
      null,
    );
  });

  it("returns null for non-viewer URLs", () => {
    assert.equal(renderApiUrlForViewer("https://example.com/"), null);
    assert.equal(renderApiUrlForViewer("https://example.com/n/foo", null), null);
    assert.equal(renderApiUrlForViewer("https://example.com/n/foo/sync", "heads"), null);
    assert.equal(renderApiUrlForViewer("https://example.com/n/foo/debug", "heads"), null);
    assert.equal(catalogApiUrlForViewer("https://example.com/"), null);
    assert.equal(catalogApiUrlForViewer("https://example.com/n/foo/sync"), null);
  });
});
