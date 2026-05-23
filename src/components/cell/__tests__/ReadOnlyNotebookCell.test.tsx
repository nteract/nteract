import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ReadOnlyNotebookCell } from "../ReadOnlyNotebookCell";
import type { JupyterOutput } from "../jupyter-output";

const outputAreaCalls = vi.hoisted(() => ({
  outputs: [] as unknown[],
}));

vi.mock("../OutputArea", () => ({
  OutputArea: ({
    cellId,
    className,
    executionCount,
    focused,
    hostContext,
    outputs,
    priority,
  }: {
    cellId?: string;
    className?: string;
    executionCount?: number | null;
    focused?: boolean;
    hostContext?: unknown;
    outputs: JupyterOutput[];
    priority?: readonly string[];
  }) => {
    outputAreaCalls.outputs.push(outputs);
    return (
      <div
        data-cell-id={cellId}
        data-class-name={className ?? ""}
        data-execution-count={executionCount ?? ""}
        data-focused={String(focused)}
        data-host-context={JSON.stringify(hostContext ?? null)}
        data-mimes={outputs
          .flatMap((output) =>
            output.output_type === "display_data" || output.output_type === "execute_result"
              ? Object.keys(output.data)
              : [output.output_type],
          )
          .join(",")}
        data-priority={priority?.join(",") ?? ""}
        data-testid="output-area"
      />
    );
  },
}));

vi.mock("@/components/editor/readonly-codemirror", () => ({
  ReadOnlyCodeMirror: ({
    className,
    language,
    lineWrapping,
    value,
  }: {
    className?: string;
    language?: string;
    lineWrapping?: boolean;
    value: string;
  }) => (
    <pre
      className={className}
      data-language={language}
      data-line-wrapping={String(lineWrapping)}
      data-testid="readonly-codemirror"
    >
      {value}
    </pre>
  ),
}));

describe("ReadOnlyNotebookCell", () => {
  beforeEach(() => {
    outputAreaCalls.outputs.length = 0;
  });

  it("renders code through shared cell chrome with execution count and outputs", () => {
    render(
      <ReadOnlyNotebookCell
        id="cell-code"
        cellType="code"
        source="print('hello')"
        language="ipython"
        executionCount={7}
        outputs={[
          {
            output_type: "stream",
            name: "stdout",
            text: "hello\n",
          },
        ]}
        priority={["text/plain"]}
        hostContext={{
          nteract: {
            rendererAssetsBaseUrl: "https://assets.example.test/renderer-assets/",
          },
        }}
        className="cloud-cell"
        sourceClassName="cloud-source"
        outputClassName="cloud-output"
      />,
    );

    const container = document.querySelector('[data-slot="cell-container"]');
    expect(container).toHaveAttribute("data-cell-id", "cell-code");
    expect(container).toHaveAttribute("data-cell-type", "code");
    expect(container).toHaveClass("cloud-cell");

    expect(screen.getByTestId("readonly-codemirror")).toHaveTextContent("print('hello')");
    expect(screen.getByTestId("readonly-codemirror")).toHaveAttribute("data-language", "ipython");
    expect(screen.getByTestId("readonly-codemirror")).toHaveAttribute("data-line-wrapping", "true");
    expect(screen.getByTestId("readonly-codemirror")).toHaveClass("cloud-source");

    expect(screen.getByText("[7]:")).toHaveAttribute("data-slot", "execution-count");
    expect(screen.getByTestId("output-area")).toHaveAttribute("data-cell-id", "cell-code");
    expect(screen.getByTestId("output-area")).toHaveAttribute("data-execution-count", "7");
    expect(screen.getByTestId("output-area")).toHaveAttribute("data-focused", "false");
    expect(screen.getByTestId("output-area")).toHaveAttribute("data-mimes", "stream");
    expect(screen.getByTestId("output-area")).toHaveAttribute("data-priority", "text/plain");
    expect(screen.getByTestId("output-area")).toHaveAttribute("data-class-name", "cloud-output");
    expect(screen.getByTestId("output-area").getAttribute("data-host-context")).toContain(
      "https://assets.example.test/renderer-assets/",
    );
  });

  it("renders markdown source as a notebook output without code execution chrome", () => {
    render(
      <ReadOnlyNotebookCell
        id="cell-markdown"
        cellType="markdown"
        source="## Title"
        outputs={[]}
        priority={["text/markdown", "text/plain"]}
        sourceClassName="markdown-source"
      />,
    );

    expect(document.querySelector('[data-slot="execution-count"]')).toBeNull();
    expect(screen.queryByTestId("readonly-codemirror")).toBeNull();

    const outputArea = screen.getByTestId("output-area");
    expect(outputArea).toHaveAttribute("data-cell-id", "cell-markdown");
    expect(outputArea).toHaveAttribute("data-mimes", "text/markdown");
    expect(outputArea).toHaveAttribute("data-priority", "text/markdown,text/plain");
    expect(outputArea).toHaveAttribute("data-class-name", "pl-0 pr-0 markdown-source");
  });

  it("omits the output row for code cells with no outputs", () => {
    render(<ReadOnlyNotebookCell id="empty-code" cellType="code" source="x = 1" outputs={[]} />);

    expect(screen.getByTestId("readonly-codemirror")).toHaveTextContent("x = 1");
    expect(screen.queryByTestId("output-area")).toBeNull();
  });

  it("keeps code output props stable across unrelated parent rerenders", () => {
    const outputs: JupyterOutput[] = [{ output_type: "stream", name: "stdout", text: "visible\n" }];
    const { rerender } = render(
      <ReadOnlyNotebookCell
        id="stable-code"
        cellType="code"
        source="print('x')"
        outputs={outputs}
      />,
    );

    const firstOutputs = outputAreaCalls.outputs.at(-1);

    rerender(
      <ReadOnlyNotebookCell
        id="stable-code"
        cellType="code"
        source="print('x')"
        outputs={outputs}
      />,
    );

    expect(outputAreaCalls.outputs.at(-1)).toBe(firstOutputs);
  });

  it("renders report cells without notebook gutter chrome and can focus outputs", () => {
    render(
      <ReadOnlyNotebookCell
        id="report-code"
        cellType="code"
        source="print('hidden')"
        showSource={false}
        displayMode="report"
        focusOutputs
        outputs={[{ output_type: "stream", name: "stdout", text: "visible\n" }]}
      />,
    );

    expect(document.querySelector('[data-slot="cell-container"]')).toBeNull();
    const reportCell = document.querySelector('[data-slot="read-only-report-cell"]');
    expect(reportCell).toHaveAttribute("data-cell-id", "report-code");
    expect(reportCell).toHaveAttribute("data-cell-type", "code");
    expect(screen.queryByTestId("readonly-codemirror")).toBeNull();
    expect(document.querySelector('[data-slot="execution-count"]')).toBeNull();
    expect(document.querySelector('[data-slot="read-only-cell-source"]')).toBeNull();
    expect(document.querySelector('[data-slot="read-only-cell-output"]')).not.toBeNull();
    expect(screen.getByTestId("output-area")).toHaveAttribute("data-focused", "true");
  });
});
