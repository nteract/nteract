import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jupyterOutputToRenderPayload } from "@/components/isolated/output-payloads";
import { DEFAULT_PRIORITY, selectMimeType } from "@/components/outputs/mime-priority";
import { CLOUD_VIEWER_PRIORITY } from "../viewer/mime-policy.ts";

const WIDGET_VIEW_MIME = "application/vnd.jupyter.widget-view+json";
const ARROW_STREAM_MANIFEST_MIME = "application/vnd.nteract.arrow-stream-manifest+json";

describe("cloud viewer MIME policy", () => {
  it("prefers text fallbacks over unhydrated widget views", () => {
    const data = {
      [WIDGET_VIEW_MIME]: { version_major: 2, version_minor: 0, model_id: "progress" },
      "text/plain": "Resolving data files: 100%",
    };

    assert.equal(selectMimeType(data, DEFAULT_PRIORITY), WIDGET_VIEW_MIME);
    assert.equal(selectMimeType(data, CLOUD_VIEWER_PRIORITY), "text/plain");

    const payload = jupyterOutputToRenderPayload(
      {
        output_id: "test-widget-output",
        output_type: "display_data",
        data,
        metadata: {},
      },
      0,
      { priority: CLOUD_VIEWER_PRIORITY },
    );

    assert.equal(payload?.mimeType, "text/plain");
    assert.equal(payload?.data, "Resolving data files: 100%");
  });

  it("keeps Arrow stream manifests ahead of table text and HTML fallbacks", () => {
    const data = {
      "text/html": "<table><tr><td>fallback</td></tr></table>",
      "text/plain": "plain fallback",
      [ARROW_STREAM_MANIFEST_MIME]: { chunks: [{ url: "https://cloud.test/blob.arrow" }] },
    };

    assert.equal(selectMimeType(data, CLOUD_VIEWER_PRIORITY), ARROW_STREAM_MANIFEST_MIME);
  });
});
