import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const styleCss = readFileSync("src/library.css", "utf8");

describe("Sift stylesheet", () => {
  it("lets vertical wheel gestures chain at table boundaries", () => {
    expect(styleCss).toMatch(/overscroll-behavior-x:\s*contain;/);
    expect(styleCss).toMatch(/overscroll-behavior-y:\s*auto;/);
  });

  it("themes the WebKit scrollbar corner with the table surface", () => {
    expect(styleCss).toMatch(
      /\.sift-viewport::-webkit-scrollbar-corner\s*\{\s*background:\s*var\(--sift-bg\);\s*\}/,
    );
  });

  it("keeps a short scope badge on narrow footers instead of hiding the scope", () => {
    expect(styleCss).toMatch(/\.sift-preview-scope-short\s*\{\s*display:\s*none;\s*\}/);
    const narrow = styleCss.match(/@media \(max-width: 700px\)\s*\{([\s\S]*?)\n\}/);
    expect(narrow?.[1]).toMatch(/\.sift-preview-scope-full\s*\{\s*display:\s*none;\s*\}/);
    expect(narrow?.[1]).toMatch(/\.sift-preview-scope-short\s*\{\s*display:\s*inline;\s*\}/);
    expect(narrow?.[1]).not.toMatch(/\.sift-preview-scope\s*\{/);
  });

  it("gives truncated preview text a shrinkable block container", () => {
    // Ellipsis does not apply to a plain inline span, even with overflow set.
    expect(styleCss).toMatch(
      /\.sift-preview-hint\s*\{[^}]*display:\s*inline-block;[^}]*text-overflow:\s*ellipsis;/s,
    );
  });
});
