import { describe, expect, it, vi } from "vite-plus/test";
import { render as renderMermaid } from "pele";
import { mountMermaid, sanitizeMermaidSvg } from "../mermaid-renderer";

describe("Mermaid SVG admission", () => {
  it("removes active markup, external resources, and page-level CSS", () => {
    const result = sanitizeMermaidSvg(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert(1)</script><style>body{display:none}</style>
      <foreignObject><iframe src="https://example.com"></iframe></foreignObject>
      <a href="javascript:alert(1)"><text>link label</text></a>
      <image href="https://example.com/image"/><use href="https://example.com/icon#x"/>
      <rect style="position:fixed;fill:#123456;stroke:url(https://example.com/paint);opacity:0.5" onmouseover="alert(1)"/>
      <path fill="url(https://example.com/paint)"/>
      <animate attributeName="href" values="javascript:alert(1)"/>
    </svg>`);
    expect(
      result.querySelector("script, style, foreignObject, iframe, a, image, use, animate"),
    ).toBeNull();
    expect(result.querySelector("[onload], [onmouseover], [href]")).toBeNull();
    expect(result.querySelector("rect")?.getAttribute("style")).toContain("fill: #123456");
    expect(result.querySelector("rect")?.getAttribute("style")).not.toMatch(/position|url/);
    expect(result.querySelector("path")?.hasAttribute("fill")).toBe(false);
  });

  it("preserves Pele geometry, theme variables, accessible titles, and class styling", () => {
    // jsdom has no canvas; Pele falls back to its built-in text metrics.
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    try {
      const { svg } = renderMermaid(
        "flowchart LR\naccTitle: Notebook flow\nA[Start] --> B[Done]\nclassDef highlight fill:#dbeafe,stroke:#2563eb\nclass B highlight",
      );
      const result = sanitizeMermaidSvg(svg);
      expect(result.querySelector("svg")?.getAttribute("viewBox")).toBeTruthy();
      expect(result.querySelector("svg")?.getAttribute("style")).toContain("--_fg");
      expect(result.querySelector("title")?.textContent).toBe("Notebook flow");
      expect(result.querySelectorAll("path").length).toBeGreaterThan(0);
      expect(result.querySelector(".highlight rect")?.getAttribute("style")).toContain("#dbeafe");
    } finally {
      context.mockRestore();
    }
  });

  it("rejects oversized source before mounting it", () => {
    const element = document.createElement("div");
    document.body.append(element);
    try {
      expect(() =>
        mountMermaid(element, "flowchart LR\n" + "A".repeat(50_001), "limits", {}),
      ).toThrow();
      expect(element.querySelector("svg")).toBeNull();
    } finally {
      element.remove();
    }
  });
});
