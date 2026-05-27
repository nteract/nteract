import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const styleCss = readFileSync("src/style.css", "utf8");

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
});
