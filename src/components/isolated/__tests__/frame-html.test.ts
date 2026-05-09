/**
 * Tests for frame-html.ts HTML generation.
 *
 * Pin the load-bearing invariants of the iframe shell document:
 * 1. CSP meta tag is present and blocks nested iframes (defense in depth
 *    behind the response header from the Tauri scheme handler).
 * 2. Source-side message validation against `window.parent` is intact.
 * 3. Static HTML structure renders neutral defaults so theme-arrival
 *    over postMessage isn't a visible flash.
 *
 * The opaque-origin isolation guarantee comes from the host iframe's
 * sandbox attribute (asserted in `isolated-frame.test.ts`), not from
 * anything in this generated document.
 */

import { beforeAll, describe, expect, it } from "vite-plus/test";
import { generateFrameHtml } from "../frame-html";

describe("generateFrameHtml", () => {
  let html: string;

  beforeAll(() => {
    html = generateFrameHtml();
  });

  it("generates a valid HTML document", () => {
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
    expect(html).toContain("<head>");
    expect(html).toContain("</head>");
    expect(html).toContain("<body>");
    expect(html).toContain("</body>");
  });

  it("includes a Content-Security-Policy meta tag", () => {
    expect(html).toContain('http-equiv="Content-Security-Policy"');
  });

  it("blocks nested iframes via the meta CSP", () => {
    // Defense in depth — the Rust scheme handler sets the same directive
    // on the response header. Either alone is sufficient.
    expect(html).toContain("frame-src 'none'");
    expect(html).toContain("child-src 'none'");
  });

  it("includes a viewport meta tag", () => {
    expect(html).toContain('name="viewport"');
  });

  /**
   * SECURITY: the bootstrap message handler must reject any message
   * whose source isn't `window.parent`. This blocks spoofed messages
   * from siblings or popups even if they could reach this frame.
   */
  it("validates event.source on every postMessage", () => {
    expect(html).toContain("event.source !== window.parent");
  });

  it("registers a window message listener", () => {
    expect(html).toContain("addEventListener");
    expect(html).toContain("message");
  });

  it("emits the legacy 'ready' bootstrap signal on load", () => {
    expect(html).toContain("sendLegacy('ready'");
    expect(html).toContain("postMessage");
  });

  it("forwards wheel deltas when the iframe scroll reaches a boundary", () => {
    expect(html).toContain("document.addEventListener('wheel'");
    expect(html).toContain("isWheelAtScrollBoundary");
    expect(html).toContain("e.preventDefault()");
    expect(html).toContain("sendRpc('nteract/wheelBoundary'");
    expect(html).toContain("passive: false");
  });

  it("uses neutral dark-mode defaults so theme-arrival doesn't flash", () => {
    // The bootstrap is parameter-less; theme cascades via CSS overrides
    // on `[data-theme="light"]` and `[data-color-theme="cream"]` after
    // the parent's `nteract/theme` postMessage applies the attributes.
    expect(html).toContain("--bg-primary: transparent");
    expect(html).toContain("--bg-secondary: #1a1a1a");
    expect(html).toContain("--text-primary: #e0e0e0");
    expect(html).toContain("--border-color: #333333");
    expect(html).toContain("--accent-color: #3b82f6");
  });

  it("declares the cream theme override block", () => {
    expect(html).toContain('[data-color-theme="cream"]');
    expect(html).toContain("--output-document-font: KaTeX_Main, Georgia, 'Times New Roman', serif");
    expect(html).toContain("--accent-color: #d4896a");
  });

  it("declares light-mode CSS variable overrides", () => {
    expect(html).toContain('[data-theme="light"]');
  });

  it("ships document typography selectors for markdown and html outputs", () => {
    expect(html).toContain('[data-slot="markdown-output"], [data-slot="html-output"]');
    expect(html).toContain(':is([data-slot="markdown-output"], [data-slot="html-output"]) h3');
    expect(html).toContain(':is([data-slot="markdown-output"], [data-slot="html-output"]) table');
    expect(html).toContain(':is([data-slot="markdown-output"], [data-slot="html-output"]) button');
    expect(html).toContain("font-family: var(--output-document-font)");
    expect(html).toContain("font-family: var(--output-mono-font)");
  });

  it("does not embed an inline-script SHA-256 hash", () => {
    // The hash dependency went away when iframes moved off blob: — the
    // bootstrap now runs under the iframe's own CSP, served from the
    // `nteract-frame://` URI scheme. Re-introducing a parent-side hash
    // would mean the iframe is back to inheriting parent CSP, which is
    // the bug we're fixing.
    expect(html).not.toMatch(/sha256-[A-Za-z0-9+/]+=?/);
  });
});
