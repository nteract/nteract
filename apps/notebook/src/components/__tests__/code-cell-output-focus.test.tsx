// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CodeCell as CodeCellType } from "../../types";

let mockOutputs: unknown[] = [];
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

vi.mock("@/components/cell/CompactExecutionButton", () => ({
  CompactExecutionButton: () => null,
}));

vi.mock("@/components/cell/OutputArea", () => ({
  anyOutputNeedsIsolation: () => true,
  OutputArea: ({
    focused,
    onIframeMouseDown,
  }: {
    focused?: boolean;
    onIframeMouseDown?: () => void;
  }) => (
    <button
      data-focused={String(focused)}
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
  useIsCellExecuting: () => false,
  useIsCellFocused: () => false,
  useIsCellQueued: () => false,
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
  useCellExecutionId: () => null,
  useExecution: () => null,
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

function makeCell(): CodeCellType {
  return {
    cell_type: "code",
    execution_count: null,
    id: "code-1",
    source: "import polars as pl\n\npl.DataFrame({'x': [1]})",
    metadata: {},
    outputs: [],
  };
}

describe("CodeCell output focus", () => {
  beforeEach(() => {
    mockOutputs = [
      {
        output_type: "display_data",
        data: { "application/vnd.apache.parquet": "blob://df" },
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
      />,
    );

    expect(getByTestId("output").getAttribute("data-focused")).toBe("true");
  });

  it("requests output focus from the gutter focus button", () => {
    const onOutputFocusChange = vi.fn();
    const { getByTitle } = render(
      <CodeCell
        cell={makeCell()}
        onFocus={() => {}}
        onOutputFocusChange={onOutputFocusChange}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onDelete={() => {}}
      />,
    );

    fireEvent.click(getByTitle("Focus output"));

    expect(onOutputFocusChange).toHaveBeenCalledWith(true);
  });

  it("keeps the expand button active but inert while output-focused", () => {
    const onFocus = vi.fn();
    const { getByTitle } = render(
      <CodeCell
        cell={makeCell()}
        outputFocused
        onFocus={onFocus}
        onExecute={() => {}}
        onInterrupt={() => {}}
        onDelete={() => {}}
      />,
    );

    fireEvent.click(getByTitle("Constrain output height"));

    expect(onFocus).not.toHaveBeenCalled();
  });
});
