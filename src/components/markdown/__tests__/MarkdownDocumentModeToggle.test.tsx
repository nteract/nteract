import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  MarkdownDocumentModeToggle,
  MarkdownDocumentRepresentationToolbar,
} from "../MarkdownDocumentModeToggle";

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

describe("MarkdownDocumentRepresentationToolbar", () => {
  const options = [
    {
      id: "rendered" as const,
      label: "Rendered",
      title: "Show rendered Markdown",
      disabled: false,
    },
    {
      id: "source" as const,
      label: "Source",
      title: "Inspect Markdown source",
      disabled: false,
    },
    {
      id: "split" as const,
      label: "Split",
      title: "Side-by-side source and rendered Markdown is planned",
      disabled: true,
    },
  ];

  it("switches Markdown body representation", () => {
    const onRepresentationChange = vi.fn();

    render(
      <MarkdownDocumentRepresentationToolbar
        active="rendered"
        options={options}
        onRepresentationChange={onRepresentationChange}
      />,
    );

    expect(screen.getByRole("group", { name: "Markdown representation" })).toHaveAttribute(
      "data-slot",
      "markdown-document-representation-toolbar",
    );
    expect(screen.getByRole("button", { name: "Rendered" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Source" }));

    expect(onRepresentationChange).toHaveBeenCalledWith("source");
  });

  it("leaves planned split mode disabled", () => {
    const onRepresentationChange = vi.fn();

    render(
      <MarkdownDocumentRepresentationToolbar
        active="source"
        options={options}
        onRepresentationChange={onRepresentationChange}
      />,
    );

    const splitButton = screen.getByRole("button", { name: "Split" });
    expect(splitButton).toBeDisabled();
    expect(splitButton).toHaveAttribute(
      "title",
      "Side-by-side source and rendered Markdown is planned",
    );

    fireEvent.click(splitButton);

    expect(onRepresentationChange).not.toHaveBeenCalled();
  });
});
