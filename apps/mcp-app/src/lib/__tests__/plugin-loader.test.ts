import { describe, expect, it } from "vite-plus/test";
import { daemonPluginAssetUrl } from "../plugin-loader";

describe("daemonPluginAssetUrl", () => {
  it("appends a content hash when one is available", () => {
    expect(
      daemonPluginAssetUrl("http://localhost:1234", "markdown.js", {
        "markdown.js": "abc123",
      }),
    ).toBe("http://localhost:1234/plugins/markdown.js?v=abc123");
  });

  it("leaves the stable URL untouched when no hash is available", () => {
    expect(daemonPluginAssetUrl("http://localhost:1234", "plotly.js", {})).toBe(
      "http://localhost:1234/plugins/plotly.js",
    );
  });
});
