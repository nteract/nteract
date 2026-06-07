import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { MarkdownTaskCheckbox, MarkdownTaskContent } from "../MarkdownTask";

describe("MarkdownTask", () => {
  it("renders read-only task checkboxes with shared document styling", () => {
    render(<MarkdownTaskCheckbox checked />);

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeDisabled();
    expect(checkbox).toHaveClass("sr-only");
    expect(document.querySelector('[data-slot="markdown-task-checkbox"]')).toHaveClass(
      "inline-grid",
      "place-items-center",
    );
    expect(document.querySelector('[data-slot="markdown-task-checkbox"] span')).toHaveClass(
      "bg-primary",
      "text-primary-foreground",
    );
  });

  it("exposes interactive task checkboxes with action labels", () => {
    const onToggle = vi.fn();
    render(<MarkdownTaskCheckbox checked={false} label="Compare candidate" onToggle={onToggle} />);

    const checkbox = screen.getByRole("checkbox", {
      name: "Mark task complete: Compare candidate",
    });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toBeEnabled();

    fireEvent.click(checkbox);

    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("softens completed task content", () => {
    render(<MarkdownTaskContent checked>Reproduce baseline</MarkdownTaskContent>);

    expect(screen.getByText("Reproduce baseline")).toHaveClass(
      "leading-relaxed",
      "text-muted-foreground",
    );
  });
});
