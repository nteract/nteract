import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MarkdownOutput } from "../markdown-output";

describe("MarkdownOutput heading anchors", () => {
  const originalTop = Object.getOwnPropertyDescriptor(window, "top");
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");

  beforeEach(() => {
    Object.defineProperty(window, "top", {
      configurable: true,
      value: {},
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    if (originalTop) {
      Object.defineProperty(window, "top", originalTop);
    }
    if (originalMatchMedia) {
      Object.defineProperty(window, "matchMedia", originalMatchMedia);
    } else {
      delete (window as Partial<Window>).matchMedia;
    }
  });

  it("applies deterministic outline anchor ids to rendered markdown headings", () => {
    render(
      <MarkdownOutput
        content={"# Load data\n\n## Clean columns"}
        headingAnchors={[
          {
            itemId: "cell-a:heading:0",
            title: "Load data",
            level: 1,
            anchor: "load-data",
            headingAnchorId: "notebook-cell-cell-a-heading-load-data",
          },
          {
            itemId: "cell-a:heading:1",
            title: "Clean columns",
            level: 2,
            anchor: "clean-columns",
            headingAnchorId: "notebook-cell-cell-a-heading-clean-columns",
          },
        ]}
      />,
    );

    expect(screen.getByRole("heading", { name: "Load data" })).toHaveAttribute(
      "id",
      "notebook-cell-cell-a-heading-load-data",
    );
    expect(screen.getByRole("heading", { name: "Clean columns" })).toHaveAttribute(
      "data-nteract-outline-item-id",
      "cell-a:heading:1",
    );
  });
});
