import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MarkdownCodeBlock } from "../MarkdownCodeBlock";

describe("MarkdownCodeBlock", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("renders the shared markdown code block affordance", () => {
    render(<MarkdownCodeBlock code="print('hi')" language="python" colorTheme="classic" />);

    expect(screen.getByText("python")).toHaveAttribute("title", "python code block");
    expect(screen.getByText("python")).toHaveClass("text-muted-foreground/80");
    expect(screen.getByText("python").closest('[data-slot="markdown-code-block"]')).toHaveClass(
      "border-l-2",
      "bg-muted/[0.14]",
    );
    expect(screen.getByText("python").closest("[data-code-language]")).toHaveAttribute(
      "data-code-language",
      "python",
    );
    expect(screen.getByRole("button", { name: "Copy code" })).toHaveClass(
      "inline-flex",
      "bg-transparent",
    );
    expect(screen.getByText("print")).toBeInTheDocument();
  });

  it("falls back to a plain code label without language metadata", () => {
    render(<MarkdownCodeBlock code="echo hello" colorTheme="classic" />);

    expect(screen.getByText("code")).toHaveAttribute("title", "Code block");
    expect(
      screen.getByText("code").closest('[data-slot="markdown-code-block"]'),
    ).not.toHaveAttribute("data-code-language");
  });

  it("can hide copy controls for read-only output contexts", () => {
    render(<MarkdownCodeBlock code="echo hello" colorTheme="classic" enableCopy={false} />);

    expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull();
  });

  it("copies the raw code text", async () => {
    render(<MarkdownCodeBlock code="print('copy me')" colorTheme="classic" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("print('copy me')");
  });
});
