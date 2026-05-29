import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { supplementalStylesheetsFromManifest } from "../viewer/supplemental-css.ts";

describe("viewer supplemental CSS loader", () => {
  it("accepts same-origin built viewer CSS assets", () => {
    assert.deepEqual(
      supplementalStylesheetsFromManifest({
        supplemental: ["/assets/notebook-cloud-viewer2.css", "/assets/markdown-output.css"],
      }),
      ["/assets/notebook-cloud-viewer2.css", "/assets/markdown-output.css"],
    );
  });

  it("ignores malformed or remote stylesheet hrefs", () => {
    assert.deepEqual(
      supplementalStylesheetsFromManifest({
        supplemental: [
          "https://example.test/remote.css",
          "/renderer-assets/isolated-renderer.css",
          "/assets/../secret.css",
          "/assets/%2e%2e/secret.css",
          "/assets/not-css.txt",
          null,
        ],
      }),
      [],
    );
  });
});
