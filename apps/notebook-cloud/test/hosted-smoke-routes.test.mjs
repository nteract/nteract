import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  catalogApiUrlForViewer,
  isRenderCacheApiUrl,
  notebookViewerUrl,
  pinnedNotebookViewerUrl,
} from "../scripts/hosted-render-smoke-routes.mjs";

describe("hosted render smoke routes", () => {
  it("derives the catalog API URL from a hosted notebook viewer URL", () => {
    assert.equal(
      catalogApiUrlForViewer(
        "https://nteract-notebook-cloud.rgbkrk.workers.dev/n/nteract-cloud-live-mathnet/topic-viz",
      ),
      "https://nteract-notebook-cloud.rgbkrk.workers.dev/api/n/nteract-cloud-live-mathnet",
    );
    assert.equal(catalogApiUrlForViewer("https://example.com/n/foo/"), null);
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
    assert.equal(notebookViewerUrl("https://example.com/n/foo"), null);
    assert.deepEqual(notebookViewerUrl("https://example.com/n/foo/lets-edit"), {
      origin: "https://example.com",
      notebookId: "foo",
      vanityName: "lets-edit",
    });
  });

  it("summarizes pinned viewer URLs separately from live viewer URLs", () => {
    assert.equal(notebookViewerUrl("https://example.com/n/foo/r/heads"), null);
    assert.deepEqual(pinnedNotebookViewerUrl("https://example.com/n/foo/r/heads"), {
      origin: "https://example.com",
      notebookId: "foo",
      headsHash: "heads",
    });
  });

  it("returns null for non-viewer URLs", () => {
    assert.equal(catalogApiUrlForViewer("https://example.com/"), null);
    assert.equal(catalogApiUrlForViewer("https://example.com/n/foo"), null);
    assert.equal(catalogApiUrlForViewer("https://example.com/n/foo/sync"), null);
  });

  it("identifies stale render-cache API URLs", () => {
    assert.equal(isRenderCacheApiUrl("https://example.com/api/n/foo/render"), true);
    assert.equal(isRenderCacheApiUrl("https://example.com/api/n/foo/render?cache=1"), true);
    assert.equal(isRenderCacheApiUrl("https://example.com/api/n/foo/renders/heads"), true);
    assert.equal(isRenderCacheApiUrl("https://example.com/api/n/foo/renders/heads/"), true);
    assert.equal(isRenderCacheApiUrl("https://example.com/api/n/foo/snapshots/heads"), false);
    assert.equal(
      isRenderCacheApiUrl("https://example.com/api/n/foo/runtime-snapshots/heads"),
      false,
    );
    assert.equal(isRenderCacheApiUrl("https://example.com/api/n/foo/blobs/sha256"), false);
    assert.equal(isRenderCacheApiUrl("https://example.com/n/foo/r/heads"), false);
    assert.equal(isRenderCacheApiUrl("not a url"), false);
  });
});
