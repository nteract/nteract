// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CodeCell as CodeCellType } from "../../types";

let mockOutputs: unknown[] = [];
let mockExecution: {
  execution_count: number | null;
  submitted_by_actor_label?: string | null;
} | null = null;
let mockIsExecuting = false;
let mockIsFocused = false;
let mockIsQueued = false;
const mockEditorBlur = vi.fn();

vi.mock("@/components/cell/CellContainer", () => ({
  CellContainer: ({
    codeContent,
    outputContent,
    outputRightGutterContent,
    outputFocused,
    outputDimmed,
  }: {
    codeContent?: React.ReactNode;
    outputContent?: React.ReactNode;
    outputRightGutterContent?: React.ReactNode;
    outputFocused?: boolean;
    outputDimmed?: boolean;
  }) => (
    <div data-output-dimmed={String(outputDimmed)} data-output-focused={String(outputFocused)}>
      {codeContent}
      {outputContent}
      {outputRightGutterContent}
    </div>
  ),
}));

vi.mock("@/components/cell/OutputArea", () => ({
  anyOutputNeedsIsolation: () => true,
  OutputArea: ({
    focused,
    useOutputWell,
    onIframeMouseDown,
  }: {
    focused?: boolean;
    useOutputWell?: boolean;
    onIframeMouseDown?: () => void;
  }) => (
    <button
      data-focused={String(focused)}
      data-use-output-well={String(useOutputWell)}
      data-testid="output"
      type="button"
      onMouseDown={onIframeMouseDown}
    >
      output
    </button>
  ),
}));

vi.mock("@/components/editor/codemirror-editor", async () => {
  const React = await import("react");

  const CodeMirrorEditor = React.forwardRef(function CodeMirrorEditor(_props, ref) {
    React.useImperativeHandle(ref, () => ({
      focus: vi.fn(),
      setCursorPosition: vi.fn(),
      getEditor: () => ({
        contentDOM: {
          blur: mockEditorBlur,
        },
      }),
    }));

    return <div data-testid="editor" />;
  });

  return { CodeMirrorEditor };
});

vi.mock("@/components/editor/remote-cursors", () => ({
  remoteCursorsExtension: () => [],
}));

vi.mock("@/components/editor/search-highlight", () => ({
  searchHighlight: () => [],
}));

vi.mock("@/components/editor/text-attribution", () => ({
  textAttributionExtension: () => [],
}));

vi.mock("../../contexts/PresenceContext", () => ({
  usePresenceContext: () => null,
}));

vi.mock("../../hooks/useCellKeyboardNavigation", () => ({
  useCellKeyboardNavigation: () => [],
}));

vi.mock("../../hooks/useCrdtBridge", () => ({
  useCrdtBridge: () => ({ extension: [], bridge: { replaceSource: vi.fn() } }),
}));

vi.mock("../../lib/cell-ui-state", () => ({
  useIsCellExecuting: () => mockIsExecuting,
  useIsCellFocused: () => mockIsFocused,
  useIsCellQueued: () => mockIsQueued,
  useIsGroupExecuting: () => false,
  useIsNextCellFromFocused: () => false,
  useIsPreviousCellFromFocused: () => false,
  useSearchActiveOffset: () => null,
  useSearchQuery: () => "",
}));

vi.mock("../../lib/cursor-registry", () => ({
  onEditorRegistered: vi.fn(),
  onEditorUnregistered: vi.fn(),
}));

vi.mock("../../lib/editor-registry", () => ({
  registerCellEditor: vi.fn(),
  unregisterCellEditor: vi.fn(),
}));

vi.mock("../../lib/kernel-completion", () => ({
  kernelCompletionExtension: [],
}));

vi.mock("../../lib/notebook-executions", () => ({
  useCellExecutionId: () => (mockExecution ? "execution-1" : null),
  useExecution: () => mockExecution,
}));

vi.mock("../../lib/notebook-outputs", () => ({
  useCellOutputs: () => mockOutputs,
}));

vi.mock("../../lib/open-url", () => ({
  openUrl: vi.fn(),
}));

vi.mock("../../lib/presence-sender", () => ({
  presenceSenderExtension: () => [],
}));

