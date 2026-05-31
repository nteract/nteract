import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ReadOnlyNotebook } from "../ReadOnlyNotebook";
import type { JupyterOutput } from "../jupyter-output";

const throwAttempts = vi.hoisted(() => ({ count: 0 }));

vi.mock("../ReadOnlyNotebookCell", () => ({
  ReadOnlyNotebookCell: ({
    cellType,
    className,
    displayMode,
    executionCount,
    focusOutputs,
    hostContext,
    id,
    language,
    lineWrapping,
    onNavigateToTracebackCell,
    outputClassName,
    outputs,
    priority,
    resolveTracebackExecutionTarget,
    showSource,
    source,
    sourceClassName,
  }: {
    cellType: string;
    className?: string;
    displayMode?: "notebook" | "report";
    executionCount?: number | null;
    focusOutputs?: boolean;
    hostContext?: unknown;
    id: string;
    language?: string | null;
    lineWrapping?: boolean;
    onNavigateToTracebackCell?: unknown;
    outputClassName?: string;
    outputs?: readonly JupyterOutput[];
    priority?: readonly string[];
    resolveTracebackExecutionTarget?: unknown;
    showSource?: boolean;
    source: string;
    sourceClassName?: string;
  }) => {
    if (id === "throws") {
      throwAttempts.count += 1;
      throw new Error("boom");
    }

    return (
      <article
        data-cell-type={cellType}
        data-class-name={className ?? ""}
        data-display-mode={displayMode ?? "notebook"}
        data-execution-count={executionCount ?? ""}
        data-focus-outputs={String(focusOutputs)}
        data-host-context={JSON.stringify(hostContext ?? null)}
        data-language={language ?? ""}
        data-line-wrapping={String(lineWrapping)}
        data-has-traceback-navigator={String(Boolean(onNavigateToTracebackCell))}
        data-has-traceback-resolver={String(Boolean(resolveTracebackExecutionTarget))}
        data-output-class-name={outputClassName ?? ""}
        data-output-count={outputs?.length ?? 0}
        data-priority={priority?.join(",") ?? ""}
        data-show-source={String(showSource)}
        data-source-class-name={sourceClassName ?? ""}
        data-testid="read-only-cell"
      >
        {id}:{source}
      </article>
    );
  },
}));

