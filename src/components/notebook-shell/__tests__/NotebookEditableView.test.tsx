import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { NotebookEditableView } from "../NotebookEditableView";
import type { NotebookViewModel } from "../view-model";

const viewModel: Pick<NotebookViewModel, "cells"> = {
  cells: [
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
    {
      id: "raw-1",
      cellType: "raw",
      source: "raw body",
      language: null,
      executionId: null,
      executionCount: null,
      outputs: [],
      metadata: {},
    },
  ],
};

describe("NotebookEditableView", () => {
  it("routes view-model cells through host-provided editable renderers", () => {
    render(
      <NotebookEditableView
        viewModel={viewModel}
        slot="host-editable-cells"
        scrollable
        renderMarkdownCell={(cell) => <article>markdown:{cell.source}</article>}
        renderCodeCell={(cell) => <article>code:{cell.source}</article>}
        renderFallbackCell={(cell) => <article>fallback:{cell.source}</article>}
      />,
    );

    expect(screen.getByLabelText("Notebook cells")).toHaveAttribute(
      "data-slot",
      "host-editable-cells",
    );
    expect(screen.getByLabelText("Notebook cells")).toHaveClass("overflow-y-auto");
    expect(screen.getByText("markdown:# Intro")).toBeVisible();
    expect(screen.getByText("code:print('ok')")).toBeVisible();
    expect(screen.getByText("fallback:raw body")).toBeVisible();
  });

  it("keeps host error rendering at the shared cell-list boundary", () => {
    render(
      <NotebookEditableView
        viewModel={viewModel}
        renderMarkdownCell={() => <ThrowingCell />}
        renderCodeCell={(cell) => <article>{cell.source}</article>}
        renderFallbackCell={(cell) => <article>{cell.source}</article>}
        renderCellError={(error, _cell, index) => (
          <p>
            cell {index + 1}: {error.message}
          </p>
        )}
      />,
    );

    expect(screen.getByText("cell 1: markdown failed")).toBeVisible();
    expect(screen.getByText("print('ok')")).toBeVisible();
  });
});

function ThrowingCell() {
  throw new Error("markdown failed");
}
