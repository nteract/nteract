// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  applyMcpAppContainerDimensions,
  applyMcpAppHostDocumentContext,
} from "../host-document-context";

function rootElement() {
  return document.createElement("html");
}

describe("MCP app host document context", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.cssText = "";
  });

  it("maps fixed host container dimensions to viewport-filling root styles", () => {
    const root = rootElement();

    applyMcpAppContainerDimensions({ height: 320, width: 640 }, root);

    expect(root.style.height).toBe("100vh");
    expect(root.style.width).toBe("100vw");
    expect(root.style.maxHeight).toBe("");
    expect(root.style.maxWidth).toBe("");
  });

  it("maps flexible host container dimensions to root max constraints", () => {
    const root = rootElement();

    applyMcpAppContainerDimensions({ maxHeight: 480, maxWidth: 720 }, root);

    expect(root.style.maxHeight).toBe("480px");
    expect(root.style.maxWidth).toBe("720px");
    expect(root.style.height).toBe("");
    expect(root.style.width).toBe("");
  });

  it("clears stale dimension styles when host dimensions become unbounded", () => {
    const root = rootElement();
    root.style.height = "100vh";
    root.style.maxHeight = "400px";
    root.style.width = "100vw";
    root.style.maxWidth = "600px";

    applyMcpAppContainerDimensions(undefined, root);

    expect(root.style.height).toBe("");
    expect(root.style.maxHeight).toBe("");
    expect(root.style.width).toBe("");
    expect(root.style.maxWidth).toBe("");
  });

  it("applies host theme, style variables, and container dimensions together", () => {
    const root = document.documentElement;

    applyMcpAppHostDocumentContext(
      {
        theme: "dark",
        styles: {
          variables: {
            "--color-text-primary": "rgb(1, 2, 3)",
          },
        },
        containerDimensions: {
          maxHeight: 512,
          width: 900,
        },
      },
      root,
    );

    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    expect(root.style.getPropertyValue("--color-text-primary")).toBe("rgb(1, 2, 3)");
    expect(root.style.maxHeight).toBe("512px");
    expect(root.style.width).toBe("100vw");
  });
});
