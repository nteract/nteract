import { describe, expect, it } from "vite-plus/test";
import {
  createIsolatedFrameDocument,
  ISOLATED_FRAME_ALLOW_ATTR,
  ISOLATED_FRAME_SANDBOX_ATTRS,
  isTauriFrameRuntime,
  NTERACT_FRAME_URL,
} from "../frame-config";
import { FRAME_HTML } from "../frame-html";

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

  it("detects Tauri globals without requiring a real browser window", () => {
    expect(isTauriFrameRuntime(undefined)).toBe(false);
    expect(isTauriFrameRuntime({ __TAURI__: {} })).toBe(true);
    expect(isTauriFrameRuntime({ __TAURI_INTERNALS__: {} })).toBe(true);
  });

  it("keeps the shared sandbox free of same-origin access", () => {
    const tokens = ISOLATED_FRAME_SANDBOX_ATTRS.split(" ");
    expect(tokens).toContain("allow-scripts");
    expect(tokens).toContain("allow-downloads");
    expect(tokens).not.toContain("allow-same-origin");
    expect(tokens).not.toContain("allow-top-navigation");
  });

  it("shares the fullscreen allow policy for non-React adapters", () => {
    expect(ISOLATED_FRAME_ALLOW_ATTR).toBe("fullscreen *");
  });
});
