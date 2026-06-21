import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { InlineCommentComposer } from "../InlineCommentComposer";

const rect = { left: 20, top: 40, right: 120, bottom: 60 };

describe("InlineCommentComposer", () => {
  it("does not render the selected source as a quote preview", () => {
    const { container } = render(
      <InlineCommentComposer
        rect={rect}
        quote="sp.diff(f, x)"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.querySelector("blockquote")).toBeNull();
    expect(screen.queryByText("sp.diff(f, x)")).toBeNull();
  });

  it("keeps submit disabled until the body has content", () => {
    render(<InlineCommentComposer rect={rect} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    const submit = screen.getByRole("button", { name: "Comment" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Comment on selection"), {
      target: { value: "looks off" },
    });
    expect(submit).toBeEnabled();
  });

  it("submits the trimmed body", () => {
    const onSubmit = vi.fn();
    render(<InlineCommentComposer rect={rect} onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Comment on selection"), {
      target: { value: "  needs a docstring  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(onSubmit).toHaveBeenCalledWith("needs a docstring");
  });

  it("submits on Cmd/Ctrl+Enter", () => {
    const onSubmit = vi.fn();
    render(<InlineCommentComposer rect={rect} onSubmit={onSubmit} onCancel={vi.fn()} />);
    const textarea = screen.getByLabelText("Comment on selection");
    fireEvent.change(textarea, { target: { value: "ship it" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledWith("ship it");
  });

  it("restores focus to the previously focused element when it unmounts", () => {
    const previousFocus = document.createElement("button");
    previousFocus.textContent = "Editor";
    document.body.appendChild(previousFocus);
    previousFocus.focus();

    try {
      const { unmount } = render(
        <InlineCommentComposer rect={rect} onSubmit={vi.fn()} onCancel={vi.fn()} />,
      );

      expect(screen.getByLabelText("Comment on selection")).toHaveFocus();

      unmount();

      expect(previousFocus).toHaveFocus();
    } finally {
      previousFocus.remove();
    }
  });

  it("cancels on Escape without submitting", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<InlineCommentComposer rect={rect} onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByLabelText("Comment on selection"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables input when read-only", () => {
    render(<InlineCommentComposer rect={rect} disabled onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText("Comment on selection")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Comment" })).toBeDisabled();
  });
});
