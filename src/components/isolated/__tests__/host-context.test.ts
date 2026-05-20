import { describe, expect, it } from "vite-plus/test";
import {
  createNteractEmbedHostContext,
  createNteractThemeVariables,
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
});
