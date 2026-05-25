import { describe, expect, it } from "vite-plus/test";
import {
  createNteractEmbedHostContext,
  createNteractThemeVariables,
  mcpAppHostContextToNteractEmbedPatch,
  mergeNteractEmbedHostContext,
} from "../host-context";

describe("nteract embed host context", () => {
  it("maps classic light theme into MCP Apps-style variables", () => {
    const context = createNteractEmbedHostContext({
      isDark: false,
      colorTheme: "classic",
      containerDimensions: { width: 640, maxHeight: 400 },
      locale: "en-US",
      timeZone: "America/Los_Angeles",
      userAgent: "nteract-test",
      platform: "desktop",
      deviceCapabilities: { hover: true, touch: false },
    });

    expect(context).toMatchObject({
      theme: "light",
      displayMode: "inline",
      availableDisplayModes: ["inline", "fullscreen"],
      containerDimensions: { width: 640, maxHeight: 400 },
      locale: "en-US",
      timeZone: "America/Los_Angeles",
      userAgent: "nteract-test",
      platform: "desktop",
      deviceCapabilities: { hover: true, touch: false },
      nteract: { colorTheme: "classic" },
    });
    expect(context.styles?.variables).toMatchObject({
      "--color-background-primary": "transparent",
      "--color-text-primary": "#1a1a1a",
      "--bg-primary": "transparent",
      "--text-primary": "#1a1a1a",
      "--font-sans": expect.stringContaining("system-ui"),
    });
  });

  it("maps cream dark theme to warm variables and document font", () => {
    expect(createNteractThemeVariables(true, "cream")).toMatchObject({
      "--color-text-primary": "#e8e2dc",
      "--color-border-primary": "#3a3533",
      "--text-secondary": "#9a918a",
      "--output-document-font": 'KaTeX_Main, Georgia, "Times New Roman", serif',
    });
  });

  it("deep merges host-provided variables and font CSS", () => {
    const merged = mergeNteractEmbedHostContext(
      createNteractEmbedHostContext({
        isDark: true,
        colorTheme: null,
        locale: "en-US",
        timeZone: "America/Los_Angeles",
        userAgent: "nteract-test",
        platform: "desktop",
      }),
      {
        styles: {
          variables: {
            "--color-text-primary": "#abcdef",
          },
          css: {
            fonts: "@font-face { font-family: Test; src: url(test.woff2); }",
          },
        },
      },
    );

    expect(merged.theme).toBe("dark");
    expect(merged.styles?.variables).toMatchObject({
      "--color-background-primary": "transparent",
      "--color-text-primary": "#abcdef",
      "--text-primary": "#e0e0e0",
    });
    expect(merged.styles?.css?.fonts).toContain("font-family: Test");
  });

  it("fills partial safe-area patches with prior values and zero defaults", () => {
    const merged = mergeNteractEmbedHostContext(
      {
        safeAreaInsets: {
          top: 12,
          bottom: 4,
        },
      },
      {
        safeAreaInsets: {
          left: 8,
        },
      },
    );

    expect(merged.safeAreaInsets).toEqual({
      top: 12,
      right: 0,
      bottom: 4,
      left: 8,
    });
  });

  it("adapts MCP App host context without reusing outer app dimensions", () => {
    const patch = mcpAppHostContextToNteractEmbedPatch(
      {
        theme: "dark",
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen", "unsupported"],
        containerDimensions: {
          width: 614,
          height: 330,
        },
        styles: {
          variables: {
            "--color-text-primary": "#fff",
            "--ignored-non-string": 123,
          },
          css: {
            fonts: "@font-face { font-family: Test; src: url(test.woff2); }",
          },
        },
        locale: "en-US",
        timeZone: "America/Los_Angeles",
        userAgent: "Claude",
        platform: "desktop",
        safeAreaInsets: {
          top: 1,
          bottom: 2,
        },
      },
      {
        rendererAssetsBaseUrl: "http://localhost:47830/plugins/",
      },
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
      userAgent: "Claude",
      platform: "desktop",
      safeAreaInsets: {
        top: 1,
        bottom: 2,
      },
      nteract: {
        rendererAssetsBaseUrl: "http://localhost:47830/plugins/",
      },
    });
    expect(patch.styles?.variables).not.toHaveProperty("--ignored-non-string");
    expect(patch.containerDimensions).toBeUndefined();
    expect(patch.nteract).not.toHaveProperty("outputDocumentUrl");
  });

  it("can opt into MCP App host dimensions for direct embedders", () => {
    const patch = mcpAppHostContextToNteractEmbedPatch(
      {
        containerDimensions: {
          width: 800,
          height: 300,
          maxHeight: "bad",
        },
      },
      {
        includeContainerDimensions: true,
      },
    );

    expect(patch.containerDimensions).toEqual({
      width: 800,
      height: 300,
    });
  });

  it("does not clobber existing nteract fields with undefined adapter values", () => {
    const merged = mergeNteractEmbedHostContext(
      {
        nteract: {
          outputDocumentUrl: "https://outputs.example/frame",
        },
      },
      mcpAppHostContextToNteractEmbedPatch(null, {
        rendererAssetsBaseUrl: "https://assets.example/plugins/",
      }),
    );

    expect(merged.nteract).toEqual({
      outputDocumentUrl: "https://outputs.example/frame",
      rendererAssetsBaseUrl: "https://assets.example/plugins/",
    });
  });
});
