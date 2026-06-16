import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { DocumentTitle } from "../DocumentTitle";

describe("DocumentTitle", () => {
  it("starts title editing from the title text itself", () => {
    const onRename = vi.fn().mockResolvedValue(true);

    render(
      <DocumentTitle
        canRename
        renameTitle="Existing"
        title={{ label: "Existing", detail: null, title: "Existing" }}
        onRename={onRename}
      />,
    );

    const titleNode = screen.getByRole("button", { name: "Existing" });
    fireEvent.click(titleNode);

    expect(screen.getByRole("textbox", { name: "Document title" })).toBe(titleNode);
    expect(onRename).not.toHaveBeenCalled();
  });

  it("starts title editing from the keyboard on the title text", () => {
    const onRename = vi.fn().mockResolvedValue(true);

    render(
      <DocumentTitle
        canRename
        renameTitle="Existing"
        title={{ label: "Existing", detail: null, title: "Existing" }}
        onRename={onRename}
      />,
    );

    const titleNode = screen.getByRole("button", { name: "Existing" });
    fireEvent.keyDown(titleNode, { key: "Enter" });

    expect(screen.getByRole("textbox", { name: "Document title" })).toBe(titleNode);
    expect(onRename).not.toHaveBeenCalled();
  });

  it("renames from an inline contenteditable title field", async () => {
    const onRename = vi.fn().mockResolvedValue(true);

    render(
      <DocumentTitle
        canRename
        renameTitle="Existing"
        title={{ label: "Existing", detail: null, title: "Existing" }}
        onRename={onRename}
      />,
    );

    const titleNode = screen.getByText("Existing");
    fireEvent.click(screen.getByRole("button", { name: "Rename Existing" }));

    const editable = screen.getByRole("textbox", { name: "Document title" });
    expect(editable).toBe(titleNode);
    expect(editable).toHaveAttribute("contenteditable", "true");
    expect(editable).not.toHaveAttribute("aria-disabled");

    editable.textContent = "Renamed";
    fireEvent.input(editable);
    fireEvent.keyDown(editable, { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("Renamed");
    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Document title" })).toBeNull();
    });
  });

  it("closes inline title editing immediately when rename saves synchronously", () => {
    const onRename = vi.fn().mockReturnValue(true);

    render(
      <DocumentTitle
        canRename
        renameTitle="Existing"
        title={{ label: "Existing", detail: null, title: "Existing" }}
        onRename={onRename}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Existing" }));

    const editable = screen.getByRole("textbox", { name: "Document title" });
    editable.textContent = "Renamed";
    fireEvent.input(editable);
    fireEvent.keyDown(editable, { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("Renamed");
    expect(screen.queryByRole("textbox", { name: "Document title" })).toBeNull();
  });

  it("cancels inline title editing with Escape", () => {
    const onRename = vi.fn();

    render(
      <DocumentTitle
        canRename
        renameTitle="Existing"
        title={{ label: "Existing", detail: null, title: "Existing" }}
        onRename={onRename}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename Existing" }));

    const editable = screen.getByRole("textbox", { name: "Document title" });
    editable.textContent = "Discarded";
    fireEvent.input(editable);
    fireEvent.keyDown(editable, { key: "Escape" });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Document title" })).toBeNull();
    expect(screen.getByText("Existing")).toBeVisible();
  });
});
