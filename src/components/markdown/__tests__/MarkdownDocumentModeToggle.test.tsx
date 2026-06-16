import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { MarkdownDocumentModeToggle } from "../MarkdownDocumentModeToggle";

describe("MarkdownDocumentModeToggle", () => {
  it("switches from view to edit when editing is available", () => {
    const onModeChange = vi.fn();

    render(<MarkdownDocumentModeToggle mode="view" canEdit onModeChange={onModeChange} />);

    expect(screen.getByRole("group", { name: "Markdown document mode" })).toHaveAttribute(
      "data-slot",
      "markdown-document-mode-toggle",
    );
    expect(screen.getByRole("button", { name: "View" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(onModeChange).toHaveBeenCalledWith("edit");
  });

  it("does not emit an event for the current mode", () => {
    const onModeChange = vi.fn();

    render(<MarkdownDocumentModeToggle mode="edit" canEdit onModeChange={onModeChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("keeps edit disabled for read-only collaborators", () => {
    const onModeChange = vi.fn();

    render(<MarkdownDocumentModeToggle mode="view" canEdit={false} onModeChange={onModeChange} />);

    const editButton = screen.getByRole("button", { name: "Edit" });
    expect(editButton).toBeDisabled();
    expect(editButton).toHaveAttribute("title", "Editing requires edit access");

    fireEvent.click(editButton);

    expect(onModeChange).not.toHaveBeenCalled();
  });
});
