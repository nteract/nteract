/**
 * Render-time security test for the iframe sandbox attribute.
 *
 * The constant-string test in `isolated-frame.test.ts` cannot catch
 * regressions where the JSX site overrides or augments the sandbox
 * tokens. Render the component, query the live iframe element, and
 * assert the actual sandbox token list. This is the load-bearing
 * isolation: with `nteract-frame://` iframes sharing one scheme
 * origin, sandbox-without-`allow-same-origin` is the only thing
 * keeping cell outputs from DOM-scripting each other and (on
 * WebView2/Windows) the only thing keeping `__TAURI__` out of reach.
 */

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../jsonrpc-transport", () => ({
  JsonRpcTransport: class {
    notify = vi.fn();
    start = vi.fn();
    stop = vi.fn();
    onNotification = vi.fn();
  },
}));

vi.mock("../frame-html", () => ({
  generateFrameHtml: vi.fn(() => "<!DOCTYPE html><html><body></body></html>"),
}));

vi.mock("../isolated-renderer-context", () => ({
  useIsolatedRenderer: () => ({
    rendererCode: undefined,
    rendererCss: undefined,
    isLoading: false,
    error: null,
  }),
}));

import { IsolatedFrame } from "../isolated-frame";

function renderedSandboxTokens(): string[] {
  const { container } = render(<IsolatedFrame darkMode />);
  const iframe = container.querySelector("iframe") as HTMLIFrameElement;
  expect(iframe).not.toBeNull();
  const sandbox = iframe.getAttribute("sandbox") ?? "";
  return sandbox.split(/\s+/).filter(Boolean);
}

describe("IsolatedFrame sandbox attribute (rendered DOM)", () => {
  it("does NOT grant allow-same-origin", () => {
    const tokens = renderedSandboxTokens();
    expect(tokens).not.toContain("allow-same-origin");
  });

  it("does NOT grant allow-popups", () => {
    expect(renderedSandboxTokens()).not.toContain("allow-popups");
  });

  it("does NOT grant allow-modals", () => {
    expect(renderedSandboxTokens()).not.toContain("allow-modals");
  });

  it("does NOT grant allow-top-navigation", () => {
    expect(renderedSandboxTokens()).not.toContain("allow-top-navigation");
  });

  it("does NOT grant allow-top-navigation-by-user-activation", () => {
    expect(renderedSandboxTokens()).not.toContain("allow-top-navigation-by-user-activation");
  });

  it("does NOT grant allow-presentation", () => {
    expect(renderedSandboxTokens()).not.toContain("allow-presentation");
  });

  it("grants allow-scripts (required for output rendering)", () => {
    expect(renderedSandboxTokens()).toContain("allow-scripts");
  });

  it("grants allow-downloads, allow-forms, allow-pointer-lock", () => {
    const tokens = renderedSandboxTokens();
    expect(tokens).toContain("allow-downloads");
    expect(tokens).toContain("allow-forms");
    expect(tokens).toContain("allow-pointer-lock");
  });

  it("only grants tokens that start with allow-", () => {
    expect(renderedSandboxTokens().every((t) => t.startsWith("allow-"))).toBe(true);
  });
});