describe("ReadOnlyNotebook", () => {
  beforeEach(() => {
    throwAttempts.count = 0;
  });

  it("renders read-only notebook cells through the shared cell surface", () => {
    render(
      <ReadOnlyNotebook
        cells={[
          {
            id: "cell-1",
            cellType: "code",
            source: "print('hello')",
            language: "ipython",
            executionCount: 3,
            outputs: [{ output_type: "stream", name: "stdout", text: "hello\n" }],
          },
          {
            id: "cell-2",
            cellType: "markdown",
            source: "# Title",
          },
        ]}
        priority={["application/vnd.apache.parquet", "text/plain"]}
        hostContext={{
          nteract: {
            rendererAssetsBaseUrl: "https://assets.example.test/renderer-assets/",
          },
        }}
        className="notebook-shell"
        scrollable
        cellClassName="cell-shell"
        sourceClassName="source-shell"
        outputClassName="output-shell"
      />,
    );

    const notebook = document.querySelector('[data-slot="read-only-notebook"]');
    expect(notebook).toHaveAttribute("aria-label", "Notebook cells");
    expect(notebook).toHaveAttribute("data-cell-count", "2");
    expect(notebook).toHaveClass("notebook-shell");
    expect(notebook).toHaveClass("overflow-y-auto");

    const cells = screen.getAllByTestId("read-only-cell");
    expect(cells).toHaveLength(2);
    expect(cells[0]).toHaveTextContent("cell-1:print('hello')");
    expect(cells[0]).toHaveAttribute("data-cell-type", "code");
    expect(cells[0]).toHaveAttribute("data-display-mode", "notebook");
    expect(cells[0]).toHaveAttribute("data-language", "ipython");
    expect(cells[0]).toHaveAttribute("data-line-wrapping", "true");
    expect(cells[0]).toHaveAttribute("data-execution-count", "3");
    expect(cells[0]).toHaveAttribute("data-show-source", "true");
    expect(cells[0]).toHaveAttribute("data-focus-outputs", "false");
    expect(cells[0]).toHaveAttribute("data-output-count", "1");
    expect(cells[0]).toHaveAttribute("data-class-name", "cell-shell");
    expect(cells[0]).toHaveAttribute("data-source-class-name", "source-shell");
    expect(cells[0]).toHaveAttribute("data-output-class-name", "output-shell");
    expect(cells[0]).toHaveAttribute("data-priority", "application/vnd.apache.parquet,text/plain");
    expect(cells[0].getAttribute("data-host-context")).toContain(
      "https://assets.example.test/renderer-assets/",
    );
  });

  it("passes traceback resolver and navigator to read-only cells", () => {
    render(
      <ReadOnlyNotebook
        cells={[
          {
            id: "cell-1",
            cellType: "code",
            source: "raise Exception()",
            outputs: [{ output_type: "error", ename: "E", evalue: "bad", traceback: [] }],
          },
        ]}
        resolveTracebackExecutionTarget={() => null}
        onNavigateToTracebackCell={() => undefined}
      />,
    );

    expect(screen.getByTestId("read-only-cell")).toHaveAttribute(
      "data-has-traceback-resolver",
      "true",
    );
    expect(screen.getByTestId("read-only-cell")).toHaveAttribute(
      "data-has-traceback-navigator",
      "true",
    );
  });

  it("allows read-only source wrapping to be disabled", () => {
    render(
      <ReadOnlyNotebook
        cells={[
          {
            id: "cell-1",
            cellType: "code",
            source: "x = 1",
          },
        ]}
        lineWrapping={false}
      />,
    );

    expect(screen.getByTestId("read-only-cell")).toHaveAttribute("data-line-wrapping", "false");
  });

  it("supports report display mode with local code visibility", () => {
    render(
      <ReadOnlyNotebook
        cells={[
          {
            id: "code-cell",
            cellType: "code",
            source: "print('hidden')",
            outputs: [{ output_type: "stream", name: "stdout", text: "visible\n" }],
          },
          {
            id: "markdown-cell",
            cellType: "markdown",
            source: "# Still visible",
          },
        ]}
        displayMode="report"
        showCode={false}
        focusOutputs
      />,
    );

    const cells = screen.getAllByTestId("read-only-cell");
    expect(cells[0]).toHaveAttribute("data-display-mode", "report");
    expect(cells[0]).toHaveAttribute("data-show-source", "false");
    expect(cells[0]).toHaveAttribute("data-focus-outputs", "true");
    expect(cells[1]).toHaveAttribute("data-display-mode", "report");
    expect(cells[1]).toHaveAttribute("data-show-source", "true");
  });

  it("supports notebook display mode with local code visibility", () => {
    render(
      <ReadOnlyNotebook
        cells={[
          {
            id: "code-cell",
            cellType: "code",
            source: "print('hidden')",
            outputs: [{ output_type: "stream", name: "stdout", text: "visible\n" }],
          },
          {
            id: "markdown-cell",
            cellType: "markdown",
            source: "# Still visible",
          },
        ]}
        showCode={false}
      />,
    );

    const cells = screen.getAllByTestId("read-only-cell");
    expect(cells[0]).toHaveAttribute("data-display-mode", "notebook");
    expect(cells[0]).toHaveAttribute("data-show-source", "false");
    expect(cells[1]).toHaveAttribute("data-display-mode", "notebook");
    expect(cells[1]).toHaveAttribute("data-show-source", "true");
  });

  it("does not reset errored cells when unchanged cell data is remapped", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const output = { output_type: "stream", name: "stdout", text: "hi\n" } as const;
    try {
      const { rerender } = render(
        <ReadOnlyNotebook
          cells={[
            {
              id: "throws",
              cellType: "code",
              source: "raise Exception()",
              outputs: [output],
            },
          ]}
        />,
      );

      expect(screen.getByText("Unable to render cell 1: boom")).toBeInTheDocument();
      const initialThrowAttempts = throwAttempts.count;
      expect(initialThrowAttempts).toBeGreaterThan(0);

      rerender(
        <ReadOnlyNotebook
          cells={[
            {
              id: "throws",
              cellType: "code",
              source: "raise Exception()",
              outputs: [{ ...output }],
            },
          ]}
        />,
      );
      expect(throwAttempts.count).toBe(initialThrowAttempts);

      rerender(
        <ReadOnlyNotebook
          cells={[{ id: "throws", cellType: "code", source: "raise RuntimeError()" }]}
        />,
      );
      expect(throwAttempts.count).toBeGreaterThan(initialThrowAttempts);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("renders custom empty and cell-error content", () => {
    const { rerender } = render(
      <ReadOnlyNotebook cells={[]} emptyContent={<div>No cells yet</div>} />,
    );

    expect(screen.getByText("No cells yet")).toBeInTheDocument();

    rerender(
      <ReadOnlyNotebook
        cells={[{ id: "throws", cellType: "code", source: "raise Exception()" }]}
        renderCellError={(error, _cell, index) => (
          <div>
            Cell {index + 1}: {error.message}
          </div>
        )}
      />,
    );

    expect(screen.getByText("Cell 1: boom")).toBeInTheDocument();
  });
});
