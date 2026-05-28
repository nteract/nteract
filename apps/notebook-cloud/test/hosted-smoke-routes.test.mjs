import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  catalogApiUrlForViewer,
  notebookViewerUrl,
  renderApiUrlForViewer,
} from "../scripts/hosted-render-smoke-routes.mjs";

describe("hosted render smoke routes", () => {
  it("derives the render API URL from a hosted notebook viewer URL", () => {
    assert.equal(
      renderApiUrlForViewer(
        "https://nteract-notebook-cloud.rgbkrk.workers.dev/n/nteract-cloud-live-mathnet",
      ),
      "https://nteract-notebook-cloud.rgbkrk.workers.dev/api/n/nteract-cloud-live-mathnet/render",
    );
  });

  it("derives the render API URL from a hosted vanity notebook viewer URL", () => {
    assert.equal(
      renderApiUrlForViewer("https://preview.runt.run/n/01KSQKEPFJVHV4T4ZDYS9V7T80/lets-edit"),
      "https://preview.runt.run/api/n/01KSQKEPFJVHV4T4ZDYS9V7T80/render",
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

  it("returns null for non-viewer URLs", () => {
    assert.equal(renderApiUrlForViewer("https://example.com/"), null);
    assert.equal(renderApiUrlForViewer("https://example.com/n/foo/sync"), null);
    assert.equal(renderApiUrlForViewer("https://example.com/n/foo/debug"), null);
    assert.equal(renderApiUrlForViewer("https://example.com/n/foo/r/head123"), null);
    assert.equal(catalogApiUrlForViewer("https://example.com/"), null);
    assert.equal(catalogApiUrlForViewer("https://example.com/n/foo/sync"), null);
  });
});
