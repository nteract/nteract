import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import {
  MarkdownBlockquote,
  MarkdownDelete,
  MarkdownEmphasis,
  MarkdownInlineCode,
  MarkdownStrong,
} from "../MarkdownText";

describe("MarkdownText", () => {
  it("renders shared blockquote styling", () => {
    render(<MarkdownBlockquote>Document claim</MarkdownBlockquote>);

    expect(screen.getByText("Document claim")).toHaveClass(
      "border-l-2",
      "border-foreground/35",
      "italic",
    );
  });

  it("renders shared inline semantic text styling", () => {
    render(
      <p>
        <MarkdownStrong>important</MarkdownStrong>
        <MarkdownEmphasis>paper margin</MarkdownEmphasis>
        <MarkdownDelete>removed</MarkdownDelete>
        <MarkdownInlineCode>seed=13</MarkdownInlineCode>
      </p>,
    );

    expect(screen.getByText("important")).toHaveClass("font-semibold", "text-foreground");
    expect(screen.getByText("paper margin")).toHaveClass("italic", "text-foreground");
    expect(screen.getByText("removed")).toHaveClass("decoration-destructive/55");
    expect(screen.getByText("seed=13")).toHaveClass(
      "border",
      "bg-muted/70",
      "[font-family:var(--output-mono-font)]",
    );
  });
});
