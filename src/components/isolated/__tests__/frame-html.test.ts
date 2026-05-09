/**
 * Tests for frame-html.ts HTML generation.
 *
 * These tests verify:
 * 1. Generated HTML has proper structure
 * 2. CSP meta tag is present
 * 3. Message handler validates source
 */

import { beforeAll, describe, expect, it } from "vite-plus/test";
import { generateFrameHtml } from "../frame-html";

describe("generateFrameHtml", () => {
  let html: string;

  beforeAll(() => {
    html = generateFrameHtml();
  });

  it("generates valid HTML document", () => {
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
    expect(html).toContain("<head>");
    expect(html).toContain("</head>");
    expect(html).toContain("<body>");
    expect(html).toContain("</body>");
  });

  it("includes Content-Security-Policy meta tag", () => {
    expect(html).toContain('http-equiv="Content-Security-Policy"');
  });

  it("includes viewport meta tag", () => {
    expect(html).toContain('name="viewport"');
  });

  it("blocks nested frames from cell output", () => {
    expect(html).toContain("frame-src 'none'");
  });

  it("keeps worker policy explicit when child-src is none", () => {
    expect(html).toContain("child-src 'none'");
    expect(html).toContain("worker-src 'self' blob:");
  });

  /**
   * SECURITY: Message handler must validate event.source.
   * This prevents accepting messages from windows other than the parent.
   */
  it("message handler validates event.source", () => {
    // The handler should check event.source === window.parent
    expect(html).toContain("event.source !== window.parent");
  });

  it("sets up ready message listener", () => {
    expect(html).toContain("addEventListener");
    expect(html).toContain("message");
  });

  it("sends ready message on load", () => {
    // Ready uses legacy format (bootstrap signal before JSON-RPC transport exists)
    expect(html).toContain("sendLegacy('ready'");
    expect(html).toContain("postMessage");
  });

  it("forwards wheel deltas when iframe scroll reaches a boundary", () => {
    expect(html).toContain("document.addEventListener('wheel'");
    expect(html).toContain("isWheelAtScrollBoundary");
    expect(html).toContain("e.preventDefault()");
    expect(html).toContain("sendRpc('nteract/wheelBoundary'");
    expect(html).toContain("passive: false");
  });

  it("keeps the iframe bootstrap script parseable", () => {
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];

    expect(script).toBeDefined();
    expect(() => new Function(script ?? "")).not.toThrow();
  });

  it("renders text/plain without the obsolete ANSI fallback", () => {
    expect(html).toContain("pre.textContent = String(data)");
    expect(html).not.toContain("parseAnsi");
    expect(html).not.toContain("pre.innerHTML = parseAnsi");
  });

  describe("neutral defaults", () => {
    it("bakes neutral dark defaults before theme sync arrives", () => {
      expect(html).toContain("--bg-primary: transparent");
      expect(html).toContain("--bg-secondary: #1a1a1a");
      expect(html).toContain("--text-primary: #e0e0e0");
      expect(html).toContain("--text-secondary: #a0a0a0");
      expect(html).toContain("--border-color: #333333");
    });

    it("ships document typography for markdown and html outputs", () => {
      expect(html).toContain(
        "--output-document-font: KaTeX_Main, Georgia, 'Times New Roman', serif",
      );
      expect(html).toContain('[data-slot="markdown-output"], [data-slot="html-output"]');
      expect(html).toContain(':is([data-slot="markdown-output"], [data-slot="html-output"]) h3');
      expect(html).toContain(':is([data-slot="markdown-output"], [data-slot="html-output"]) table');
      expect(html).toContain(
        ':is([data-slot="markdown-output"], [data-slot="html-output"]) button',
      );
      expect(html).toContain("font-family: var(--output-mono-font)");
      expect(html).toContain("--output-document-font: var(--output-ui-font)");
    });
  });
});
