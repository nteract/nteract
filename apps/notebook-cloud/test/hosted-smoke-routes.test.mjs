import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  catalogApiUrlForViewer,
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
  });

  it("returns null for non-viewer URLs", () => {
    assert.equal(renderApiUrlForViewer("https://example.com/"), null);
    assert.equal(renderApiUrlForViewer("https://example.com/n/foo/sync"), null);
    assert.equal(catalogApiUrlForViewer("https://example.com/"), null);
    assert.equal(catalogApiUrlForViewer("https://example.com/n/foo/sync"), null);
  });
});
