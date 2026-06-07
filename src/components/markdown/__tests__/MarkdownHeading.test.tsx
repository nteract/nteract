import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { MarkdownHeading, markdownHeadingElement } from "../MarkdownHeading";

describe("MarkdownHeading", () => {
  it("renders shared heading rhythm and permalink anchors", () => {
    render(
      <MarkdownHeading anchorHref="#claim" anchorLabel="Link to Claim" element="h2" id="claim">
        Claim
      </MarkdownHeading>,
    );

    expect(screen.getByRole("heading", { level: 2, name: /Claim/ })).toHaveClass(
      "group/markdown-heading",
      "text-2xl",
      "font-semibold",
    );
    expect(screen.getByRole("link", { name: "Link to Claim" })).toHaveAttribute("href", "#claim");
    expect(screen.getByRole("link", { name: "Link to Claim" })).toHaveClass(
      "text-muted-foreground/40",
      "hover:text-primary",
    );
  });

  it("normalizes unknown projected heading elements to h6", () => {
    expect(markdownHeadingElement("h1")).toBe("h1");
    expect(markdownHeadingElement("aside")).toBe("h6");
  });
});
