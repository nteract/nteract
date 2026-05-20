/**
 * Tests for isolated-frame.tsx security invariants.
 *
 * CRITICAL SECURITY TESTS:
 * These tests verify the iframe sandbox configuration is secure.
 * If these tests fail, DO NOT PROCEED - the security model is broken.
 */

import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../isolated-renderer-context", () => ({
  useIsolatedRenderer: () => ({
    rendererCode: undefined,
    rendererCss: undefined,
    isLoading: false,
    error: null,
  }),
}));

import { ISOLATED_FRAME_SANDBOX_ATTRS } from "../frame-config";
import { IsolatedFrame } from "../isolated-frame";

describe("iframe sandbox security", () => {
  /**
   * CRITICAL: The sandbox MUST NOT include allow-same-origin.
   *
   * If allow-same-origin is present, the iframe would:
   * - Have access to the parent's origin
   * - Be able to call Tauri APIs (window.__TAURI__)
   * - Be able to access parent's DOM, cookies, localStorage
   *
   * This would completely break the security model.
   */
  it("sandbox does NOT include allow-same-origin", () => {
    expect(ISOLATED_FRAME_SANDBOX_ATTRS).not.toContain("allow-same-origin");
  });

  it("rendered iframe sandbox does NOT include allow-same-origin", () => {
    const { container } = render(createElement(IsolatedFrame));
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;

    expect(iframe).not.toBeNull();
    const sandboxTokens = iframe.getAttribute("sandbox")?.split(/\s+/) ?? [];
    expect(sandboxTokens).not.toContain("allow-same-origin");
  });

  it("sandbox includes allow-scripts (required for widgets)", () => {
    expect(ISOLATED_FRAME_SANDBOX_ATTRS).toContain("allow-scripts");
  });

  it("sandbox does NOT include allow-popups", () => {
    expect(ISOLATED_FRAME_SANDBOX_ATTRS).not.toContain("allow-popups");
  });

  it("sandbox does NOT include allow-modals", () => {
    expect(ISOLATED_FRAME_SANDBOX_ATTRS).not.toContain("allow-modals");
  });

  /**
   * Verify we're not accidentally including dangerous permissions.
   */
  it("sandbox does NOT include allow-top-navigation", () => {
    expect(ISOLATED_FRAME_SANDBOX_ATTRS).not.toContain("allow-top-navigation");
  });

  it("sandbox does NOT include allow-top-navigation-by-user-activation", () => {
    expect(ISOLATED_FRAME_SANDBOX_ATTRS).not.toContain("allow-top-navigation-by-user-activation");
  });
});

describe("sandbox attribute format", () => {
  it("is a space-separated string", () => {
    const parts = ISOLATED_FRAME_SANDBOX_ATTRS.split(" ");
    expect(parts.length).toBeGreaterThan(0);
    // No empty parts (no double spaces)
    expect(parts.every((p) => p.length > 0)).toBe(true);
  });

  it("all parts start with 'allow-'", () => {
    const parts = ISOLATED_FRAME_SANDBOX_ATTRS.split(" ");
    expect(parts.every((p) => p.startsWith("allow-"))).toBe(true);
  });
});
