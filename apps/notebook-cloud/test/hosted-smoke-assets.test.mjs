import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkViewerCssSplit,
  isViewerCssAssetPath,
  validateViewerCssManifestPayload,
} from "../scripts/hosted-render-smoke-assets.mjs";

describe("hosted render smoke viewer CSS assets", () => {
  it("accepts only same-origin viewer CSS asset paths", () => {
    assert.equal(isViewerCssAssetPath("/assets/notebook-cloud-viewer.css"), true);
    assert.equal(isViewerCssAssetPath("/assets/katex-options-D_EmowkL.css"), true);
    assert.equal(isViewerCssAssetPath("https://example.test/style.css"), false);
    assert.equal(isViewerCssAssetPath("/renderer-assets/isolated-renderer.css"), false);
    assert.equal(isViewerCssAssetPath("/assets/../secret.css"), false);
    assert.equal(isViewerCssAssetPath("/assets/%2e%2e/secret.css"), false);
    assert.equal(isViewerCssAssetPath("/assets/not-css.txt"), false);
  });

  it("requires a primary stylesheet and supplemental split CSS", () => {
    assert.deepEqual(
      validateViewerCssManifestPayload({
        primary: "/assets/notebook-cloud-viewer.css",
        supplemental: ["/assets/katex-options-D_EmowkL.css"],
      }),
      {
        primary: "/assets/notebook-cloud-viewer.css",
        supplemental: ["/assets/katex-options-D_EmowkL.css"],
        failures: [],
      },
    );

    const collapsed = validateViewerCssManifestPayload({
      primary: "/assets/notebook-cloud-viewer.css",
      supplemental: [],
    });
    assert.equal(collapsed.failures.length, 1);
    assert.match(collapsed.failures[0].text, /expected at least 1 supplemental/);
  });

  it("checks the hosted manifest, primary stylesheet size, and supplemental headers", async () => {
    const responses = new Map([
      [
        "https://preview.runt.run/assets/notebook-cloud-viewer-css.json",
        Response.json({
          primary: "/assets/notebook-cloud-viewer.css",
          supplemental: ["/assets/katex-options-D_EmowkL.css"],
        }),
      ],
      [
        "https://preview.runt.run/assets/notebook-cloud-viewer.css",
        new Response("css", {
          headers: { "content-type": "text/css" },
        }),
      ],
      [
        "HEAD https://preview.runt.run/assets/katex-options-D_EmowkL.css",
        new Response(null, {
          headers: { "content-type": "text/css" },
        }),
      ],
    ]);

    const check = await checkViewerCssSplit("https://preview.runt.run/n/topic-viz", {
      fetchImpl: fakeFetch(responses),
      maxPrimaryBytes: 250_000,
    });

    assert.equal(check.manifestStatus, 200);
    assert.equal(check.primaryBytes, 3);
    assert.equal(check.supplemental.length, 1);
    assert.deepEqual(check.failures, []);
  });

  it("reports when the primary stylesheet grows back into the large render-blocking bundle", async () => {
    const responses = new Map([
      [
        "https://preview.runt.run/assets/notebook-cloud-viewer-css.json",
        Response.json({
          primary: "/assets/notebook-cloud-viewer.css",
          supplemental: ["/assets/katex-options-D_EmowkL.css"],
        }),
      ],
      [
        "https://preview.runt.run/assets/notebook-cloud-viewer.css",
        new Response("x".repeat(251_000), {
          headers: { "content-type": "text/css" },
        }),
      ],
      [
        "HEAD https://preview.runt.run/assets/katex-options-D_EmowkL.css",
        new Response(null, {
          headers: { "content-type": "text/css" },
        }),
      ],
    ]);

    const check = await checkViewerCssSplit("https://preview.runt.run/n/topic-viz", {
      fetchImpl: fakeFetch(responses),
      maxPrimaryBytes: 250_000,
    });

    assert.equal(check.primaryBytes, 251_000);
    assert.equal(check.failures.length, 1);
    assert.match(check.failures[0].text, /primary viewer CSS was 251000 bytes/);
  });
});

function fakeFetch(responses) {
  return async (url, init = {}) => {
    const key = init.method === "HEAD" ? `HEAD ${url}` : url;
    const response = responses.get(key);
    if (!response) {
      return new Response("missing", { status: 404 });
    }
    return response.clone();
  };
}
