import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderApiUrlForViewer } from "../scripts/hosted-render-smoke-routes.mjs";

describe("hosted render smoke routes", () => {
  it("derives the render API URL from a hosted notebook viewer URL", () => {
    assert.equal(
      renderApiUrlForViewer(
        "https://nteract-notebook-cloud.rgbkrk.workers.dev/n/nteract-cloud-live-mathnet",
      ),
      "https://nteract-notebook-cloud.rgbkrk.workers.dev/api/n/nteract-cloud-live-mathnet/render",
    );
  });

  it("returns null for non-viewer URLs", () => {
    assert.equal(renderApiUrlForViewer("https://example.com/"), null);
    assert.equal(renderApiUrlForViewer("https://example.com/n/foo/sync"), null);
  });
});
