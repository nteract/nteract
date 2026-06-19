// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CodeCell as CodeCellType } from "../../types";

let mockOutputs: unknown[] = [];
let mockExecution: {
  execution_count: number | null;
  submitted_by_actor_label?: string | null;
  status?: string;
  success?: boolean | null;
} | null = null;
let mockIsExecuting = false;
let mockIsFocused = false;
let mockIsQueued = false;
let mockQueuePriority = 0;
const mockEditorBlur = vi.fn();

vi.mock("@/components/cell/CellContainer", () => ({
  CellContainer: ({
    codeContent,
    gutterContent,
    outputContent,
    outputRightGutterContent,
    outputFocused,
    outputDimmed,
    hideOutput,
  }: {
    codeContent?: React.ReactNode;
    gutterContent?: React.ReactNode;
    outputContent?: React.ReactNode;
    outputRightGutterContent?: React.ReactNode;
    outputFocused?: boolean;
    outputDimmed?: boolean;
    hideOutput?: boolean;
  }) => (
    <div data-output-dimmed={String(outputDimmed)} data-output-focused={String(outputFocused)}>
      {gutterContent}
      {codeContent}
      {hideOutput ? null : outputContent}
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
    preloadIframe,
    deferIsolatedFrameUntilVisible,
    deferredIsolatedFrameRootMargin,
  }: {
    focused?: boolean;
    useOutputWell?: boolean;
    onIframeMouseDown?: () => void;
    preloadIframe?: boolean;
    deferIsolatedFrameUntilVisible?: boolean;
    deferredIsolatedFrameRootMargin?: string;
  }) => (
    <button
      data-focused={String(focused)}
      data-preload-iframe={String(preloadIframe)}
      data-defer-isolated-frame={String(deferIsolatedFrameUntilVisible)}
      data-deferred-root-margin={deferredIsolatedFrameRootMargin ?? ""}
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

vi.mock("@/components/notebook/state/cell-ui-state", () => ({
  useCellQueuePriority: () => mockQueuePriority,
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
  getCellEditor: vi.fn(() => null),
}));

vi.mock("../../lib/kernel-completion", () => ({
  kernelCompletionExtension: [],
  useKernelCompletionExtension: () => [],
}));

vi.mock("@/components/notebook/state/execution-store", () => ({
  useCellExecutionId: () => (mockExecution ? "execution-1" : null),
  useExecution: () => mockExecution,
}));

vi.mock("@/components/notebook/state/output-store", () => ({
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
    mockQueuePriority = 0;
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

  it("can defer isolated output frames instead of preloading them", () => {
    const { getByTestId } = render(
      <CodeCell
        cell={makeCell()}
        deferOutputIsolatedFrameUntilVisible
        deferredOutputIsolatedFrameRootMargin="400px 0px"
        onFocus={() => {}}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onDelete={() => {}}
        onToggleOutputsHidden={() => {}}
      />,
    );

    const output = getByTestId("output");
    expect(output.getAttribute("data-preload-iframe")).toBe("false");
    expect(output.getAttribute("data-defer-isolated-frame")).toBe("true");
    expect(output.getAttribute("data-deferred-root-margin")).toBe("400px 0px");
  });

  it("keeps completed execution state in the stable right readout slot", () => {
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
    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');
    const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');

    expect(footer?.getAttribute("data-execution-label")).toBe("Execution 12");
    expect(footer?.textContent?.replace(/\s+/g, "")).toContain("Python/run12");
    expect(footer?.textContent).not.toContain("In [12]");
    expect(status).toHaveClass("max-w-64");
    expect(status).toHaveClass("opacity-100");
    expect(container.querySelector('[data-slot="code-cell-current-line-detail"]')).toHaveClass(
      "max-w-0",
    );
    expect(status).toHaveAttribute("aria-label", "Python: Run 12 completed");
    expect(rule).toHaveClass("flex-1");
  });

  it("keeps fast running status visually quiet while the stop control carries danger", () => {
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
    const detail = container.querySelector('[data-slot="code-cell-current-line-detail"]');
    const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');
    const stopButton = getByTestId("execute-button");

    expect(footer?.getAttribute("data-execution-state")).toBe("running");
    expect(footer?.getAttribute("data-execution-visual-state")).toBe("idle");
    expect(status?.textContent).toBe("Python/ready");
    expect(status).toHaveAttribute("aria-label", "Python: Running");
    expect(detail).toHaveClass("text-muted-foreground/70");
    expect(detail).not.toHaveClass("text-emerald-700");
    expect(status).not.toHaveClass("text-destructive/80");
    expect(rule).toHaveClass("bg-border/15");
    expect(rule?.compareDocumentPosition(status as Element)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(rule).not.toHaveAttribute("data-execution-signal");
    expect(rule?.querySelector("svg")).toBeNull();
    expect(stopButton).toHaveClass("text-destructive");
  });

  it("uses the error boundary when the latest execution failed", () => {
    mockOutputs = [];
    mockExecution = { execution_count: 14, submitted_by_actor_label: null, success: false };

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
    const runButton = getByTestId("execute-button");

    expect(footer?.getAttribute("data-execution-state")).toBe("error");
    expect(status?.textContent).toBe("Python/failed");
    expect(rule).toHaveClass("text-destructive/60");
    expect(runButton).toHaveAttribute("data-execution-state", "error");
    expect(runButton).toHaveAttribute("aria-label", "Run cell again; last execution 14 failed");
  });

  it("keeps the error boundary visible without an execution count", () => {
    mockOutputs = [];
    mockExecution = { execution_count: null, submitted_by_actor_label: null, success: false };

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
    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');
    const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');

    expect(footer?.getAttribute("data-execution-state")).toBe("error");
    expect(status?.textContent).toBe("Python/failed");
    expect(rule).toHaveClass("text-destructive/60");
  });

  it("keeps idle footer language in the stable right readout slot", () => {
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
    expect(status?.textContent).toBe("Python/ready");
    expect(status).toHaveClass("max-w-64");
    expect(status).toHaveClass("opacity-100");
    expect(rule).toHaveClass("bg-border/15");
    expect(rule).toHaveClass("flex-1");
  });

  it("uses compact current-line chrome for empty idle code cells", () => {
    mockOutputs = [];
    mockExecution = null;
    mockIsFocused = true;

    const { container, getByTestId } = render(
      <CodeCell
        cell={makeCell({ source: "" })}
        onFocus={() => {}}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onDelete={() => {}}
      />,
    );

    const footer = container.querySelector('[data-slot="code-cell-current-line"]');

    expect(footer).toBeNull();
    expect(getByTestId("execute-button")).toHaveAttribute("aria-label", "Run cell");
  });

  it("keeps current-line metadata for empty cells after execution state appears", () => {
    mockOutputs = [];
    mockExecution = { execution_count: 3, submitted_by_actor_label: null };
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

    expect(footer).toHaveClass("min-h-4");
    expect(detail).not.toHaveClass("sr-only");
    expect(rule).not.toBeNull();
  });

  it("keeps focused idle footer language pinned to the same readout slot", () => {
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

    expect(status?.textContent).toBe("Python/ready");
    expect(status).toHaveClass("max-w-64");
    expect(status).toHaveClass("opacity-100");
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
    expect(footer?.textContent?.replace(/\s+/g, "")).toContain("Python/run4");
  });

  it("hides source reveal affordances in read-only mode while keeping visible outputs", () => {
    mockOutputs = [
      {
        output_type: "stream",
        name: "stdout",
        text: "visible output\n",
      },
    ];

    const { getByTestId, queryByTitle } = render(
      <CodeCell
        cell={makeCell({ metadata: { jupyter: { source_hidden: true } } })}
        readOnly
        onFocus={() => {}}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onToggleSourceHidden={() => {}}
      />,
    );

    expect(queryByTitle("Show input")).toBeNull();
    expect(getByTestId("output")).toBeTruthy();
  });

  it("hides output reveal affordances and the output row in read-only mode", () => {
    mockOutputs = [
      {
        output_type: "stream",
        name: "stdout",
        text: "hidden output\n",
      },
    ];

    const { queryByTestId, queryByTitle } = render(
      <CodeCell
        cell={makeCell({ metadata: { jupyter: { outputs_hidden: true } } })}
        readOnly
        onFocus={() => {}}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onToggleOutputsHidden={() => {}}
      />,
    );

    expect(queryByTitle("Show outputs")).toBeNull();
    expect(queryByTestId("output")).toBeNull();
  });

  it("omits fully hidden read-only cells when there is no runtime state to show", () => {
    mockOutputs = [];

    const { container, queryByTestId, queryByTitle } = render(
      <CodeCell
        cell={makeCell({
          metadata: { jupyter: { source_hidden: true, outputs_hidden: true } },
        })}
        readOnly
        onFocus={() => {}}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onToggleSourceHidden={() => {}}
        onToggleOutputsHidden={() => {}}
      />,
    );

    expect(container.firstChild).toBeNull();
    expect(queryByTitle("Show cell")).toBeNull();
    expect(queryByTestId("execute-button")).toBeNull();
  });

  it("omits fully hidden read-only cells after execution", () => {
    mockOutputs = [];
    mockExecution = { execution_count: 8, submitted_by_actor_label: null };

    const { container, queryByTestId, queryByTitle } = render(
      <CodeCell
        cell={makeCell({
          metadata: { jupyter: { source_hidden: true, outputs_hidden: true } },
        })}
        readOnly
        onFocus={() => {}}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onToggleSourceHidden={() => {}}
        onToggleOutputsHidden={() => {}}
      />,
    );

    expect(container.firstChild).toBeNull();
    expect(queryByTitle("Show cell")).toBeNull();
    expect(queryByTestId("execute-button")).toBeNull();
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

  it("marks hidden-cell disclosure as the fallback focus target", () => {
    mockOutputs = [];
    const { getByTitle } = render(
      <CodeCell
        cell={makeCell({
          metadata: { jupyter: { source_hidden: true, outputs_hidden: true } },
        })}
        onFocus={() => {}}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onDelete={() => {}}
        onToggleSourceHidden={() => {}}
        onToggleOutputsHidden={() => {}}
      />,
    );

    expect(getByTitle("Show cell").hasAttribute("data-cell-focus-target")).toBe(true);
  });

  it("lets arrow keys leave a focused hidden group", () => {
    mockOutputs = [];
    const onFocusPrevious = vi.fn();
    const onFocusNext = vi.fn();

    const { getByTitle } = render(
      <CodeCell
        cell={makeCell({
          metadata: { jupyter: { source_hidden: true, outputs_hidden: true } },
        })}
        hiddenGroupCount={3}
        hiddenGroupItems={[
          { id: "code-1", preview: "first()", outputCount: 0, hasError: false },
          { id: "code-2", preview: "second()", outputCount: 1, hasError: false },
          { id: "code-3", preview: "third()", outputCount: 0, hasError: false },
        ]}
        onFocus={() => {}}
        onFocusPrevious={onFocusPrevious}
        onFocusNext={onFocusNext}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onDelete={() => {}}
        onToggleSourceHidden={() => {}}
        onToggleOutputsHidden={() => {}}
      />,
    );

    const disclosure = getByTitle("Show all 3 hidden cells");
    fireEvent.keyDown(disclosure, { key: "ArrowDown" });
    fireEvent.keyDown(disclosure, { key: "ArrowUp" });

    expect(onFocusNext).toHaveBeenCalledWith("start");
    expect(onFocusPrevious).toHaveBeenCalledWith("end");
  });

  it("does not navigate away from hidden group preview rows with arrow keys", () => {
    mockOutputs = [];
    const onFocusNext = vi.fn();
    const onExpandHiddenGroupCell = vi.fn();

    const { getByTitle } = render(
      <CodeCell
        cell={makeCell({
          metadata: { jupyter: { source_hidden: true, outputs_hidden: true } },
        })}
        hiddenGroupCount={3}
        hiddenGroupItems={[
          { id: "code-1", preview: "first()", outputCount: 0, hasError: false },
          { id: "code-2", preview: "second()", outputCount: 1, hasError: false },
          { id: "code-3", preview: "third()", outputCount: 0, hasError: false },
        ]}
        onExpandHiddenGroupCell={onExpandHiddenGroupCell}
        onFocus={() => {}}
        onFocusNext={onFocusNext}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onDelete={() => {}}
        onToggleSourceHidden={() => {}}
        onToggleOutputsHidden={() => {}}
      />,
    );

    fireEvent.keyDown(getByTitle("Show hidden cell 2: second()"), { key: "ArrowDown" });

    expect(onFocusNext).not.toHaveBeenCalled();
  });
});
