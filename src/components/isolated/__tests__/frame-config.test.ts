import { describe, expect, it } from "vite-plus/test";
import {
  createIsolatedFrameDocument,
  ISOLATED_FRAME_ALLOW_ATTR,
  ISOLATED_FRAME_SANDBOX_ATTRS,
  isTauriFrameRuntime,
  NTERACT_FRAME_URL,
} from "../frame-config";
import { FRAME_HTML } from "../frame-html";

const EXPECTED_SANDBOX_ATTRS = "allow-scripts allow-downloads allow-forms allow-pointer-lock";

describe("isolated frame config", () => {
  it("uses srcDoc in browser-only hosts", () => {
    expect(createIsolatedFrameDocument({ isTauriRuntime: false })).toEqual({
      kind: "srcdoc",
      html: FRAME_HTML,
    });
  });

  it("uses the custom nteract-frame URL in Tauri hosts", () => {
    expect(createIsolatedFrameDocument({ isTauriRuntime: true })).toEqual({
      kind: "src",
      url: NTERACT_FRAME_URL,
    });
  });

  it("uses an explicit output document URL before runtime defaults", () => {
    expect(
      createIsolatedFrameDocument({
        isTauriRuntime: true,
        outputDocumentUrl: "https://outputs.example/frame/",
      }),
    ).toEqual({
      kind: "src",
      url: "https://outputs.example/frame/",
    });
  });

  it("can seed hosted output documents with the initial theme without changing srcdoc hosts", () => {
    expect(
      createIsolatedFrameDocument({
        outputDocumentUrl: "https://outputs.example/frame/?v=1#shell",
        themeSeed: { theme: "dark", colorTheme: "cream" },
      }),
    ).toEqual({
      kind: "src",
      url: "https://outputs.example/frame/?v=1&nteract_theme=dark&nteract_color_theme=cream#shell",
    });

    expect(
      createIsolatedFrameDocument({
        isTauriRuntime: false,
        themeSeed: { theme: "light", colorTheme: "cream" },
      }),
    ).toEqual({
      kind: "srcdoc",
      html: FRAME_HTML,
    });
  });

  it("detects Tauri globals without requiring a real browser window", () => {
    expect(isTauriFrameRuntime(undefined)).toBe(false);
    expect(isTauriFrameRuntime({ __TAURI__: {} })).toBe(true);
    expect(isTauriFrameRuntime({ __TAURI_INTERNALS__: {} })).toBe(true);
  });

  it("keeps the shared sandbox free of same-origin access", () => {
    expect(ISOLATED_FRAME_SANDBOX_ATTRS).toBe(EXPECTED_SANDBOX_ATTRS);

    const tokens = ISOLATED_FRAME_SANDBOX_ATTRS.split(" ");
    expect(tokens).toContain("allow-scripts");
    expect(tokens).toContain("allow-downloads");
    expect(tokens).not.toContain("allow-same-origin");
    expect(tokens).not.toContain("allow-top-navigation");
  });

  it("allows fullscreen in the shared iframe allow policy", () => {
    const directives = ISOLATED_FRAME_ALLOW_ATTR.split(/\s+/);

    expect(directives).toContain("fullscreen");
    expect(directives).toContain("*");
  });
});
