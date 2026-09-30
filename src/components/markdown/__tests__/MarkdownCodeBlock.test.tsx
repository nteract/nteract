import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MarkdownCodeBlock } from "../MarkdownCodeBlock";

describe("MarkdownCodeBlock", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (document as Partial<Document>).execCommand;
  });
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

  it("copies selected code in a sandboxed frame and restores focus and selection", async () => {
    vi.stubGlobal("self", {});
    const code = "# café\nprint('copy me')";
    const execCommand = vi.fn(() => {
      const textarea = document.querySelector("textarea");
      expect(textarea?.value).toBe(code);
      expect(textarea?.selectionStart).toBe(0);
      expect(textarea?.selectionEnd).toBe(code.length);
      return true;
    });
    document.execCommand = execCommand;
    render(
      <>
        <p>Keep this selection</p>
        <MarkdownCodeBlock code={code} colorTheme="classic" />
      </>,
    );
    const button = screen.getByRole("button", { name: "Copy code" });
    button.focus();
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("Keep this selection"));
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    fireEvent.click(button);

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(document.querySelector("textarea")).toBeNull();
    expect(button).toHaveFocus();
    expect(window.getSelection()?.toString()).toBe("Keep this selection");
    expect(await screen.findByRole("button", { name: "Copied code" })).toBeVisible();
  });

  it("uses the Clipboard API if the frame copy command fails", async () => {
    vi.stubGlobal("self", {});
    document.execCommand = vi.fn(() => false);
    render(<MarkdownCodeBlock code="print('fallback')" colorTheme="classic" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("print('fallback')");
    expect(document.querySelector("textarea")).toBeNull();
    expect(await screen.findByRole("button", { name: "Copied code" })).toBeVisible();
  });
});
