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

    fireEvent.click(screen.getByRole("button", { name: "Editing" }));

    expect(onModeChange).toHaveBeenCalledWith("edit");
  });
});
