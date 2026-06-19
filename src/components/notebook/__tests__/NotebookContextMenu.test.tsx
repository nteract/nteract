import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { NotebookContextMenu } from "../NotebookContextMenu";

describe("NotebookContextMenu", () => {
  it("opens target-specific actions from the context trigger", async () => {
    const onSelect = vi.fn();

    render(
      <NotebookContextMenu
        surface={{
          kind: "source",
          title: "Selected source range",
          description: "derivative = sp.diff(f, x)",
          detail: "Cell 4 - line 12",
        }}
        groups={[
          {
            id: "comment",
            actions: [
              {
                id: "add-comment",
                label: "Add comment",
                description: "Anchor a discussion to this source range.",
                shortcut: "C",
                onSelect,
              },
            ],
          },
        ]}
      >
        <button type="button">Forecast cell</button>
      </NotebookContextMenu>,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Forecast cell" }));

    expect(await screen.findByText("source")).toBeInTheDocument();
    expect(screen.getByText("Selected source range")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Add comment/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: /Add comment/ }));

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("keeps disabled actions visible but unavailable", async () => {
    render(
      <NotebookContextMenu
        surface={{ kind: "package", title: "sympy >= 1.13" }}
        groups={[
          {
            id: "edit",
            actions: [
              {
                id: "remove-package",
                label: "Remove dependency",
                disabled: true,
                destructive: true,
              },
            ],
          },
        ]}
      >
        <button type="button">Package row</button>
      </NotebookContextMenu>,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Package row" }));

    expect(await screen.findByRole("menuitem", { name: "Remove dependency" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("can render actions without a surface header", async () => {
    render(
      <NotebookContextMenu
        groups={[
          {
            id: "clipboard",
            actions: [{ id: "copy", label: "Copy" }],
          },
        ]}
      >
        <button type="button">Editor</button>
      </NotebookContextMenu>,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Editor" }));

    expect(await screen.findByRole("menuitem", { name: "Copy" })).toBeInTheDocument();
    expect(screen.queryByText("source")).not.toBeInTheDocument();
  });
});
