import { describe, expect, it } from "vite-plus/test";
import { mcpHostContextToNteractEmbedPatch } from "../shared-host-context";

describe("mcpHostContextToNteractEmbedPatch", () => {
  it("forwards MCP host theme metadata without reusing outer app dimensions", () => {
    const patch = mcpHostContextToNteractEmbedPatch(
      {
        theme: "dark",
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen"],
        containerDimensions: {
          width: 614,
          height: 330,
        },
        styles: {
          variables: {
            "--color-text-primary": "#fff",
          },
          css: {
            fonts: "@font-face { font-family: Test; src: url(test.woff2); }",
          },
        },
        locale: "en-US",
        timeZone: "America/Los_Angeles",
        platform: "desktop",
      },
      "http://localhost:47830/",
    );

    expect(patch).toMatchObject({
      theme: "dark",
      displayMode: "inline",
      availableDisplayModes: ["inline", "fullscreen"],
      styles: {
        variables: {
          "--color-text-primary": "#fff",
        },
        css: {
          fonts: "@font-face { font-family: Test; src: url(test.woff2); }",
        },
      },
      locale: "en-US",
      timeZone: "America/Los_Angeles",
      platform: "desktop",
      nteract: {
        rendererAssetsBaseUrl: "http://localhost:47830/plugins/",
      },
    });
    expect(patch.containerDimensions).toBeUndefined();
  });
});