vi.mock("../../lib/tab-completion", () => ({
  tabCompletionKeymap: [],
}));

vi.mock("../cell/CellPresenceIndicators", () => ({
  CellPresenceIndicators: () => null,
}));

import { CodeCell } from "../CodeCell";

function makeCell(overrides: Partial<CodeCellType> = {}): CodeCellType {
  return {
    cell_type: "code",
    execution_count: null,
    id: "code-1",
    source: "import polars as pl\n\npl.DataFrame({'x': [1]})",
    metadata: {},
    outputs: [],
    ...overrides,
  };
}

describe("CodeCell output focus", () => {
  beforeEach(() => {
    mockExecution = null;
    mockIsExecuting = false;
    mockIsFocused = false;
    mockIsQueued = false;
    mockOutputs = [
      {
        output_type: "display_data",
        data: { "application/vnd.plotly.v1+json": { data: [], layout: {} } },
        metadata: {},
      },
    ];
    mockEditorBlur.mockClear();
  });

  it("blurs the editor before marking the cell focused from iframe output interaction", () => {
    const onFocus = vi.fn();

    const { getByTestId } = render(
      <CodeCell
        cell={makeCell()}
        onFocus={onFocus}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onDelete={() => {}}
        onToggleOutputsHidden={() => {}}
      />,
    );

    fireEvent.mouseDown(getByTestId("output"));

    expect(mockEditorBlur).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(mockEditorBlur.mock.invocationCallOrder[0]).toBeLessThan(
      onFocus.mock.invocationCallOrder[0],
    );
  });

  it("passes output focus through to the output area", () => {
    const { getByTestId } = render(
      <CodeCell
        cell={makeCell()}
        outputFocused
        onFocus={() => {}}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onDelete={() => {}}
        onToggleOutputsHidden={() => {}}
      />,
    );

    expect(getByTestId("output").getAttribute("data-focused")).toBe("true");
  });

  it("labels completed execution state with readable footer language", () => {
    mockOutputs = [];
    mockExecution = { execution_count: 12, submitted_by_actor_label: null };

    const { container } = render(
      <CodeCell
        cell={makeCell()}
        onFocus={() => {}}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onDelete={() => {}}
      />,
    );

    const footer = container.querySelector('[data-slot="code-cell-current-line"]');

    expect(footer?.getAttribute("data-execution-label")).toBe("Execution 12");
    expect(footer?.textContent?.replace(/\s+/g, "")).toContain("Python·Run12·completed");
    expect(footer?.textContent).not.toContain("In [12]");
  });

  it("keeps running status active while the stop control carries danger", () => {
    mockOutputs = [];
    mockExecution = { execution_count: null, submitted_by_actor_label: null };
    mockIsExecuting = true;

    const { container, getByTestId } = render(
      <CodeCell
        cell={makeCell()}
        onFocus={() => {}}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onDelete={() => {}}
      />,
    );

    const footer = container.querySelector('[data-slot="code-cell-current-line"]');
    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');
    const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');
    const stopButton = getByTestId("execute-button");

    expect(footer?.getAttribute("data-execution-state")).toBe("running");
    expect(status?.textContent).toBe("Python·Running");
    expect(status).toHaveClass("text-primary");
    expect(status).not.toHaveClass("text-destructive/80");
    expect(rule).toHaveClass("bg-primary/45");
    expect(stopButton).toHaveClass("text-destructive");
  });

  it("keeps idle footer language quiet until the cell is engaged", () => {
    mockOutputs = [];
    mockExecution = null;

    const { container } = render(
      <CodeCell
        cell={makeCell()}
        onFocus={() => {}}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onDelete={() => {}}
      />,
    );

    const footer = container.querySelector('[data-slot="code-cell-current-line"]');
    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');
    const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');

    expect(footer?.getAttribute("data-execution-state")).toBe("idle");
    expect(status?.textContent).toBe("Python·Ready");
    expect(status).toHaveClass("max-w-0");
    expect(status).toHaveClass("opacity-0");
    expect(status).toHaveClass("group-hover:max-w-64");
    expect(rule).toHaveClass("bg-border/25");
  });

  it("uses compact current-line chrome for empty idle code cells", () => {
    mockOutputs = [];
    mockExecution = null;
    mockIsFocused = true;

    const { container } = render(
      <CodeCell
        cell={makeCell({ source: "" })}
        onFocus={() => {}}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onDelete={() => {}}
      />,
    );

    const footer = container.querySelector('[data-slot="code-cell-current-line"]');
    const detail = container.querySelector('[data-slot="code-cell-current-line-detail"]');
    const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');

    expect(footer).toHaveClass("min-h-5");
    expect(detail).toHaveClass("sr-only");
    expect(rule).toBeNull();
  });

  it("shows idle footer language when the cell is focused", () => {
    mockOutputs = [];
    mockExecution = null;
    mockIsFocused = true;

    const { container } = render(
      <CodeCell
        cell={makeCell()}
        onFocus={() => {}}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onDelete={() => {}}
      />,
    );

    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');

    expect(status?.textContent).toBe("Python·Ready");
    expect(status).toHaveClass("max-w-64");
    expect(status).toHaveClass("opacity-100");
    expect(status).not.toHaveClass("max-w-0");
  });

  it("keeps the current line visible when source is hidden but output remains visible", () => {
    mockOutputs = [
      {
        output_type: "stream",
        name: "stdout",
        text: "visible output\n",
      },
    ];
    mockExecution = { execution_count: 4, submitted_by_actor_label: null };

    const { container, queryByTestId } = render(
      <CodeCell
        cell={makeCell({ metadata: { jupyter: { source_hidden: true } } })}
        onFocus={() => {}}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onDelete={() => {}}
        onToggleSourceHidden={() => {}}
      />,
    );

    const footer = container.querySelector('[data-slot="code-cell-current-line"]');

    expect(queryByTestId("editor")).toBeNull();
    expect(footer?.textContent?.replace(/\s+/g, "")).toContain("Python·Run4·completed");
  });

  it("omits output chrome for short stream output", () => {
    mockOutputs = [
      {
        output_type: "stream",
        name: "stdout",
        text: "hey\n",
      },
    ];

    const { getByTestId, queryByLabelText, queryByTitle } = render(
      <CodeCell
        cell={makeCell()}
        onFocus={() => {}}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onDelete={() => {}}
        onToggleOutputsHidden={() => {}}
      />,
    );

    expect(getByTestId("output").getAttribute("data-use-output-well")).toBe("false");
    expect(queryByLabelText("Output mode")).toBeNull();
    expect(queryByTitle("Hide outputs")).toBeTruthy();
  });

  it("keeps output chrome for rich output without layout mode controls", () => {
    const { getByTestId, queryByLabelText, getByTitle } = render(
      <CodeCell
        cell={makeCell()}
        onFocus={() => {}}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onDelete={() => {}}
        onToggleOutputsHidden={() => {}}
      />,
    );

    expect(getByTestId("output").getAttribute("data-use-output-well")).toBe("true");
    expect(queryByLabelText("Output mode")).toBeNull();
    expect(getByTitle("Hide outputs")).toBeTruthy();
  });

  it("keeps output chrome for a single sift table without layout mode controls", () => {
    mockOutputs = [
      {
        output_type: "display_data",
        data: { "application/vnd.apache.parquet": "blob://df" },
        metadata: {},
      },
    ];

    const { getByTestId, queryByLabelText, queryByTitle } = render(
      <CodeCell
        cell={makeCell()}
        onFocus={() => {}}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onDelete={() => {}}
        onToggleOutputsHidden={() => {}}
      />,
    );

    expect(getByTestId("output").getAttribute("data-use-output-well")).toBe("true");
    expect(queryByLabelText("Output mode")).toBeNull();
    expect(queryByTitle("Hide outputs")).toBeTruthy();
  });

  it("does not show layout mode controls while output-focused", () => {
    const { queryByTitle } = render(
      <CodeCell
        cell={makeCell()}
        outputFocused
        onFocus={() => {}}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(queryByTitle("Constrain output height")).toBeNull();
    expect(queryByTitle("Expand output")).toBeNull();
  });
});
