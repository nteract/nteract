import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { NotebookEditModeButton } from "../NotebookEditModeButton";

describe("NotebookEditModeButton", () => {
  it("requests edit mode from view mode", () => {
    const onModeChange = vi.fn();

    render(<NotebookEditModeButton mode="view" state="viewing" onModeChange={onModeChange} />);

    const button = screen.getByRole("button", { name: "Edit" });
    expect(button).toHaveAttribute("data-slot", "notebook-edit-mode-button");
    expect(button).toHaveAttribute("data-state", "viewing");
    expect(button).toHaveAttribute("title", "Switch to edit mode");

    fireEvent.click(button);

    expect(onModeChange).toHaveBeenCalledWith("edit");
  });

  it("returns to view mode from an active edit request", () => {
    const onModeChange = vi.fn();

    render(<NotebookEditModeButton mode="edit" state="editing" onModeChange={onModeChange} />);

    const button = screen.getByRole("button", { name: "View" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveAttribute("data-state", "editing");

    fireEvent.click(button);

    expect(onModeChange).toHaveBeenCalledWith("view");
  });

  it("can render a segmented mode control", () => {
    const onModeChange = vi.fn();

    render(
      <NotebookEditModeButton
        mode="view"
        state="viewing"
        variant="segmented"
        onModeChange={onModeChange}
      />,
    );

    const group = screen.getByRole("group", { name: "Notebook interaction mode" });
    expect(group).toHaveAttribute("data-slot", "notebook-edit-mode-button");
    expect(group).toHaveAttribute("data-variant", "segmented");
    expect(screen.getByRole("button", { name: "Viewing" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Editing" })).toHaveAttribute(
      "title",
      "Switch to edit mode",
    );

    fireEvent.click(screen.getByRole("button", { name: "Editing" }));

    expect(onModeChange).toHaveBeenCalledWith("edit");
  });

  it("can render host-specific segmented edit copy", () => {
    const onModeChange = vi.fn();

    render(
      <NotebookEditModeButton
        mode="view"
        state="viewing"
        variant="segmented"
        editLabel="Request edit"
        editTitle="Request edit access"
        onModeChange={onModeChange}
      />,
    );

    expect(screen.getByRole("button", { name: "Request edit" })).toHaveAttribute(
      "title",
      "Request edit access",
    );

    fireEvent.click(screen.getByRole("button", { name: "Request edit" }));

    expect(onModeChange).toHaveBeenCalledWith("edit");
  });

  it("does not reapply the already selected segmented mode", () => {
    const onModeChange = vi.fn();

    render(
      <NotebookEditModeButton
        mode="view"
        state="viewing"
        variant="segmented"
        onModeChange={onModeChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Viewing" }));

    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("labels a segmented edit request as sent until edit access is active", () => {
    const onModeChange = vi.fn();

    render(
      <NotebookEditModeButton
        mode="edit"
        state="requested"
        variant="segmented"
        onModeChange={onModeChange}
      />,
    );

    const group = screen.getByRole("group", { name: "Notebook interaction mode" });
    expect(group).toHaveAttribute("data-state", "requested");
    expect(screen.getByRole("button", { name: "Request sent" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Request sent" })).toHaveAttribute(
      "title",
      "Edit access requested",
    );

    fireEvent.click(screen.getByRole("button", { name: "Viewing" }));

    expect(onModeChange).toHaveBeenCalledWith("view");
  });

  it("accepts host-specific pending edit copy", () => {
    const onModeChange = vi.fn();

    render(
      <NotebookEditModeButton
        mode="edit"
        state="requested"
        variant="segmented"
        requestedEditLabel="Offline"
        requestedEditTitle="Offline while the room reconnects"
        onModeChange={onModeChange}
      />,
    );

    expect(screen.getByRole("button", { name: "Offline" })).toHaveAttribute(
      "title",
      "Offline while the room reconnects",
    );
  });

  it("accepts document-specific segmented labels and edit disabled state", () => {
    const onModeChange = vi.fn();

    render(
      <NotebookEditModeButton
        ariaLabel="Markdown document mode"
        dataSlot="markdown-document-mode-toggle"
        editDisabled
        editLabel="Edit"
        editTitle="Editing requires edit access"
        mode="view"
        state="viewing"
        variant="segmented"
        viewSegmentLabel="View"
        viewTitle="View Markdown"
        onModeChange={onModeChange}
      />,
    );

    const group = screen.getByRole("group", { name: "Markdown document mode" });
    expect(group).toHaveAttribute("data-slot", "markdown-document-mode-toggle");
    expect(screen.getByRole("button", { name: "View" })).toHaveAttribute("title", "View Markdown");
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(onModeChange).not.toHaveBeenCalled();
  });
});
