import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { NotebookReadOnlyView } from "../NotebookReadOnlyView";
import type { NotebookViewModel } from "../view-model";

vi.mock("@/components/cell/ReadOnlyNotebook", () => ({
  ReadOnlyNotebook: ({
    cells,
    label,
  }: {
    cells: readonly { id: string; source: string }[];
    label?: string;
  }) => (
    <section aria-label={label ?? "Notebook cells"} data-cell-count={cells.length}>
      {cells.map((cell) => (
        <article key={cell.id}>{cell.source}</article>
      ))}
    </section>
  ),
}));

describe("NotebookReadOnlyView", () => {
  it("renders read-only cells from the shared notebook view model", () => {
    const viewModel: Pick<NotebookViewModel, "readOnlyCells"> = {
      readOnlyCells: [
        {
          id: "intro",
          cellType: "markdown",
          source: "# Intro",
          language: null,
          outputs: [],
          executionId: null,
          executionCount: null,
        },
      ],
    };

    render(<NotebookReadOnlyView viewModel={viewModel} label="Hosted cells" />);

    expect(screen.getByLabelText("Hosted cells")).toHaveAttribute("data-cell-count", "1");
    expect(screen.getByText("# Intro")).toBeVisible();
  });
});
