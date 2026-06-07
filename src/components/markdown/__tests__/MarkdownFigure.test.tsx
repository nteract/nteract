import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { MarkdownFigure, MarkdownFigureCaption, MarkdownImage } from "../MarkdownFigure";

describe("MarkdownFigure", () => {
  it("renders the shared document image and caption treatment", () => {
    render(
      <MarkdownFigure>
        <MarkdownImage src="attachment:plot.png" alt="Residual topology sketch" />
        <MarkdownFigureCaption>Residual topology sketch</MarkdownFigureCaption>
      </MarkdownFigure>,
    );

    expect(screen.getByRole("figure")).toHaveClass("my-5");
    expect(screen.getByRole("img", { name: "Residual topology sketch" })).toHaveClass(
      "rounded-sm",
      "border",
      "shadow-sm",
    );
    expect(screen.getByText("Residual topology sketch")).toHaveClass(
      "font-[var(--output-ui-font)]",
      "text-xs",
      "text-muted-foreground",
    );
  });
});
