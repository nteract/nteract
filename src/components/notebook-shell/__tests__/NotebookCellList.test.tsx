import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { NotebookCellList } from "../NotebookCellList";
import type { NotebookViewCell } from "../view-model";

const cells: NotebookViewCell[] = [
  {
    id: "intro",
    cellType: "markdown",
    source: "# Intro",
    language: null,
    executionId: null,
    executionCount: null,
    outputs: [],
    metadata: {},
  },
  {
    id: "code-1",
    cellType: "code",
    source: "print('ok')",
    language: "python",
    executionId: "exec-1",
    executionCount: 1,
    outputs: [],
    metadata: {},
  },
];

describe("NotebookCellList", () => {
  it("renders host-provided cells through a shared notebook body frame", () => {
    const { container } = render(
      <NotebookCellList
        cells={cells}
        slot="hosted-cells"
        renderCell={(cell) => (
          <article data-testid="cell" data-cell-id={cell.id}>
            {cell.source}
          </article>
        )}
      />,
    );

    const list = screen.getByLabelText("Notebook cells");
    expect(list).toHaveAttribute("data-slot", "hosted-cells");
    expect(list).toHaveAttribute("data-cell-count", "2");
    expect(container.querySelectorAll("[data-testid='cell']")).toHaveLength(2);
    expect(screen.getByText("# Intro")).toBeVisible();
    expect(screen.getByText("print('ok')")).toBeVisible();
  });

  it("renders host-provided empty content for empty documents", () => {
    render(
      <NotebookCellList
        cells={[]}
        emptyContent={<p>No cells</p>}
        renderCell={(cell) => <article>{cell.source}</article>}
      />,
    );

    expect(screen.getByText("No cells")).toBeVisible();
  });

  it("lets read-only hosts keep duplicate cell ids renderable for malformed imported notebooks", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(
        <NotebookCellList
          cells={[
            { ...cells[0], id: "duplicate", source: "# First" },
            { ...cells[1], id: "duplicate", source: "print('second')" },
          ]}
          keyForCell={(cell, index) => `${cell.id}:${index}`}
          renderCell={(cell) => <article>{cell.source}</article>}
        />,
      );

      expect(screen.getByText("# First")).toBeVisible();
      expect(screen.getByText("print('second')")).toBeVisible();
      expect(
        consoleError.mock.calls.some((args) =>
          String(args[0]).includes("Encountered two children with the same key"),
        ),
      ).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });
});
