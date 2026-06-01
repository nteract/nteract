import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { NotebookToolbarFrame } from "../NotebookToolbarFrame";

describe("NotebookToolbarFrame", () => {
  it("provides the shared sticky notebook toolbar frame", () => {
    const { container } = render(
      <NotebookToolbarFrame notices={<p>Syncing</p>}>
        <button type="button">Run</button>
      </NotebookToolbarFrame>,
    );

    const frame = container.querySelector("[data-slot='notebook-toolbar-frame']");
    expect(frame).toHaveClass("sticky");
    expect(frame).toHaveClass("top-0");
    expect(screen.getByRole("button", { name: "Run" })).toBeVisible();
    expect(screen.getByText("Syncing")).toBeVisible();
  });
});
